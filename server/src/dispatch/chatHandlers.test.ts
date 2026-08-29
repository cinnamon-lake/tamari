/**
 * chat.* handler tests — focuses on behaviors not already covered by the
 * e2e/tests/server bus-level suites (e2e-dispatcher-core covers
 * chat.create/select/fork happy paths; e2e-chat-lifecycle covers
 * chat.update metadata, reset, forks, delete). Here: chat.load rendering and
 * pagination, error paths, persona fallback, list-convergence broadcasts,
 * and originator clientId tagging.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness, type TestClient } from '../testing/TestHarness.js';
import type { ServerMessage } from '@tamari/types';

type MessagesLoaded = Extract<ServerMessage, { type: 'messages.loaded' }>;

describe('chat handlers', () => {
  let h: TestHarness;
  let client: TestClient;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function seedChat(name = 'Chat') {
    const chatId = crypto.randomUUID();
    const chat = await h.deps.chats.createChat(chatId, {
      characterId: null,
      personaId: null,
      name,
      headMessageId: null,
      metadata: {},
    });
    return chat;
  }

  const lastToClient = <T extends ServerMessage['type']>(type: T) =>
    [...client.messages].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;

  describe('chat.load', () => {
    it('replies with messages.loaded carrying renderedHtml for rendered roles', async () => {
      const chat = await seedChat();
      // Only user messages advance head_message_id; assistant replies become the
      // active child under it — so append user→assistant→user to get a 3-deep trunk.
      await h.deps.chats.appendMessage(chat.id, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'Hello there' }] },
      });
      await h.deps.chats.appendMessage(chat.id, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'General Kenobi' }] },
      });
      await h.deps.chats.appendMessage(chat.id, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'Second turn' }] },
      });

      await h.send(client, { type: 'chat.load', chatId: chat.id });

      const loaded = lastToClient('messages.loaded') as MessagesLoaded;
      expect(loaded).toBeDefined();
      expect(loaded.chatId).toBe(chat.id);
      expect(loaded.messages).toHaveLength(3);
      // Non-tool messages get a per-part renderedHtml array attached.
      for (const m of loaded.messages) {
        const rendered = (m as { renderedHtml?: unknown }).renderedHtml;
        expect(Array.isArray(rendered)).toBe(true);
        expect((rendered as unknown[]).length).toBe(m.extra.parts?.length ?? 0);
      }
      const texts = loaded.messages.map((m) =>
        (m.extra.parts ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join(''),
      );
      expect(texts).toContain('Hello there');
      expect(texts).toContain('General Kenobi');
    });

    it('passes tool-role messages through without rendering', async () => {
      const chat = await seedChat();
      await h.deps.chats.appendMessage(chat.id, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'before' }] },
      });
      await h.deps.chats.appendMessage(chat.id, {
        role: 'tool',
        extra: { parts: [{ type: 'text', text: '{"ok":true}' }] },
      });
      // A trailing user message pulls the tool message into the trunk (see above).
      await h.deps.chats.appendMessage(chat.id, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'after' }] },
      });

      await h.send(client, { type: 'chat.load', chatId: chat.id });

      const loaded = lastToClient('messages.loaded') as MessagesLoaded;
      expect(loaded.messages).toHaveLength(3);
      const tool = loaded.messages.find((m) => m.role === 'tool');
      expect(tool).toBeDefined();
      expect((tool as { renderedHtml?: unknown }).renderedHtml).toBeUndefined();
    });

    it('honors limit and offset for pagination', async () => {
      const chat = await seedChat();
      for (let i = 0; i < 5; i++) {
        await h.deps.chats.appendMessage(chat.id, {
          role: 'user',
          extra: { parts: [{ type: 'text', text: `m${i}` }] },
        });
      }

      await h.send(client, { type: 'chat.load', chatId: chat.id, limit: 2 });
      const page1 = lastToClient('messages.loaded') as MessagesLoaded;
      expect(page1.messages).toHaveLength(2);

      await h.send(client, { type: 'chat.load', chatId: chat.id, limit: 2, offset: 4 });
      const page3 = lastToClient('messages.loaded') as MessagesLoaded;
      expect(page3.messages).toHaveLength(1);
    });

    it('replies with an empty list for an unknown chat (no error)', async () => {
      await h.send(client, { type: 'chat.load', chatId: 'no-such-chat' });
      const loaded = lastToClient('messages.loaded') as MessagesLoaded;
      expect(loaded).toBeDefined();
      expect(loaded.messages).toEqual([]);
      expect(client.messages.find((m) => m.type === 'error')).toBeUndefined();
    });
  });

  describe('chat.select', () => {
    it('rejects an unknown chat with NOT_FOUND', async () => {
      await h.send(client, { type: 'chat.select', chatId: 'no-such-chat' });
      const err = client.messages.find((m) => m.type === 'error');
      expect(err).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    });

    it('persists lastChatId and broadcasts settings.changed tagged with the originator', async () => {
      const chat = await seedChat();
      await h.send(client, { type: 'chat.select', chatId: chat.id });

      expect(await h.deps.settings.get('lastChatId')).toBe(chat.id);
      const changed = h.expectBroadcast('settings.changed');
      expect(changed).toMatchObject({ key: 'lastChatId', value: chat.id, clientId: client.connection.id });
    });
  });

  describe('chat.create', () => {
    it('tags chat.created/chat.listed with the originator clientId and reconverges the list', async () => {
      await h.send(client, { type: 'chat.create', data: { name: 'Fresh Chat', characterId: null } });

      const created = h.expectBroadcast('chat.created');
      expect(created.clientId).toBe(client.connection.id);
      const listed = h.expectBroadcast('chat.listed');
      expect(listed.clientId).toBe(client.connection.id);
      expect(listed.chats.some((c) => c.id === created.chat.id)).toBe(true);
      expect(listed.total).toBe(1);
    });

    it('falls back to the first persona when personaId is omitted', async () => {
      const persona = await h.deps.personas.create(crypto.randomUUID(), {
        name: 'Fallback Persona',
        description: '',
      });
      await h.send(client, { type: 'chat.create', data: { name: 'With Persona', characterId: null } });
      const created = h.expectBroadcast('chat.created');
      expect(created.chat.personaId).toBe(persona.id);
    });

    it('leaves personaId null when no persona exists', async () => {
      await h.send(client, { type: 'chat.create', data: { name: 'No Persona', characterId: null } });
      const created = h.expectBroadcast('chat.created');
      expect(created.chat.personaId).toBeNull();
    });
  });

  describe('chat.delete', () => {
    it('broadcasts chat.deleted plus a reconverged chat.listed', async () => {
      const chat = await seedChat('Doomed');
      client.messages.length = 0;

      await h.send(client, { type: 'chat.delete', chatId: chat.id });

      const deleted = h.expectBroadcast('chat.deleted');
      expect(deleted.chatId).toBe(chat.id);
      const listed = h.expectBroadcast('chat.listed');
      expect(listed.chats.some((c) => c.id === chat.id)).toBe(false);
      expect(await h.deps.chats.getChatById(chat.id)).toBeUndefined();
    });
  });

  describe('chat.update', () => {
    it('rebroadcasts a chat.snapshot when the patch binds a character', async () => {
      const character = await h.deps.characters.create(crypto.randomUUID(), {
        name: 'Bound Char',
      });
      const chat = await seedChat('Bindable');
      client.messages.length = 0;

      await h.send(client, {
        type: 'chat.update',
        chatId: chat.id,
        patch: { characterId: character.id },
      });

      h.expectBroadcast('chat.updated');
      // Structural entity change must refresh chatCharacter on clients.
      const snapshot = client.messages.find((m) => m.type === 'chat.snapshot');
      expect(snapshot).toBeDefined();
    });
  });
});
