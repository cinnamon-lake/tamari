/**
 * Generation-action handler tests — the happy-path generation flows are covered
 * by e2e/tests/server/e2e-chat-lifecycle.test.ts and e2e-dispatcher-core.test.ts
 * (send/generate/regenerate/continue/impersonate/stop). Here: the dispatcher's
 * generation rate limiter (dispatcher.ts GENERATION_ACTIONS guard, otherwise
 * untested) and the action.stop unknown-generation no-op.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness, type TestClient } from '../testing/TestHarness.js';

describe('generation handlers', () => {
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

  const errorsOf = (c: TestClient, code: string) => c.messages.filter((m) => m.type === 'error' && m.code === code);

  describe('generation rate limiter', () => {
    it('allows 20 generation actions per minute, then replies RATE_LIMITED', async () => {
      // A missing chatId keeps each call cheap: the handler throws
      // ValidationError('Chat not found') after passing the limiter.
      for (let i = 0; i < 20; i++) {
        await h.send(client, { type: 'action.generate', chatId: 'no-such-chat' });
      }
      expect(errorsOf(client, 'VALIDATION_ERROR')).toHaveLength(20);
      expect(errorsOf(client, 'RATE_LIMITED')).toHaveLength(0);

      await h.send(client, { type: 'action.generate', chatId: 'no-such-chat' });
      const limited = errorsOf(client, 'RATE_LIMITED');
      expect(limited).toHaveLength(1);
      expect(limited[0]!.type === 'error' && limited[0]!.message).toContain('Rate limit');
      // The blocked call never reaches the handler — no extra VALIDATION_ERROR.
      expect(errorsOf(client, 'VALIDATION_ERROR')).toHaveLength(20);
    });

    it('shares one budget across all generation action types', async () => {
      for (let i = 0; i < 10; i++) {
        await h.send(client, { type: 'action.generate', chatId: 'no-such-chat' });
        await h.send(client, { type: 'action.continue', chatId: 'no-such-chat' });
      }
      expect(errorsOf(client, 'RATE_LIMITED')).toHaveLength(0);
      // 21st generation action — of a different type — is still limited.
      await h.send(client, { type: 'action.impersonate', chatId: 'no-such-chat' });
      expect(errorsOf(client, 'RATE_LIMITED')).toHaveLength(1);
    });

    it('tracks limits per client, not globally', async () => {
      const other = h.connectClient();
      for (let i = 0; i < 20; i++) {
        await h.send(client, { type: 'action.generate', chatId: 'no-such-chat' });
      }
      await h.send(client, { type: 'action.generate', chatId: 'no-such-chat' });
      expect(errorsOf(client, 'RATE_LIMITED')).toHaveLength(1);

      // A different client still has its full budget.
      await h.send(other, { type: 'action.generate', chatId: 'no-such-chat' });
      expect(errorsOf(other, 'RATE_LIMITED')).toHaveLength(0);
      expect(errorsOf(other, 'VALIDATION_ERROR')).toHaveLength(1);
    });

    it('does not count non-generation actions against the budget', async () => {
      const chatId = crypto.randomUUID();
      await h.deps.chats.createChat(chatId, {
        characterId: null,
        personaId: null,
        name: 'Chat',
        headMessageId: null,
        metadata: {},
      });
      // action.send is not in GENERATION_ACTIONS — 25 of them must not trip it.
      for (let i = 0; i < 25; i++) {
        await h.send(client, { type: 'action.send', chatId, content: `m${i}` });
      }
      expect(errorsOf(client, 'RATE_LIMITED')).toHaveLength(0);
    });
  });

  describe('action.stop', () => {
    it('is a no-op for an unknown generationId', async () => {
      await h.send(client, { type: 'action.stop', generationId: 'no-such-generation' });
      expect(client.messages.find((m) => m.type === 'error')).toBeUndefined();
    });
  });
});
