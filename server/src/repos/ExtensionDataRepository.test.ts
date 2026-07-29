import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { ExtensionDataRepository } from './ExtensionDataRepository.js';

let client: Client;
let repo: ExtensionDataRepository;

// Mirror the production `extension_data` DDL (db/migrations/001_init.sql).
async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS extension_data (
      extension_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('global', 'character', 'chat', 'message')),
      entity_id TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (extension_id, entity_type, entity_id)
    )
  `);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  await initSchema();
  repo = new ExtensionDataRepository(client);
});

beforeEach(async () => {
  await client.execute('DELETE FROM extension_data');
});

afterAll(() => {
  client.close();
});

describe('ExtensionDataRepository', () => {
  it('sets and gets data', async () => {
    await repo.set('my-ext', 'chat', 'chat-1', { foo: 'bar', count: 3 });
    expect(await repo.get('my-ext', 'chat', 'chat-1')).toEqual({ foo: 'bar', count: 3 });
  });

  it('returns undefined for missing rows', async () => {
    expect(await repo.get('missing', 'chat', 'chat-1')).toBeUndefined();
  });

  it('overwrites existing data on conflict', async () => {
    await repo.set('my-ext', 'chat', 'chat-1', { v: 1 });
    await repo.set('my-ext', 'chat', 'chat-1', { v: 2 });
    expect(await repo.get('my-ext', 'chat', 'chat-1')).toEqual({ v: 2 });
  });

  it('deletes data', async () => {
    await repo.set('my-ext', 'chat', 'chat-1', { foo: 'bar' });
    await repo.delete('my-ext', 'chat', 'chat-1');
    expect(await repo.get('my-ext', 'chat', 'chat-1')).toBeUndefined();
  });

  it('scopes rows by entity type and entity id', async () => {
    await repo.set('my-ext', 'chat', 'chat-1', { scope: 'chat-1' });
    await repo.set('my-ext', 'chat', 'chat-2', { scope: 'chat-2' });
    await repo.set('my-ext', 'global', '', { scope: 'global' });

    expect(await repo.get('my-ext', 'chat', 'chat-1')).toEqual({ scope: 'chat-1' });
    expect(await repo.get('my-ext', 'chat', 'chat-2')).toEqual({ scope: 'chat-2' });
    expect(await repo.get('my-ext', 'global', '')).toEqual({ scope: 'global' });
  });

  it('scopes rows by extension id within the same entity', async () => {
    await repo.set('ext-a', 'chat', 'chat-1', { ext: 'a' });
    await repo.set('ext-b', 'chat', 'chat-1', { ext: 'b' });
    expect(await repo.get('ext-a', 'chat', 'chat-1')).toEqual({ ext: 'a' });
    expect(await repo.get('ext-b', 'chat', 'chat-1')).toEqual({ ext: 'b' });
  });

  it('listForEntity returns all extensions for an entity', async () => {
    await repo.set('ext-b', 'chat', 'chat-1', { n: 2 });
    await repo.set('ext-a', 'chat', 'chat-1', { n: 1 });
    await repo.set('ext-a', 'chat', 'chat-2', { n: 3 });
    await repo.set('ext-a', 'global', '', { n: 4 });

    const rows = await repo.listForEntity('chat', 'chat-1');
    expect(rows).toHaveLength(2);
    // Ordered by extension_id
    expect(rows[0]).toEqual({ extensionId: 'ext-a', entityType: 'chat', entityId: 'chat-1', data: { n: 1 } });
    expect(rows[1]).toEqual({ extensionId: 'ext-b', entityType: 'chat', entityId: 'chat-1', data: { n: 2 } });
  });

  it('rejects non-JSON-serializable data', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(repo.set('my-ext', 'chat', 'chat-1', circular)).rejects.toThrow('not JSON-serializable');
  });

  it('rejects data larger than 64 KB serialized', async () => {
    const big = { blob: 'x'.repeat(64 * 1024) };
    await expect(repo.set('my-ext', 'chat', 'chat-1', big)).rejects.toThrow('exceeds');
    expect(await repo.get('my-ext', 'chat', 'chat-1')).toBeUndefined();
  });
});
