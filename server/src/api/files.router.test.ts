import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { TestHarness } from '../testing/TestHarness.js';
import { createFilesRouter } from './files.js';

const minimalPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const allowAuth: RequestHandler = (_req, _res, next) => next();
const denyAuth: RequestHandler = (_req, res) => {
  res.status(401).json({ error: 'Unauthorized' });
};

function createApp(harness: TestHarness, requireAuth: RequestHandler) {
  const app = express();
  app.use('/files', createFilesRouter(harness.deps.storage, requireAuth));
  return app;
}

describe('createFilesRouter', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('serves an existing avatar file with caching headers when auth passes', async () => {
    h.deps.storage.write('avatars', 'pic.png', new Uint8Array(minimalPng));

    await request(createApp(h, allowAuth))
      .get('/files/avatars/pic.png')
      .expect(200)
      .expect('Content-Type', 'image/png')
      .expect('Cache-Control', 'public, max-age=31536000, immutable');
  });

  it('rejects unauthenticated requests before touching the filesystem', async () => {
    h.deps.storage.write('avatars', 'pic.png', new Uint8Array(minimalPng));

    const res = await request(createApp(h, denyAuth)).get('/files/avatars/pic.png').expect(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 404 for a well-formed but missing file', async () => {
    await request(createApp(h, allowAuth)).get('/files/personas/nope.png').expect(404);
  });

  describe('path traversal guard', () => {
    // NOTE: a bare '..' / '%2E%2E' segment is normalized away by the HTTP client
    // before Express sees it (404); these cases exercise the router-side guard.
    it.each([
      '..%2Fsecret.png',
      '%2E%2E%2F%2E%2E%2Fsecret.png',
      'sub%2Fsecret.png',
      '%2Fetc%2Fpasswd',
    ])('rejects %s with 400', async (fileName) => {
      const res = await request(createApp(h, allowAuth))
        .get(`/files/avatars/${fileName}`)
        .expect(400);
      expect(res.body.error).toBe('Invalid file name');
    });
  });
});
