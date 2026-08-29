import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldInfoRepository } from './WorldInfoRepository.js';
import { NotFoundError } from '../errors.js';
import type { WorldInfoEntry } from '@tamari/types';

let client: Client;
let repo: WorldInfoRepository;
let tmpDir: string;

// Mirror the production `world_info` DDL (db/migrations/001_init.sql).
async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS world_info (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      entries TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

const sampleEntry: WorldInfoEntry = {
  id: 'e1',
  keys: ['dragon'],
  content: 'Dragons are real.',
  comment: '',
  order: 10,
  position: 'before_char',
  probability: 100,
  constant: false,
  selective: false,
  secondaryKeys: [],
  addMemo: false,
  disable: false,
  regex: false,
  recursive: false,
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-wirepo-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  await initSchema();
  repo = new WorldInfoRepository(client);
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM world_info');
});

describe('WorldInfoRepository', () => {
  it('create + getById round-trips a lorebook with entries', async () => {
    const created = await repo.create('wi-1', { name: 'World', entries: [sampleEntry] });

    expect(created.id).toBe('wi-1');
    expect(created.name).toBe('World');
    expect(created.entries).toEqual([sampleEntry]);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);

    const reread = await repo.getById('wi-1');
    expect(reread).toEqual(created);
  });

  it('create defaults entries to [] when omitted', async () => {
    // Cast: the repo deliberately tolerates unvalidated API input (see the
    // eslint-disable in the source).
    const created = await repo.create('wi-2', {
      name: 'Bare',
    } as unknown as Parameters<WorldInfoRepository['create']>[1]);
    expect(created.entries).toEqual([]);
  });

  it('getById returns undefined for a missing id', async () => {
    expect(await repo.getById('nope')).toBeUndefined();
  });

  it('getById falls back to [] entries when the entries column holds corrupt JSON', async () => {
    await client.execute({
      sql: `INSERT INTO world_info (id, name, entries, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: ['bad-json', 'Bad', '{oops', 1000, 1000],
    });

    const got = await repo.getById('bad-json');
    expect(got?.entries).toEqual([]);
  });

  it('getById falls back to [] entries when entries fail the entry schema', async () => {
    await client.execute({
      sql: `INSERT INTO world_info (id, name, entries, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: ['bad-shape', 'Bad', '[{"nope":1}]', 1000, 1000],
    });

    const got = await repo.getById('bad-shape');
    expect(got?.entries).toEqual([]);
  });

  it('list orders by updated_at DESC, id DESC', async () => {
    await client.execute({
      sql: `INSERT INTO world_info (id, name, entries, created_at, updated_at) VALUES (?, ?, '[]', ?, ?)`,
      args: ['wi-old', 'Old', 1000, 1000],
    });
    await client.execute({
      sql: `INSERT INTO world_info (id, name, entries, created_at, updated_at) VALUES (?, ?, '[]', ?, ?)`,
      args: ['wi-new-a', 'NewA', 2000, 2000],
    });
    await client.execute({
      sql: `INSERT INTO world_info (id, name, entries, created_at, updated_at) VALUES (?, ?, '[]', ?, ?)`,
      args: ['wi-new-b', 'NewB', 2000, 2000],
    });

    const got = await repo.list();
    expect(got.map((w) => w.id)).toEqual(['wi-new-b', 'wi-new-a', 'wi-old']);
  });

  it('list skips a corrupt row instead of failing the whole read (mapRowsLenient)', async () => {
    await repo.create('good', { name: 'Good', entries: [] });
    // TEXT in the INTEGER updated_at column fails WorldInfoRowSchema.
    await client.execute({
      sql: `INSERT INTO world_info (id, name, entries, created_at, updated_at) VALUES (?, ?, '[]', ?, ?)`,
      args: ['corrupt', 'Corrupt', 1000, 'oops'],
    });

    const got = await repo.list();
    expect(got.map((w) => w.id)).toEqual(['good']);
  });

  it('update persists only the patched fields and bumps updated_at', async () => {
    const created = await repo.create('wi-1', { name: 'Old', entries: [sampleEntry] });

    const updated = await repo.update('wi-1', { name: 'New' });

    expect(updated.name).toBe('New');
    expect(updated.entries).toEqual([sampleEntry]);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    const reread = await repo.getById('wi-1');
    expect(reread).toEqual(updated);
  });

  it('update with an empty patch returns the existing lorebook untouched', async () => {
    const created = await repo.create('wi-1', { name: 'World', entries: [] });
    const updated = await repo.update('wi-1', {});
    expect(updated).toEqual(created);
  });

  it('update throws NotFoundError for a missing id', async () => {
    await expect(repo.update('nope', { name: 'X' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete removes the lorebook', async () => {
    await repo.create('wi-1', { name: 'World', entries: [] });
    await repo.delete('wi-1');
    expect(await repo.getById('wi-1')).toBeUndefined();
  });

  it('delete throws NotFoundError for a missing id', async () => {
    await expect(repo.delete('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
