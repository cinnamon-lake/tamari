import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TestHarness } from '../testing/TestHarness.js';
import { createAttachmentDownloadRouter, createAttachmentsRouter } from './attachments.js';

const minimalPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function binaryParser(res: any, callback: (err: any, body: Buffer) => void) {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk: string) => {
    data += chunk;
  });
  res.on('end', () => {
    callback(null, Buffer.from(data, 'binary'));
  });
}

/** Download router only — mounted without any auth middleware, as in main.ts. */
function createDownloadApp(harness: TestHarness) {
  const app = express();
  app.use('/api/attachments', createAttachmentDownloadRouter(harness.deps.attachments, harness.deps.storage));
  return app;
}

/** Upload router (JSON body) mounted after auth in production. */
function createUploadApp(harness: TestHarness) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/attachments',
    createAttachmentsRouter(harness.deps.attachments, harness.deps.storage, harness.bus),
  );
  return app;
}

async function seedAttachment(h: TestHarness, mimeType: string) {
  const id = crypto.randomUUID();
  const filePath = h.deps.storage.write('attachments', id, new Uint8Array(minimalPng));
  return h.deps.attachments.create({ id, messageId: null, mimeType, filePath, meta: {} });
}

describe('createAttachmentDownloadRouter', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createDownloadApp>;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    app = createDownloadApp(h);
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('serves an attachment without any auth (mounted before the auth middleware)', async () => {
    const attachment = await seedAttachment(h, 'image/png');

    const res = await request(app)
      .get(`/api/attachments/${attachment.id}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200)
      .expect('Content-Type', 'image/png');

    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body).toEqual(minimalPng);
  });

  it('forces download for non-inline-safe MIME types', async () => {
    const attachment = await seedAttachment(h, 'text/plain');

    await request(app)
      .get(`/api/attachments/${attachment.id}`)
      .expect(200)
      .expect('Content-Type', 'text/plain')
      .expect('Content-Disposition', 'attachment');
  });

  it('returns 404 for a missing attachment', async () => {
    const res = await request(app).get('/api/attachments/does-not-exist').expect(404);
    expect(res.body.error).toBe('Not found');
  });
});

describe('createAttachmentsRouter', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createUploadApp>;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    app = createUploadApp(h);
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('uploads an attachment and broadcasts attachment.created', async () => {
    const broadcast = vi.spyOn(h.bus, 'broadcast');

    const res = await request(app)
      .post('/api/attachments')
      .send({ mimeType: 'image/png', data: minimalPng.toString('base64'), meta: { label: 'test' } })
      .expect(200);

    expect(res.body.id).toBeTruthy();
    expect(res.body.mimeType).toBe('image/png');
    expect(res.body.meta).toEqual({ label: 'test' });

    const stored = await h.deps.attachments.getById(res.body.id);
    expect(stored).toBeDefined();
    expect(h.deps.storage.exists(stored!.filePath)).toBe(true);

    expect(broadcast).toHaveBeenCalledWith({ type: 'attachment.created', attachment: stored });
  });

  it('rejects a disallowed MIME type (XSS vector) with 400', async () => {
    const broadcast = vi.spyOn(h.bus, 'broadcast');

    const res = await request(app)
      .post('/api/attachments')
      .send({ mimeType: 'text/html', data: Buffer.from('<script>x</script>').toString('base64') })
      .expect(400);

    expect(res.body.error).toBe('Unsupported MIME type: text/html');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects a malformed body with 400 and broadcasts nothing', async () => {
    const broadcast = vi.spyOn(h.bus, 'broadcast');

    const res = await request(app)
      .post('/api/attachments')
      .send({ mimeType: 'not-a-mime', data: '' })
      .expect(400);

    expect(res.body.error).toBe('Invalid request body');
    expect(broadcast).not.toHaveBeenCalled();
  });
});
