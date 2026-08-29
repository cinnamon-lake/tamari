import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretRepository } from './SecretRepository.js';
import { NotFoundError } from '../errors.js';

let client: Client;
let repo: SecretRepository;
let tmpDir: string;

// Mirror the production `secrets` DDL (db/migrations/001_init.sql).
async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      label TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-secretrepo-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  await initSchema();
  repo = new SecretRepository(client);
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM secrets');
});

describe('SecretRepository', () => {
  it('set + get round-trips a secret', async () => {
    await repo.set('openai', 'sk-ciphertext', 'OpenAI key');

    const got = await repo.get('openai');
    expect(got?.key).toBe('openai');
    expect(got?.value).toBe('sk-ciphertext');
    expect(got?.label).toBe('OpenAI key');
    expect(got?.updatedAt).toBeGreaterThan(0);
  });

  it('set defaults label to null when omitted', async () => {
    await repo.set('k', 'v');
    expect((await repo.get('k'))?.label).toBeNull();
  });

  it('set upserts on key conflict, overwriting value and label', async () => {
    await repo.set('k', 'v1', 'label-1');
    await repo.set('k', 'v2', 'label-2');

    const got = await repo.get('k');
    expect(got?.value).toBe('v2');
    expect(got?.label).toBe('label-2');

    // Still exactly one row.
    expect(await repo.list()).toHaveLength(1);
  });

  it('set on conflict can clear a label back to null', async () => {
    await repo.set('k', 'v1', 'label-1');
    await repo.set('k', 'v2');
    expect((await repo.get('k'))?.label).toBeNull();
  });

  it('get returns undefined for a missing key', async () => {
    expect(await repo.get('nope')).toBeUndefined();
  });

  it('list orders by key', async () => {
    await repo.set('zeta', 'v');
    await repo.set('alpha', 'v');
    await repo.set('mid', 'v');

    const got = await repo.list();
    expect(got.map((s) => s.key)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('list skips a corrupt row instead of failing the whole read (mapRowsLenient)', async () => {
    await repo.set('good', 'v');
    // TEXT in the INTEGER updated_at column fails SecretRowSchema.
    await client.execute({
      sql: `INSERT INTO secrets (key, value, label, updated_at) VALUES (?, ?, ?, ?)`,
      args: ['corrupt', 'v', null, 'oops'],
    });

    const got = await repo.list();
    expect(got.map((s) => s.key)).toEqual(['good']);
  });

  it('delete removes the secret', async () => {
    await repo.set('k', 'v');
    await repo.delete('k');
    expect(await repo.get('k')).toBeUndefined();
  });

  it('delete throws NotFoundError for a missing key', async () => {
    await expect(repo.delete('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
