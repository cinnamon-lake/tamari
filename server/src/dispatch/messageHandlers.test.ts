/**
 * action.* message-surgery handler tests — ONLY the paths not already covered
 * by e2e/tests/server/e2e-chat-features.test.ts and e2e-chat-lifecycle.test.ts
 * (happy-path edit, per-part edit, non-text-part rejection, last-text-part
 * defaulting, hide/unhide, delete, cut, swipe, action.system are covered there).
 * Here: out-of-range partIndex, appending a text part when none exists,
 * delete on a missing chat, and hide/unhide on a missing message.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness, type TestClient } from '../testing/TestHarness.js';

describe('message handlers', () => {
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

  async function seedChatWithMessage(text = 'Hello') {
    const chatId = crypto.randomUUID();
    await h.deps.chats.createChat(chatId, {
      characterId: null,
      personaId: null,
      name: 'Chat',
      headMessageId: null,
      metadata: {},
    });
    const message = await h.deps.chats.appendMessage(chatId, {
      role: 'user',
      extra: { parts: [{ type: 'text', text }] },
    });
    return { chatId, message };
  }

  const lastError = () => [...client.messages].reverse().find((m) => m.type === 'error');

  describe('action.edit', () => {
    it('rejects an out-of-range partIndex instead of editing the wrong part', async () => {
      const { chatId, message } = await seedChatWithMessage();
      await h.send(client, {
        type: 'action.edit',
        chatId,
        messageId: message.id,
        content: 'nope',
        partIndex: 7,
      });

      const err = lastError();
      expect(err).toMatchObject({ type: 'error', code: 'BAD_REQUEST' });
      expect(err!.type === 'error' && err!.message).toContain('out of range');
      // The original text part is untouched.
      const after = await h.deps.chats.getMessageById(message.id);
      expect(after!.extra.parts).toEqual([{ type: 'text', text: 'Hello' }]);
    });

    it('appends a text part when the message has none (legacy callers)', async () => {
      const chatId = crypto.randomUUID();
      await h.deps.chats.createChat(chatId, {
        characterId: null,
        personaId: null,
        name: 'Chat',
        headMessageId: null,
        metadata: {},
      });
      const message = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'reasoning', text: 'thinking...' }] },
      });

      await h.send(client, {
        type: 'action.edit',
        chatId,
        messageId: message.id,
        content: 'the answer',
      });

      const after = await h.deps.chats.getMessageById(message.id);
      expect(after!.extra.parts).toEqual([
        { type: 'reasoning', text: 'thinking...' },
        { type: 'text', text: 'the answer' },
      ]);
      expect(after!.extra.editedAt).toBeDefined();
    });

    it('updates tokenCount on the edited message', async () => {
      const { chatId, message } = await seedChatWithMessage('one two three');
      await h.send(client, {
        type: 'action.edit',
        chatId,
        messageId: message.id,
        content: 'a much longer replacement text with more tokens',
      });
      const after = await h.deps.chats.getMessageById(message.id);
      expect(typeof after!.extra.tokenCount).toBe('number');
      expect(after!.extra.tokenCount).toBeGreaterThan(0);
    });
  });

  describe('action.delete', () => {
    it('replies NOT_FOUND when the chat does not exist', async () => {
      await h.send(client, { type: 'action.delete', chatId: 'no-such-chat', messageId: 12345 });
      expect(lastError()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    });
  });

  describe('action.hide / action.unhide', () => {
    it('is a silent no-op for a missing message (no broadcast, no error)', async () => {
      const { chatId } = await seedChatWithMessage();
      client.messages.length = 0;
      await h.send(client, { type: 'action.hide', chatId, messageId: 999999 });
      await h.send(client, { type: 'action.unhide', chatId, messageId: 999999 });
      expect(client.messages).toEqual([]);
    });
  });
});
