import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthSessionRepository } from './AuthSessionRepository.js';

let client: Client;
let repo: AuthSessionRepository;
let tmpDir: string;

// Mirror the production `auth_sessions` DDL (db/migrations/018_auth_sessions.sql).
async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    )
  `);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-authsess-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  await initSchema();
  repo = new AuthSessionRepository(client);
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM auth_sessions');
});

describe('AuthSessionRepository', () => {
  it('create + get round-trips a session with an expiry', async () => {
    await repo.create({ id: 's1', tokenHash: 'hash-1', createdAt: 1000, expiresAt: 2000 });

    const got = await repo.get('s1');
    expect(got).toEqual({ id: 's1', tokenHash: 'hash-1', createdAt: 1000, expiresAt: 2000 });
  });

  it('create + get round-trips a session with no expiry (NULL expires_at)', async () => {
    await repo.create({ id: 's2', tokenHash: 'hash-2', createdAt: 1000, expiresAt: null });

    const got = await repo.get('s2');
    expect(got).toEqual({ id: 's2', tokenHash: 'hash-2', createdAt: 1000, expiresAt: null });
  });

  it('get returns undefined for a missing id', async () => {
    expect(await repo.get('nope')).toBeUndefined();
  });

  it('delete removes the session', async () => {
    await repo.create({ id: 's3', tokenHash: 'h', createdAt: 1, expiresAt: null });
    await repo.delete('s3');
    expect(await repo.get('s3')).toBeUndefined();
  });

  it('delete of a missing id is a silent no-op (revocation is idempotent)', async () => {
    await expect(repo.delete('nope')).resolves.toBeUndefined();
  });

  it('deleteExpired removes only rows past the cutoff', async () => {
    await repo.create({ id: 'old', tokenHash: 'h', createdAt: 1, expiresAt: 100 });
    await repo.create({ id: 'boundary-kept', tokenHash: 'h', createdAt: 1, expiresAt: 500 });
    await repo.create({ id: 'fresh', tokenHash: 'h', createdAt: 1, expiresAt: 9999 });
    await repo.create({ id: 'no-expiry', tokenHash: 'h', createdAt: 1, expiresAt: null });

    await repo.deleteExpired(500);

    expect(await repo.get('old')).toBeUndefined();
    // expires_at < cutoff, not <= — a session expiring exactly at the cutoff survives.
    expect(await repo.get('boundary-kept')).toBeDefined();
    expect(await repo.get('fresh')).toBeDefined();
    // Never-expiring sessions are never swept.
    expect(await repo.get('no-expiry')).toBeDefined();
  });

  it('deleteExpired on an empty table is a no-op', async () => {
    await expect(repo.deleteExpired(1000)).resolves.toBeUndefined();
  });
});
