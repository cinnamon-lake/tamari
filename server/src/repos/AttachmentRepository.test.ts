import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentRepository } from './AttachmentRepository.js';
import { NotFoundError } from '../errors.js';

let client: Client;
let repo: AttachmentRepository;
let tmpDir: string;

// Mirror the production `attachments` DDL (db/migrations/001_init.sql). The
// messages FK target is omitted — these tests never enable PRAGMA
// foreign_keys, and message ids are plain integers here.
async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id INTEGER,
      mime_type TEXT NOT NULL,
      blob BLOB,
      file_path TEXT,
      meta TEXT DEFAULT '{}'
    )
  `);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-attachrepo-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  await initSchema();
  repo = new AttachmentRepository(client);
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM attachments');
});

describe('AttachmentRepository', () => {
  it('create + getById round-trips an attachment', async () => {
    const created = await repo.create({
      id: 'att-1',
      messageId: 42,
      mimeType: 'image/png',
      filePath: 'files/attachments/att-1',
      meta: { width: 100 },
    });

    expect(created.id).toBe('att-1');
    expect(created.messageId).toBe(42);
    expect(created.mimeType).toBe('image/png');
    expect(created.filePath).toBe('files/attachments/att-1');
    expect(created.meta).toEqual({ width: 100 });
    // The canonical URL is derived from the id, never stored.
    expect(created.url).toBe('/api/attachments/att-1');

    const reread = await repo.getById('att-1');
    expect(reread).toEqual(created);
  });

  it('create defaults meta to {} when omitted', async () => {
    const created = await repo.create({
      id: 'att-2',
      messageId: null,
      mimeType: 'image/png',
      filePath: 'files/attachments/att-2',
    });
    expect(created.meta).toEqual({});
    expect(created.messageId).toBeNull();
  });

  it('falls back to empty filePath when file_path is NULL', async () => {
    await client.execute({
      sql: `INSERT INTO attachments (id, message_id, mime_type, file_path, meta) VALUES (?, ?, ?, ?, ?)`,
      args: ['att-null-path', 1, 'image/png', null, '{}'],
    });
    const got = await repo.getById('att-null-path');
    expect(got?.filePath).toBe('');
  });

  it('falls back to {} meta when the meta column holds corrupt JSON', async () => {
    await client.execute({
      sql: `INSERT INTO attachments (id, message_id, mime_type, file_path, meta) VALUES (?, ?, ?, ?, ?)`,
      args: ['att-badmeta', 1, 'image/png', 'p', '{not json'],
    });
    const got = await repo.getById('att-badmeta');
    expect(got?.meta).toEqual({});
  });

  it('getById returns undefined for a missing id', async () => {
    expect(await repo.getById('nope')).toBeUndefined();
  });

  it('getByIds returns [] for an empty id list', async () => {
    expect(await repo.getByIds([])).toEqual([]);
  });

  it('getByIds preserves caller id order and drops missing ids', async () => {
    await repo.create({ id: 'a', messageId: 1, mimeType: 'm', filePath: 'fa' });
    await repo.create({ id: 'b', messageId: 1, mimeType: 'm', filePath: 'fb' });
    await repo.create({ id: 'c', messageId: 1, mimeType: 'm', filePath: 'fc' });

    const got = await repo.getByIds(['c', 'missing', 'a']);
    expect(got.map((x) => x.id)).toEqual(['c', 'a']);
  });

  it("listByMessage returns only that message's attachments", async () => {
    await repo.create({ id: 'm1-a', messageId: 1, mimeType: 'm', filePath: 'f1' });
    await repo.create({ id: 'm1-b', messageId: 1, mimeType: 'm', filePath: 'f2' });
    await repo.create({ id: 'm2-a', messageId: 2, mimeType: 'm', filePath: 'f3' });

    const got = await repo.listByMessage(1);
    expect(got.map((x) => x.id).sort()).toEqual(['m1-a', 'm1-b']);
  });

  it('listByMessage skips a corrupt row instead of failing the whole read (mapRowsLenient)', async () => {
    await repo.create({ id: 'good', messageId: 7, mimeType: 'm', filePath: 'f' });
    // SQLite's flexible typing lets a TEXT value land in the INTEGER column;
    // AttachmentRowSchema then rejects the row.
    await client.execute({
      sql: `INSERT INTO attachments (id, message_id, mime_type, file_path, meta) VALUES (?, ?, ?, ?, ?)`,
      args: ['corrupt', 'not-a-number', 'm', 'f', '{}'],
    });

    const got = await repo.listByMessage(7);
    expect(got.map((x) => x.id)).toEqual(['good']);
  });

  it('linkToMessage reassigns message_id and returns the updated row', async () => {
    await repo.create({ id: 'att-link', messageId: null, mimeType: 'm', filePath: 'f' });

    const linked = await repo.linkToMessage('att-link', 99);
    expect(linked.messageId).toBe(99);

    const reread = await repo.getById('att-link');
    expect(reread?.messageId).toBe(99);
  });

  it('linkToMessage throws NotFoundError for a missing id', async () => {
    await expect(repo.linkToMessage('nope', 1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete removes the row', async () => {
    await repo.create({ id: 'att-del', messageId: 1, mimeType: 'm', filePath: 'f' });
    await repo.delete('att-del');
    expect(await repo.getById('att-del')).toBeUndefined();
  });

  it('delete throws NotFoundError for a missing id', async () => {
    await expect(repo.delete('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
