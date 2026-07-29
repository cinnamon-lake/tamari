import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuickReplyRepository } from './QuickReplyRepository.js';

let client: Client;
let repo: QuickReplyRepository;
let tmpDir: string;

// Mirror the production `quick_replies` DDL (db/migrations/001_init.sql).
async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS quick_replies (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('global', 'character', 'chat')),
      scope_id TEXT NOT NULL,
      label TEXT NOT NULL,
      icon TEXT DEFAULT '',
      color TEXT DEFAULT '',
      script TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'lua',
      auto_execute INTEGER DEFAULT 0,
      order_index INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'qr-repo-'));
  client = createClient({ url: `file:${join(tmpDir, 'db.sqlite')}` });
  await initSchema();
});

beforeEach(async () => {
  await client.execute('DELETE FROM quick_replies');
  repo = new QuickReplyRepository(client);
});

afterAll(async () => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('QuickReplyRepository', () => {
  it('create + getById round-trips a quick reply', async () => {
    await repo.create('qr-1', {
      scope: 'chat',
      scopeId: 'c1',
      label: 'Hi',
      icon: '',
      color: '',
      script: 'x',
      language: 'lua',
      autoExecute: 0,
      orderIndex: 0,
    });
    const got = await repo.getById('qr-1');
    expect(got?.label).toBe('Hi');
    expect(got?.scopeId).toBe('c1');
  });

  it('update persists multi-word camelCase fields (autoExecute, orderIndex, scopeId)', async () => {
    await repo.create('qr-2', {
      scope: 'chat',
      scopeId: 'c1',
      label: 'L',
      icon: '',
      color: '',
      script: 's',
      language: 'lua',
      autoExecute: 0,
      orderIndex: 5,
    });

    const updated = await repo.update('qr-2', {
      autoExecute: 2,
      orderIndex: 1,
      scopeId: 'c2',
      label: 'L2',
    });

    // Returned object reflects the patch...
    expect(updated.autoExecute).toBe(2);
    expect(updated.orderIndex).toBe(1);
    expect(updated.scopeId).toBe('c2');
    expect(updated.label).toBe('L2');

    // ...and it is actually persisted (re-read from the DB, not the in-memory merge).
    const reread = await repo.getById('qr-2');
    expect(reread?.autoExecute).toBe(2);
    expect(reread?.orderIndex).toBe(1);
    expect(reread?.scopeId).toBe('c2');
    expect(reread?.label).toBe('L2');
  });

  it('update with single-word fields still works (label, icon)', async () => {
    await repo.create('qr-3', {
      scope: 'global',
      scopeId: '',
      label: 'G',
      icon: '',
      color: '',
      script: 's',
      language: 'lua',
      autoExecute: 0,
      orderIndex: 0,
    });
    await repo.update('qr-3', { label: 'G2', icon: '⭐' });
    const reread = await repo.getById('qr-3');
    expect(reread?.label).toBe('G2');
    expect(reread?.icon).toBe('⭐');
  });

  it('update with no updatable keys returns the existing row unchanged', async () => {
    await repo.create('qr-4', {
      scope: 'global',
      scopeId: '',
      label: 'Keep',
      icon: '',
      color: '',
      script: 's',
      language: 'lua',
      autoExecute: 0,
      orderIndex: 0,
    });
    const result = await repo.update('qr-4', {});
    expect(result.label).toBe('Keep');
  });

  it('update on a missing id throws', async () => {
    await expect(repo.update('nope', { label: 'x' })).rejects.toThrow();
  });
});
