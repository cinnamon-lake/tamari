/**
 * worldinfo.* handler tests — happy-path CRUD, select/list/test, and entry
 * surgery are covered by e2e/tests/server/e2e-crud-operations.test.ts and
 * e2e-dispatcher-crud.test.ts. Here: the NOT_FOUND error paths and the
 * worldinfo.test activation-scan semantics (constant / disabled entries).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClientMessage, ServerMessage } from '@tamari/types';
import { TestHarness, type TestClient } from '../testing/TestHarness.js';

type TestedMessage = Extract<ServerMessage, { type: 'worldinfo.tested' }>;

function entry(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    keys: [],
    content: '',
    comment: '',
    order: 0,
    position: 'before_char',
    probability: 100,
    constant: false,
    selective: false,
    secondaryKeys: [],
    addMemo: false,
    disable: false,
    regex: false,
    recursive: false,
    ...overrides,
  };
}

describe('worldinfo handlers', () => {
  let h: TestHarness;
  let client: TestClient;

  const lastError = () => [...client.messages].reverse().find((m) => m.type === 'error');

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  describe('NOT_FOUND paths', () => {
    it('worldinfo.select on a missing book replies NOT_FOUND', async () => {
      await h.send(client, { type: 'worldinfo.select', bookId: 'no-such-book' } as ClientMessage);
      expect(lastError()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
      expect(client.messages.find((m) => m.type === 'worldinfo.snapshot')).toBeUndefined();
    });

    it('worldinfo.entry.create on a missing book replies NOT_FOUND', async () => {
      await h.send(client, {
        type: 'worldinfo.entry.create',
        bookId: 'no-such-book',
        data: entry({ keys: ['k'], content: 'c' }),
      } as ClientMessage);
      expect(lastError()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    });

    it('worldinfo.entry.update on a missing book replies NOT_FOUND', async () => {
      await h.send(client, {
        type: 'worldinfo.entry.update',
        bookId: 'no-such-book',
        entryId: 'no-such-entry',
        patch: { content: 'x' },
      } as ClientMessage);
      expect(lastError()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    });

    it('worldinfo.entry.delete on a missing book replies NOT_FOUND', async () => {
      await h.send(client, {
        type: 'worldinfo.entry.delete',
        bookId: 'no-such-book',
        entryId: 'no-such-entry',
      } as ClientMessage);
      expect(lastError()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    });
  });

  describe('worldinfo.create / worldinfo.update broadcast shape', () => {
    it('assigns ids to entries supplied without them and fans out created+snapshot+listed', async () => {
      await h.send(client, {
        type: 'worldinfo.create',
        data: { name: 'Book', entries: [entry({ keys: ['a'], content: 'A' })] },
      } as ClientMessage);

      const created = h.expectBroadcast('worldinfo.created');
      expect(created.clientId).toBe(client.connection.id);
      expect(created.book.entries).toHaveLength(1);
      expect(created.book.entries[0]!.id).toBeTruthy();

      const snapshot = h.expectBroadcast('worldinfo.snapshot');
      expect(snapshot.book.id).toBe(created.book.id);
      const listed = h.expectBroadcast('worldinfo.listed');
      expect(listed.books.some((b) => b.id === created.book.id)).toBe(true);
    });
  });

  describe('worldinfo.test activation scan', () => {
    async function runTest(entries: ReturnType<typeof entry>[], text: string) {
      await h.send(client, { type: 'worldinfo.test', entries, text } as unknown as ClientMessage);
      const tested = [...client.messages].reverse().find((m) => m.type === 'worldinfo.tested') as
        TestedMessage | undefined;
      expect(tested).toBeDefined();
      return tested!;
    }

    it('activates constant entries without any keyword match', async () => {
      const tested = await runTest([entry({ content: 'always on', constant: true })], 'no keywords here');
      expect(tested.activated.map((a) => a.entry.content)).toContain('always on');
    });

    it('does not activate disabled entries even when the keyword matches', async () => {
      const tested = await runTest(
        [entry({ keys: ['magic'], content: 'should stay off', disable: true })],
        'I cast magic.',
      );
      expect(tested.activated).toEqual([]);
    });

    it('activates a keyword entry only when a key appears in the text', async () => {
      const entries = [entry({ keys: ['dragon'], content: 'lore about dragons' })];
      const miss = await runTest(entries, 'a quiet tavern');
      expect(miss.activated).toEqual([]);
      const hit = await runTest(entries, 'a dragon appears');
      expect(hit.activated.map((a) => a.entry.content)).toContain('lore about dragons');
    });
  });
});
