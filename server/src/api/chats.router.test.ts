import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TestHarness } from '../testing/TestHarness.js';
import { createChatsRouter } from './chats.js';

function createApp(harness: TestHarness) {
  const app = express();
  app.use('/chats', createChatsRouter(harness.deps.chats));
  return app;
}

describe('createChatsRouter', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createApp>;
  let chatId: string;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    app = createApp(h);

    const character = await h.deps.characters.create(crypto.randomUUID(), { name: 'Export Char' });
    const persona = await h.deps.personas.create(crypto.randomUUID(), { name: 'Export Persona' });
    chatId = crypto.randomUUID();
    await h.deps.chats.createChat(chatId, {
      characterId: character.id,
      personaId: persona.id,
      name: 'Export Chat',
      headMessageId: null,
      metadata: {},
    });
    await h.deps.chats.appendMessage(chatId, {
      role: 'user',
      extra: { parts: [{ type: 'text', text: 'hello there' }] },
    });
    await h.deps.chats.appendMessage(chatId, {
      role: 'assistant',
      extra: { parts: [{ type: 'text', text: 'general kenobi' }] },
    });
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('exports the active branch as JSONL by default', async () => {
    const res = await request(app)
      .get(`/chats/${chatId}/export`)
      .expect(200)
      .expect('Content-Type', /application\/jsonl/)
      .expect('Content-Disposition', `attachment; filename="${chatId}.jsonl"`);

    const lines = res.text.split('\n');
    expect(lines).toHaveLength(2);
    const messages = lines.map((line) => JSON.parse(line));
    expect(messages[0].role).toBe('user');
    expect(messages[0].extra.parts).toEqual([{ type: 'text', text: 'hello there' }]);
    expect(messages[1].role).toBe('assistant');
  });

  it('exports the active branch as plain text with ?format=txt', async () => {
    const res = await request(app)
      .get(`/chats/${chatId}/export?format=txt`)
      .expect(200)
      .expect('Content-Type', /text\/plain/)
      .expect('Content-Disposition', `attachment; filename="${chatId}.txt"`);

    expect(res.text).toBe('user: hello there\n\nassistant: general kenobi');
  });

  it('exports an empty body for an unknown chat', async () => {
    const res = await request(app).get('/chats/no-such-chat/export').expect(200);
    expect(res.text).toBe('');
  });
});
