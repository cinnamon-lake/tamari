import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TestHarness } from '../testing/TestHarness.js';
import { createPersonasRouter } from './personas.js';

const minimalPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const AVATAR_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

function createApp(harness: TestHarness) {
  const app = express();
  app.use(
    '/personas',
    createPersonasRouter(harness.deps.personas, harness.deps.storage, harness.bus, AVATAR_MAX_FILE_SIZE_BYTES),
  );
  return app;
}

describe('createPersonasRouter', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    app = createApp(h);
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('uploads an avatar, updates the persona, and broadcasts via the personaAvatar service', async () => {
    const persona = await h.deps.personas.create(crypto.randomUUID(), { name: 'Avatar Persona' });
    const broadcast = vi.spyOn(h.bus, 'broadcast');

    const res = await request(app)
      .post(`/personas/${persona.id}/avatar`)
      .attach('avatar', minimalPng, 'avatar.png')
      .expect(200);

    expect(res.body).toEqual({ success: true });

    const updated = await h.deps.personas.getById(persona.id);
    expect(updated?.avatarPath).toBeTruthy();
    expect(updated?.avatarThumbnailPath).toBeTruthy();
    expect(h.deps.storage.exists(updated!.avatarPath!)).toBe(true);
    expect(h.deps.storage.exists(updated!.avatarThumbnailPath!)).toBe(true);

    const types = broadcast.mock.calls.map(([msg]) => msg.type);
    expect(types).toContain('persona.updated');
    expect(types).toContain('persona.snapshot');
    expect(types).toContain('persona.listed');
  });

  it('returns 404 for a missing persona', async () => {
    const broadcast = vi.spyOn(h.bus, 'broadcast');

    await request(app)
      .post('/personas/nonexistent/avatar')
      .attach('avatar', minimalPng, 'avatar.png')
      .expect(404);

    expect(broadcast).not.toHaveBeenCalled();
  });

  it('returns 400 when no file is sent', async () => {
    const persona = await h.deps.personas.create(crypto.randomUUID(), { name: 'No File Persona' });
    await request(app).post(`/personas/${persona.id}/avatar`).expect(400);
  });

  it('rejects a MIME type outside the allowlist with 400', async () => {
    const persona = await h.deps.personas.create(crypto.randomUUID(), { name: 'Bad MIME Persona' });
    const broadcast = vi.spyOn(h.bus, 'broadcast');

    const res = await request(app)
      .post(`/personas/${persona.id}/avatar`)
      .attach('avatar', Buffer.from('plain text'), 'notes.txt')
      .expect(400);

    expect(res.body.error).toContain('Unsupported file type: text/plain');

    const unchanged = await h.deps.personas.getById(persona.id);
    expect(unchanged?.avatarPath).toBeFalsy();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
