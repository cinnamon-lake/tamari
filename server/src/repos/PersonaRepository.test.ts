import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaRepository } from './PersonaRepository.js';
import { NotFoundError } from '../errors.js';

let client: Client;
let repo: PersonaRepository;
let tmpDir: string;

// Mirror the production `personas` DDL (db/migrations/001_init.sql), plus a
// minimal `chats` table for deleteAndReassign's persona reassignment.
async function initSchema() {
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
  await client.execute(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      persona_id TEXT,
      name TEXT NOT NULL
    )
  `);
}

beforeAll(async () => {
  // File-based, not :memory: — libsql gives each pooled connection its own
  // in-memory DB, which would break deleteAndReassign's transaction flow.
  tmpDir = mkdtempSync(join(tmpdir(), 'st-personarepo-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  await initSchema();
  repo = new PersonaRepository(client);
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM chats');
  await client.execute('DELETE FROM personas');
});

async function insertPersona(id: string, name: string, updatedAt: number) {
  await client.execute({
    sql: `INSERT INTO personas (id, name, description, created_at, updated_at) VALUES (?, ?, '', ?, ?)`,
    args: [id, name, updatedAt, updatedAt],
  });
}

describe('PersonaRepository', () => {
  it('create + getById round-trips a persona', async () => {
    const created = await repo.create('p1', {
      name: 'Alice',
      description: 'desc',
      avatarPath: 'files/personas/p1.png',
      avatarThumbnailPath: 'files/personas/p1.thumb.png',
    });

    expect(created).toMatchObject({
      id: 'p1',
      name: 'Alice',
      description: 'desc',
      avatarPath: 'files/personas/p1.png',
      avatarThumbnailPath: 'files/personas/p1.thumb.png',
    });
    expect(created.createdAt).toBeGreaterThan(0);

    const reread = await repo.getById('p1');
    expect(reread).toEqual(created);
  });

  it('create defaults description to empty string and avatars to null', async () => {
    const created = await repo.create('p2', { name: 'Bob' });
    expect(created.description).toBe('');
    expect(created.avatarPath).toBeNull();
    expect(created.avatarThumbnailPath).toBeNull();
  });

  it('getById returns undefined for a missing id', async () => {
    expect(await repo.getById('nope')).toBeUndefined();
  });

  it('getByIds returns [] for an empty id list', async () => {
    expect(await repo.getByIds([])).toEqual([]);
  });

  it('getByIds preserves caller id order and drops missing ids', async () => {
    await repo.create('a', { name: 'A' });
    await repo.create('b', { name: 'B' });
    await repo.create('c', { name: 'C' });

    const got = await repo.getByIds(['c', 'missing', 'a']);
    expect(got.map((p) => p.id)).toEqual(['c', 'a']);
  });

  it('list orders by updated_at DESC, id DESC', async () => {
    await insertPersona('p-old', 'Old', 1000);
    await insertPersona('p-new-b', 'NewB', 2000);
    await insertPersona('p-new-a', 'NewA', 2000);

    const got = await repo.list();
    expect(got.map((p) => p.id)).toEqual(['p-new-b', 'p-new-a', 'p-old']);
  });

  it('list skips a corrupt row instead of failing the whole read (mapRowsLenient)', async () => {
    await repo.create('good', { name: 'Good' });
    // TEXT in the INTEGER updated_at column fails PersonaRowSchema.
    await client.execute({
      sql: `INSERT INTO personas (id, name, description, created_at, updated_at) VALUES (?, ?, '', ?, ?)`,
      args: ['corrupt', 'Corrupt', 1000, 'oops'],
    });

    const got = await repo.list();
    expect(got.map((p) => p.id)).toEqual(['good']);
  });

  it('listSummaries returns the projection without timestamps', async () => {
    await repo.create('p1', { name: 'Alice', description: 'd', avatarPath: 'a.png' });

    const got = await repo.listSummaries();
    expect(got).toEqual([
      {
        id: 'p1',
        name: 'Alice',
        description: 'd',
        avatarPath: 'a.png',
        avatarThumbnailPath: null,
      },
    ]);
  });

  it('update persists only the patched fields and bumps updated_at', async () => {
    const created = await repo.create('p1', { name: 'Alice', description: 'old' });

    const updated = await repo.update('p1', { description: 'new' });

    expect(updated.description).toBe('new');
    expect(updated.name).toBe('Alice');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    const reread = await repo.getById('p1');
    expect(reread?.description).toBe('new');
    expect(reread?.name).toBe('Alice');
  });

  it('update with an empty patch returns the existing persona untouched', async () => {
    const created = await repo.create('p1', { name: 'Alice' });
    const updated = await repo.update('p1', {});
    expect(updated).toEqual(created);
  });

  it('update throws NotFoundError for a missing id', async () => {
    await expect(repo.update('nope', { name: 'X' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete removes the persona', async () => {
    await repo.create('p1', { name: 'Alice' });
    await repo.delete('p1');
    expect(await repo.getById('p1')).toBeUndefined();
  });

  it('delete throws NotFoundError for a missing id', async () => {
    await expect(repo.delete('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteAndReassign moves chats to the target persona and deletes the source', async () => {
    await repo.create('from', { name: 'From' });
    await repo.create('to', { name: 'To' });
    await client.execute({
      sql: `INSERT INTO chats (id, persona_id, name) VALUES (?, ?, ?)`,
      args: ['c1', 'from', 'C1'],
    });
    await client.execute({
      sql: `INSERT INTO chats (id, persona_id, name) VALUES (?, ?, ?)`,
      args: ['c2', 'from', 'C2'],
    });
    await client.execute({
      sql: `INSERT INTO chats (id, persona_id, name) VALUES (?, ?, ?)`,
      args: ['c3', 'to', 'C3'],
    });

    await repo.deleteAndReassign('from', 'to');

    expect(await repo.getById('from')).toBeUndefined();
    const rs = await client.execute({ sql: `SELECT id, persona_id FROM chats ORDER BY id`, args: [] });
    expect(rs.rows.map((r) => [r.id, r.persona_id])).toEqual([
      ['c1', 'to'],
      ['c2', 'to'],
      ['c3', 'to'],
    ]);
  });

  it('deleteAndReassign with a null target deletes without touching chats', async () => {
    await repo.create('from', { name: 'From' });
    await client.execute({
      sql: `INSERT INTO chats (id, persona_id, name) VALUES (?, ?, ?)`,
      args: ['c1', 'from', 'C1'],
    });

    await repo.deleteAndReassign('from', null);

    expect(await repo.getById('from')).toBeUndefined();
    const rs = await client.execute({ sql: `SELECT persona_id FROM chats WHERE id = ?`, args: ['c1'] });
    expect(rs.rows[0]?.persona_id).toBe('from');
  });

  it('count reflects the number of personas', async () => {
    expect(await repo.count()).toBe(0);
    await repo.create('p1', { name: 'A' });
    await repo.create('p2', { name: 'B' });
    expect(await repo.count()).toBe(2);
  });
});
