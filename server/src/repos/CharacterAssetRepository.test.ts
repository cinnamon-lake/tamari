import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterAssetRepository } from './CharacterAssetRepository.js';
import { NotFoundError } from '../errors.js';

let client: Client;
let repo: CharacterAssetRepository;
let tmpDir: string;

// Mirror the production `character_assets` DDL (db/migrations/001_init.sql),
// minus the characters FK (foreign_keys pragma stays off in these tests).
async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS character_assets (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'other',
      ext TEXT NOT NULL DEFAULT 'png',
      file_path TEXT,
      meta TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-charasset-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  await initSchema();
  repo = new CharacterAssetRepository(client);
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM character_assets');
});

describe('CharacterAssetRepository', () => {
  it('create + getById round-trips an asset with an explicit id', async () => {
    const created = await repo.create('char-1', {
      id: 'asset-1',
      name: 'portrait',
      type: 'image',
      ext: 'webp',
      filePath: 'files/character_assets/char-1/asset-1.webp',
      meta: { source: 'card' },
    });

    expect(created).toMatchObject({
      id: 'asset-1',
      characterId: 'char-1',
      name: 'portrait',
      type: 'image',
      ext: 'webp',
      filePath: 'files/character_assets/char-1/asset-1.webp',
      meta: { source: 'card' },
    });
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);

    const reread = await repo.getById('asset-1');
    expect(reread).toEqual(created);
  });

  it('create generates a UUID id when none is given', async () => {
    const created = await repo.create('char-1', {
      name: 'x',
      type: 'image',
      ext: 'png',
      filePath: null,
      meta: {},
    });
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('create applies defensive defaults for missing optional input fields', async () => {
    // Cast: the repo deliberately tolerates unvalidated API input (see the
    // eslint-disable in the source) — name/type/ext/meta fall back.
    const created = await repo.create('char-1', {
      filePath: null,
    } as unknown as Parameters<CharacterAssetRepository['create']>[1]);

    expect(created.name).toBe('');
    expect(created.type).toBe('other');
    expect(created.ext).toBe('png');
    expect(created.meta).toEqual({});
    expect(created.filePath).toBeNull();
  });

  it('getById returns undefined for a missing id', async () => {
    expect(await repo.getById('nope')).toBeUndefined();
  });

  it("listForCharacter returns only that character's assets, ordered by created_at then id", async () => {
    // Same-second inserts tie on created_at; id ASC is the deterministic tiebreak.
    await repo.create('char-1', { id: 'b-asset', name: 'b', type: 't', ext: 'png', filePath: null, meta: {} });
    await repo.create('char-1', { id: 'a-asset', name: 'a', type: 't', ext: 'png', filePath: null, meta: {} });
    await repo.create('char-2', { id: 'other', name: 'o', type: 't', ext: 'png', filePath: null, meta: {} });

    const got = await repo.listForCharacter('char-1');
    expect(got.map((a) => a.id)).toEqual(['a-asset', 'b-asset']);
  });

  it('listForCharacter orders older created_at first', async () => {
    await client.execute({
      sql: `INSERT INTO character_assets (id, character_id, name, type, ext, file_path, meta, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['newer', 'char-1', 'n', 't', 'png', null, '{}', 2000, 2000],
    });
    await client.execute({
      sql: `INSERT INTO character_assets (id, character_id, name, type, ext, file_path, meta, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['older', 'char-1', 'o', 't', 'png', null, '{}', 1000, 1000],
    });

    const got = await repo.listForCharacter('char-1');
    expect(got.map((a) => a.id)).toEqual(['older', 'newer']);
  });

  it('listForCharacter skips a corrupt row instead of failing the whole read (mapRowsLenient)', async () => {
    await repo.create('char-1', { id: 'good', name: 'g', type: 't', ext: 'png', filePath: null, meta: {} });
    // TEXT in the INTEGER created_at column fails CharacterAssetRowSchema.
    await client.execute({
      sql: `INSERT INTO character_assets (id, character_id, name, type, ext, file_path, meta, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['corrupt', 'char-1', 'c', 't', 'png', null, '{}', 'oops', 1000],
    });

    const got = await repo.listForCharacter('char-1');
    expect(got.map((a) => a.id)).toEqual(['good']);
  });

  it('falls back to {} meta when the meta column holds corrupt JSON', async () => {
    await client.execute({
      sql: `INSERT INTO character_assets (id, character_id, name, type, ext, file_path, meta, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['badmeta', 'char-1', 'n', 't', 'png', null, '{oops', 1000, 1000],
    });
    const got = await repo.getById('badmeta');
    expect(got?.meta).toEqual({});
  });

  it("deleteForCharacter removes only that character's assets", async () => {
    await repo.create('char-1', { id: 'mine', name: 'm', type: 't', ext: 'png', filePath: null, meta: {} });
    await repo.create('char-2', { id: 'theirs', name: 't', type: 't', ext: 'png', filePath: null, meta: {} });

    await repo.deleteForCharacter('char-1');

    expect(await repo.getById('mine')).toBeUndefined();
    expect(await repo.getById('theirs')).toBeDefined();
  });

  it('delete removes the row', async () => {
    await repo.create('char-1', { id: 'del', name: 'd', type: 't', ext: 'png', filePath: null, meta: {} });
    await repo.delete('del');
    expect(await repo.getById('del')).toBeUndefined();
  });

  it('delete throws NotFoundError for a missing id', async () => {
    await expect(repo.delete('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
