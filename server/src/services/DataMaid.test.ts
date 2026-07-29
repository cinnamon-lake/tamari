import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataMaid } from './DataMaid.js';
import { FileStorage } from './FileStorage.js';

let client: Client;
let tmpDir: string;
let storage: FileStorage;
let maid: DataMaid;

async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      personality TEXT,
      scenario TEXT,
      first_mes TEXT,
      mes_example TEXT,
      creator TEXT,
      character_version TEXT,
      tags TEXT DEFAULT '[]',
      avatar_path TEXT,
      avatar_thumbnail_path TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      head_message_id INTEGER,
      active_child_id INTEGER,
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
      parent_id INTEGER REFERENCES messages(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      extra TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL,
      file_path TEXT,
      meta TEXT DEFAULT '{}'
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message_id INTEGER,
      status TEXT NOT NULL,
      backend TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      error_message TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      talkativeness REAL DEFAULT 1.0,
      depth_prompt TEXT DEFAULT '',
      depth_prompt_depth INTEGER DEFAULT 4,
      enabled INTEGER DEFAULT 1,
      PRIMARY KEY (chat_id, character_id)
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      avatar_path TEXT,
      avatar_thumbnail_path TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  await initSchema();
  tmpDir = mkdtempSync(join(tmpdir(), 'st-maiden-test-'));
  storage = new FileStorage(tmpDir);
  maid = new DataMaid(client, storage);
});

beforeEach(async () => {
  await client.execute('DELETE FROM chat_members');
  await client.execute('DELETE FROM generations');
  await client.execute('DELETE FROM attachments');
  await client.execute('DELETE FROM messages');
  await client.execute('DELETE FROM chats');
  await client.execute('DELETE FROM characters');
  await client.execute('DELETE FROM personas');
  // Clean up temp files from previous tests
  for (const sub of ['avatars', 'personas', 'attachments']) {
    const dir = join(tmpDir, 'files', sub);
    if (!statSync(dir, { throwIfNoEntry: false })) continue;
    for (const f of readdirSync(dir)) {
      rmSync(join(dir, f));
    }
  }
});

afterAll(async () => {
  client.close();
});

