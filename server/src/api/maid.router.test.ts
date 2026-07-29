import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TestHarness } from '../testing/TestHarness.js';
import type { DataMaid } from '../services/DataMaid.js';
import { createMaidRouter } from './maid.js';

const fakeReport = {
  sql: { orphanMessages: 2, orphanChats: 1 },
  files: { orphanFiles: ['avatars/stale.png'] },
};

function createDataMaid(overrides?: Partial<{ scanError: Error; cleanError: Error }>) {
  const scan = overrides?.scanError
    ? vi.fn().mockRejectedValue(overrides.scanError)
    : vi.fn().mockResolvedValue(fakeReport);
  const clean = overrides?.cleanError
    ? vi.fn().mockRejectedValue(overrides.cleanError)
    : vi.fn().mockResolvedValue({ deletedSql: 3, deletedFiles: 1 });
  return { scan, clean } as unknown as DataMaid;
}

function createApp(harness: TestHarness, dataMaid: DataMaid) {
  const app = express();
  app.use('/maid', createMaidRouter(dataMaid, harness.deps.chats, harness.bus));
  return app;
}

describe('createMaidRouter', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('GET /scan returns the data maid report', async () => {
    const dataMaid = createDataMaid();

    const res = await request(createApp(h, dataMaid)).get('/maid/scan').expect(200);

    expect(res.body).toEqual(fakeReport);
    expect(dataMaid.scan).toHaveBeenCalledOnce();
  });

  it('POST /clean runs the cleanup and rebroadcasts chat.listed', async () => {
    const character = await h.deps.characters.create(crypto.randomUUID(), { name: 'Maid Char' });
    const chat = await h.deps.chats.createChat(crypto.randomUUID(), {
      characterId: character.id,
      personaId: null,
      name: 'Kept Chat',
      headMessageId: null,
      metadata: {},
    });
    const dataMaid = createDataMaid();
    const broadcast = vi.spyOn(h.bus, 'broadcast');

    const res = await request(createApp(h, dataMaid)).post('/maid/clean').expect(200);

    expect(res.body).toMatchObject({ ok: true, deletedSql: 3, deletedFiles: 1, report: fakeReport });
    expect(dataMaid.clean).toHaveBeenCalledWith(fakeReport);

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.listed',
        chats: expect.arrayContaining([expect.objectContaining({ id: chat.id })]),
      }),
    );
  });

  it('returns 500 when the scan fails', async () => {
    const dataMaid = createDataMaid({ scanError: new Error('db gone') });
    const broadcast = vi.spyOn(h.bus, 'broadcast');

    const res = await request(createApp(h, dataMaid)).get('/maid/scan').expect(500);

    expect(res.body.error).toBe('Scan failed');
    expect(broadcast).not.toHaveBeenCalled();
  });
});
