import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatRepository } from './ChatRepository.js';

let client: Client;
let repo: ChatRepository;
let tmpDir: string;

async function initSchema() {
  // Mirror the production `chats` / `messages` DDL (see db/migrations/001_init.sql).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      character_id TEXT,
      persona_id TEXT,
      name TEXT NOT NULL,
      head_message_id INTEGER,
      active_child_id INTEGER,
      materialized INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      metadata TEXT DEFAULT '{}',
      forked_from_chat_id TEXT,
      forked_at_message_id INTEGER
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER,
      role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      extra TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
  // Mirror db/migrations/014_message_parts.sql.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS message_parts (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (message_id, idx)
    )
  `);
  await client.execute('PRAGMA foreign_keys = ON');
}

/** Insert a message row and return its id. Real content lives in `extra`. */
async function insertMessage(
  parentId: number | null,
  role: 'user' | 'assistant' | 'system' | 'tool',
  extra: Record<string, unknown> = {},
): Promise<number> {
  const rs = await client.execute({
    sql: `INSERT INTO messages (parent_id, role, content, extra) VALUES (?, ?, ?, ?) RETURNING id`,
    args: [parentId, role, '', JSON.stringify(extra)],
  });
  return (rs.rows[0]?.id as number | undefined) ?? 0;
}

beforeAll(async () => {
  // File-based (not :memory:) so the transaction connection and the main
  // client connection share the same database. With :memory:, libsql's
  // connection pool gives each connection its own isolated in-memory DB,
  // which breaks hardFork's commit-then-query flow.
  tmpDir = mkdtempSync(join(tmpdir(), 'st-chatrepo-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  await initSchema();
  repo = new ChatRepository(client);
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM messages');
  await client.execute('DELETE FROM chats');
});

describe('ChatRepository.hardFork', () => {
  it('clones every swipe, not just the active child', async () => {
    // user -> assistant swipes [A1, A2, A3], A2 active
    const userId = await insertMessage(null, 'user', { text: 'hi' });
    await insertMessage(userId, 'assistant', { swipe: 1 });
    const a2 = await insertMessage(userId, 'assistant', { swipe: 2 });
    await insertMessage(userId, 'assistant', { swipe: 3 });
    await client.execute({
      sql: `INSERT INTO chats (id, name, head_message_id, active_child_id) VALUES (?, ?, ?, ?)`,
      args: ['chat-1', 'source', userId, a2],
    });

    const fork = await repo.hardFork('chat-1', a2, 'fork');

    // Head points at the cloned user message; active at the cloned A2.
    expect(fork.headMessageId).not.toBeNull();
    expect(fork.activeChildId).not.toBeNull();
    expect(fork.headMessageId).not.toBe(userId);
    expect(fork.activeChildId).not.toBe(a2);

    // All three swipes are reachable as children of the forked head.
    const swipes = await repo.getSiblings(fork.headMessageId);
    expect(swipes).toHaveLength(3);

    // The active child is the swipe that was active in the source (A2).
    const active = swipes.find((m) => m.id === fork.activeChildId);
    expect(active?.extra).toMatchObject({ swipe: 2 });

    // Every source swipe is represented in the fork (by content, not id).
    const forkSwipeTags = swipes.map((m) => (m.extra as { swipe?: number }).swipe).sort();
    expect(forkSwipeTags).toEqual([1, 2, 3]);
  });

  it('preserves the bulk chain (ancestors) up to the fork point', async () => {
    // user1 -> a1 -> user2 -> assistant swipes [A2a, A2b], A2a active
    const user1 = await insertMessage(null, 'user', { text: 'first' });
    const a1 = await insertMessage(user1, 'assistant', { text: 'reply1' });
    const user2 = await insertMessage(a1, 'user', { text: 'second' });
    const a2a = await insertMessage(user2, 'assistant', { swipe: 'a' });
    await insertMessage(user2, 'assistant', { swipe: 'b' });
    await client.execute({
      sql: `INSERT INTO chats (id, name, head_message_id, active_child_id) VALUES (?, ?, ?, ?)`,
      args: ['chat-1', 'source', user2, a2a],
    });

    const fork = await repo.hardFork('chat-1', a2a, 'fork');

    // Active branch = [user1, a1, user2] (bulk, newest-first reversed) + active swipe.
    const branch = await repo.getActiveBranch(fork.id);
    const roles = branch.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
    const activeTip = branch[branch.length - 1];
    expect(activeTip?.extra).toMatchObject({ swipe: 'a' });

    // Swipes at the fork point survived.
    const swipes = await repo.getSiblings(fork.headMessageId);
    expect(swipes).toHaveLength(2);
  });

  it('handles a single swipe (no siblings) without duplicating it', async () => {
    const userId = await insertMessage(null, 'user', { text: 'hi' });
    const only = await insertMessage(userId, 'assistant', { swipe: 1 });
    await client.execute({
      sql: `INSERT INTO chats (id, name, head_message_id, active_child_id) VALUES (?, ?, ?, ?)`,
      args: ['chat-1', 'source', userId, only],
    });

    const fork = await repo.hardFork('chat-1', only, 'fork');
    const swipes = await repo.getSiblings(fork.headMessageId);
    expect(swipes).toHaveLength(1);
    expect(swipes[0]!.id).toBe(fork.activeChildId);
  });

  it('does not mutate the source chat or its message tree', async () => {
    const userId = await insertMessage(null, 'user', { text: 'hi' });
    const a1 = await insertMessage(userId, 'assistant', { swipe: 1 });
    const a2 = await insertMessage(userId, 'assistant', { swipe: 2 });
    await client.execute({
      sql: `INSERT INTO chats (id, name, head_message_id, active_child_id) VALUES (?, ?, ?, ?)`,
      args: ['chat-1', 'source', userId, a2],
    });

    await repo.hardFork('chat-1', a2, 'fork');

    // Source pointers unchanged.
    const source = await repo.getChatById('chat-1');
    expect(source?.headMessageId).toBe(userId);
    expect(source?.activeChildId).toBe(a2);

    // Source swipes unchanged and still distinct from the fork's.
    const sourceSwipes = await repo.getSiblings(userId);
    expect(sourceSwipes).toHaveLength(2);
    expect(sourceSwipes.map((m) => m.id).sort()).toEqual([a1, a2].sort());
  });
});

describe('ChatRepository.softFork (swipe reachability parity)', () => {
  it('exposes all swipes via the shared message pool', async () => {
    const userId = await insertMessage(null, 'user', { text: 'hi' });
    await insertMessage(userId, 'assistant', { swipe: 1 });
    const a2 = await insertMessage(userId, 'assistant', { swipe: 2 });
    await insertMessage(userId, 'assistant', { swipe: 3 });
    await client.execute({
      sql: `INSERT INTO chats (id, name, head_message_id, active_child_id) VALUES (?, ?, ?, ?)`,
      args: ['chat-1', 'source', userId, a2],
    });

    const fork = await repo.softFork('chat-1', a2, 'soft');
    // Soft fork shares the tree: head == source user message.
    expect(fork.headMessageId).toBe(userId);
    const swipes = await repo.getSiblings(fork.headMessageId);
    expect(swipes).toHaveLength(3);
  });
});

describe('ChatRepository message parts storage', () => {
  const parts = [
    { type: 'text' as const, text: 'hello' },
    { type: 'reasoning' as const, text: 'hmm' },
    { type: 'text' as const, text: 'world' },
  ];

  it('stores parts in message_parts and returns them on insert', async () => {
    const msg = await repo.insertMessage({ role: 'assistant', extra: { tokenCount: 5, parts } });
    expect(msg.extra.parts).toEqual(parts);
    expect(msg.extra.tokenCount).toBe(5);
  });

  it('hydrates parts on getMessageById / getBulkOfMessages / getSiblings', async () => {
    const parent = await repo.insertMessage({ role: 'user', extra: { parts: [{ type: 'text', text: 'q' }] } });
    const reply = await repo.insertMessage({ parentId: parent.id, role: 'assistant', extra: { parts } });
    await client.execute({
      sql: `INSERT INTO chats (id, name, head_message_id, active_child_id) VALUES (?, ?, ?, ?)`,
      args: ['chat-parts', 't', parent.id, reply.id],
    });

    const byId = await repo.getMessageById(reply.id);
    expect(byId?.extra.parts).toEqual(parts);

    const branch = await repo.getActiveBranch('chat-parts');
    expect(branch.find((m) => m.id === reply.id)?.extra.parts).toEqual(parts);
    expect(branch.find((m) => m.id === parent.id)?.extra.parts).toEqual([{ type: 'text', text: 'q' }]);

    const siblings = await repo.getSiblings(parent.id);
    expect(siblings[0]?.extra.parts).toEqual(parts);
  });

  it('keeps parts out of the stored extra blob', async () => {
    const msg = await repo.insertMessage({ role: 'assistant', extra: { tokenCount: 5, parts } });
    const rs = await client.execute({ sql: 'SELECT extra FROM messages WHERE id = ?', args: [msg.id] });
    const stored = JSON.parse(String(rs.rows[0]?.extra)) as Record<string, unknown>;
    expect(stored).toEqual({ tokenCount: 5 });

    const rows = await client.execute({
      sql: 'SELECT idx, type FROM message_parts WHERE message_id = ? ORDER BY idx',
      args: [msg.id],
    });
    expect(rows.rows.map((r) => [Number(r.idx), String(r.type)])).toEqual([
      [0, 'text'],
      [1, 'reasoning'],
      [2, 'text'],
    ]);
  });

  it('replaces parts only when the patch extra carries a parts array', async () => {
    const msg = await repo.insertMessage({ role: 'assistant', extra: { parts } });

    // Metadata-only patch: parts preserved.
    const hidden = await repo.updateMessage(msg.id, { extra: { ...msg.extra, hidden: true, parts: undefined } });
    expect(hidden.extra.hidden).toBe(true);

    // Explicit new parts: replaced.
    const newParts = [{ type: 'text' as const, text: 'edited' }];
    const edited = await repo.updateMessage(msg.id, { extra: { ...msg.extra, parts: newParts } });
    expect(edited.extra.parts).toEqual(newParts);

    // Explicit empty array: cleared.
    const cleared = await repo.updateMessage(msg.id, { extra: { parts: [] } });
    expect(cleared.extra.parts).toBeUndefined();
    const rows = await client.execute({ sql: 'SELECT 1 FROM message_parts WHERE message_id = ?', args: [msg.id] });
    expect(rows.rows).toHaveLength(0);
  });

  it('preserves parts on a metadata-only extra patch (no parts key)', async () => {
    const msg = await repo.insertMessage({ role: 'assistant', extra: { parts } });
    // Simulate a caller that builds extra without consulting the hydrated message.
    const updated = await repo.updateMessage(msg.id, { extra: { hidden: true } });
    expect(updated.extra.hidden).toBe(true);
    expect(updated.extra.parts).toEqual(parts);
  });

  it('copies part rows on hardFork', async () => {
    const userMsg = await repo.insertMessage({ role: 'user', extra: { parts: [{ type: 'text', text: 'hi' }] } });
    const reply = await repo.insertMessage({
      parentId: userMsg.id,
      role: 'assistant',
      extra: { parts },
    });
    await client.execute({
      sql: `INSERT INTO chats (id, name, head_message_id, active_child_id) VALUES (?, ?, ?, ?)`,
      args: ['chat-fork', 'source', userMsg.id, reply.id],
    });

    const fork = await repo.hardFork('chat-fork', reply.id, 'fork');
    const branch = await repo.getActiveBranch(fork.id);
    const copiedReply = branch.find((m) => m.role === 'assistant');
    expect(copiedReply).toBeDefined();
    expect(copiedReply!.id).not.toBe(reply.id);
    expect(copiedReply!.extra.parts).toEqual(parts);
  });

  it('cascades part rows on message delete', async () => {
    const msg = await repo.insertMessage({ role: 'assistant', extra: { parts } });
    await repo.deleteMessage(msg.id);
    const rows = await client.execute({ sql: 'SELECT 1 FROM message_parts WHERE message_id = ?', args: [msg.id] });
    expect(rows.rows).toHaveLength(0);
  });

  it('falls back to blob parts for rows written outside the repository', async () => {
    const id = await insertMessage(null, 'assistant', { parts: [{ type: 'text', text: 'legacy' }] });
    const msg = await repo.getMessageById(id);
    expect(msg?.extra.parts).toEqual([{ type: 'text', text: 'legacy' }]);
  });
});