describe('DataMaid', () => {
  it('reports no issues on a clean database', async () => {
    const report = await maid.scan();
    expect(report.summary.totalIssues).toBe(0);
    expect(report.summary.totalSqlOrphans).toBe(0);
    expect(report.summary.totalFilesystemOrphans).toBe(0);
  });

  it('finds unlinked attachments', async () => {
    await client.execute({
      sql: 'INSERT INTO attachments (id, message_id, mime_type, file_path) VALUES (?, ?, ?, ?)',
      args: ['att-1', null, 'image/png', 'files/attachments/att-1'],
    });

    const report = await maid.scan();
    expect(report.sqlOrphans.unlinkedAttachments).toContain('att-1');
    expect(report.summary.totalSqlOrphans).toBe(1);
  });

  it('finds dangling generations', async () => {
    await client.execute({
      sql: 'INSERT INTO generations (id, chat_id, status, backend) VALUES (?, ?, ?, ?)',
      args: ['gen-1', 'deleted-chat', 'complete', 'openai'],
    });

    const report = await maid.scan();
    expect(report.sqlOrphans.danglingGenerations).toContain('gen-1');
  });

  it('finds chats with deleted characters', async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await client.execute({
      sql: 'INSERT INTO chats (id, character_id, name) VALUES (?, ?, ?)',
      args: ['chat-1', 'deleted-char', 'Test Chat'],
    });
    await client.execute('PRAGMA foreign_keys = ON');

    const report = await maid.scan();
    expect(report.sqlOrphans.chatsWithDeletedCharacters).toContain('chat-1');
  });

  it('finds messages with deleted parents', async () => {
    // Temporarily disable FK enforcement to simulate an orphan
    await client.execute('PRAGMA foreign_keys = OFF');
    await client.execute({
      sql: 'INSERT INTO chats (id, character_id, name) VALUES (?, ?, ?)',
      args: ['chat-1', null, 'Test Chat'],
    });
    await client.execute({
      sql: 'INSERT INTO messages (id, role, content) VALUES (?, ?, ?)',
      args: [1, 'user', 'hello'],
    });
    await client.execute({
      sql: 'INSERT INTO messages (id, parent_id, role, content) VALUES (?, ?, ?, ?)',
      args: [2, 999, 'assistant', 'hi'],
    });
    await client.execute('PRAGMA foreign_keys = ON');

    const report = await maid.scan();
    expect(report.sqlOrphans.messagesWithDeletedParents).toContain('2');
  });

  it('finds orphaned avatar files on disk', async () => {
    // Create a character with an avatar path
    await client.execute({
      sql: 'INSERT INTO characters (id, name, avatar_path) VALUES (?, ?, ?)',
      args: ['char-1', 'Alice', 'files/avatars/char-1.png'],
    });

    // Write the referenced file and an orphan
    mkdirSync(join(tmpDir, 'files', 'avatars'), { recursive: true });
    writeFileSync(join(tmpDir, 'files', 'avatars', 'char-1.png'), 'pngdata');
    writeFileSync(join(tmpDir, 'files', 'avatars', 'orphan.png'), 'pngdata');

    const report = await maid.scan();
    expect(report.filesystemOrphans.orphanedAvatarFiles).toContain('files/avatars/orphan.png');
    expect(report.filesystemOrphans.orphanedAvatarFiles).not.toContain('files/avatars/char-1.png');
  });

  it('cleans up SQL orphans', async () => {
    await client.execute({
      sql: 'INSERT INTO attachments (id, message_id, mime_type, file_path) VALUES (?, ?, ?, ?)',
      args: ['att-del', null, 'image/png', 'files/attachments/att-del'],
    });

    const report = await maid.scan();
    const result = await maid.clean(report);

    expect(result.deletedSql).toBe(1);
    expect(result.deletedFiles).toBe(0);

    const after = await maid.scan();
    expect(after.summary.totalIssues).toBe(0);
  });

  it('cleans up filesystem orphans', async () => {
    mkdirSync(join(tmpDir, 'files', 'attachments'), { recursive: true });
    writeFileSync(join(tmpDir, 'files', 'attachments', 'orphan.bin'), 'data');

    const report = await maid.scan();
    const result = await maid.clean(report);

    expect(result.deletedFiles).toBe(1);
    expect(result.deletedSql).toBe(0);
  });

  it('preserves soft-fork-referenced messages during gc', async () => {
    // Main chat with messages 1 -> 2
    await client.execute({ sql: 'INSERT INTO chats (id, name) VALUES (?, ?)', args: ['main', 'Main'] });
    await client.execute({
      sql: 'INSERT INTO messages (id, role, content) VALUES (?, ?, ?)',
      args: [1, 'user', 'hello'],
    });
    await client.execute({
      sql: 'INSERT INTO messages (id, role, content, parent_id) VALUES (?, ?, ?, ?)',
      args: [2, 'assistant', 'hi', 1],
    });

    // Soft fork chat referencing message 2, then continuing with message 3
    await client.execute({
      sql: 'INSERT INTO chats (id, name, active_child_id) VALUES (?, ?, ?)',
      args: ['fork', 'Fork', 2],
    });
    await client.execute({
      sql: 'INSERT INTO messages (id, role, content, parent_id) VALUES (?, ?, ?, ?)',
      args: [3, 'user', 'fork-msg', 2],
    });
    await client.execute({ sql: 'UPDATE chats SET active_child_id = ? WHERE id = ?', args: [3, 'fork'] });

    // Delete main chat (bypass FK to leave messages for GC)
    await client.execute('PRAGMA foreign_keys = OFF');
    await client.execute({ sql: 'DELETE FROM chats WHERE id = ?', args: ['main'] });
    await client.execute('PRAGMA foreign_keys = ON');

    // Message 3 is reachable from fork's active_child_id.
    // Message 2 is parent of 3, so preserved.
    // Message 1 is parent of 2, so preserved.
    const gcResult = await maid.gcMessages();
    expect(gcResult.deleted).toBe(0);

    const remaining = await client.execute('SELECT id FROM messages ORDER BY id');
    expect(remaining.rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('gc deletes unreferenced messages after chat deletion', async () => {
    await client.execute({ sql: 'INSERT INTO chats (id, name) VALUES (?, ?)', args: ['chat-1', 'Chat 1'] });
    await client.execute({ sql: 'INSERT INTO messages (id, role, content) VALUES (?, ?, ?)', args: [10, 'user', 'a'] });
    await client.execute({
      sql: 'INSERT INTO messages (id, role, content, parent_id) VALUES (?, ?, ?, ?)',
      args: [11, 'assistant', 'b', 10],
    });

    // Delete chat without cascade so messages remain for GC
    await client.execute('PRAGMA foreign_keys = OFF');
    await client.execute({ sql: 'DELETE FROM chats WHERE id = ?', args: ['chat-1'] });
    await client.execute('PRAGMA foreign_keys = ON');

    const gcResult = await maid.gcMessages();
    expect(gcResult.deleted).toBe(2);

    const remaining = await client.execute('SELECT id FROM messages');
    expect(remaining.rows.length).toBe(0);
  });
});
