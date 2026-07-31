import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TestHarness } from '../testing/TestHarness.js';
import { GenerationRepository } from '../repos/GenerationRepository.js';
import type { GenerationInsert } from '@tamari/types';
import { createChatsRouter } from './chats.js';

function createApp(harness: TestHarness) {
  const app = express();
  app.use('/chats', createChatsRouter(harness.deps.chats, new GenerationRepository(harness.db)));
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

  describe('GET /:id/generations', () => {
    function makeInsert(overrides?: Partial<Omit<GenerationInsert, 'id'>>): Omit<GenerationInsert, 'id'> {
      return {
        chatId,
        messageId: null,
        status: 'complete',
        backend: 'trivial',
        promptTokens: 10,
        completionTokens: 5,
        errorMessage: null,
        ...overrides,
      };
    }

    it('returns the chat’s generations newest-first with meta, scoped to the chat', async () => {
      const generations = new GenerationRepository(h.db);
      const parent = await generations.create('gen-parent', makeInsert({ kind: 'send' }));
      await generations.create(
        'gen-child',
        makeInsert({
          kind: 'subagent',
          parentId: parent.id,
          meta: { layer: 'trivial', depth: 1, rounds: 2, toolCalls: [{ name: 'echo_marker' }] },
        }),
      );
      // Another chat's record must not leak in.
      await h.deps.chats.createChat('other-chat', {
        characterId: null,
        personaId: null,
        name: 'Other Chat',
        headMessageId: null,
        metadata: {},
      });
      await generations.create('gen-other', makeInsert({ chatId: 'other-chat' }));

      // Newest first (created_at DESC): backdate the parent so the order is
      // deterministic — same-second ties break on the random id.
      await h.db.execute({ sql: 'UPDATE generations SET created_at = created_at - 60 WHERE id = ?', args: ['gen-parent'] });

      const res = await request(app).get(`/chats/${chatId}/generations`).expect(200);
      const items = res.body.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      // Newest first: the child was created after the parent.
      expect(items[0]!['id']).toBe('gen-child');
      expect(items[1]!['id']).toBe('gen-parent');
      expect(items[0]!['kind']).toBe('subagent');
      expect(items[0]!['parentId']).toBe(parent.id);
      expect((items[0]!['meta'] as Record<string, unknown>)['depth']).toBe(1);
      expect(res.body.total).toBe(2);
    });

    it('caps the list at 50 records', async () => {
      const generations = new GenerationRepository(h.db);
      for (let i = 0; i < 55; i++) {
        await generations.create(`gen-cap-${i}`, makeInsert());
      }
      const res = await request(app).get(`/chats/${chatId}/generations`).expect(200);
      expect((res.body.items as unknown[]).length).toBe(50);
      expect(res.body.total).toBe(55);
    });

    it('404s for an unknown chat', async () => {
      await request(app).get('/chats/no-such-chat/generations').expect(404);
    });
  });
});
