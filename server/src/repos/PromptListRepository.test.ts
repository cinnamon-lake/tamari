import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptListRepository } from './PromptListRepository.js';
import { NotFoundError } from '../errors.js';
import type { PresetPromptDef, PresetPromptOrderEntry } from '@tamari/types';

let client: Client;
let repo: PromptListRepository;
let tmpDir: string;

// Mirror the production `prompt_lists` DDL (db/migrations/001_init.sql).
async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS prompt_lists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      prompts_json TEXT NOT NULL DEFAULT '[]',
      prompt_order_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

const samplePrompt: PresetPromptDef = {
  identifier: 'main',
  name: 'Main',
  content: 'You are helpful.',
  role: 'system',
  enabled: true,
};

const sampleOrder: PresetPromptOrderEntry = { identifier: 'main', enabled: true };

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-promptlist-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  await initSchema();
  repo = new PromptListRepository(client);
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM prompt_lists');
});

describe('PromptListRepository', () => {
  it('create + getById round-trips prompts and prompt order', async () => {
    const created = await repo.create('pl-1', {
      name: 'Default',
      description: 'd',
      prompts: [samplePrompt],
      promptOrder: [sampleOrder],
    });

    expect(created).toMatchObject({
      id: 'pl-1',
      name: 'Default',
      description: 'd',
      prompts: [samplePrompt],
      promptOrder: [sampleOrder],
    });
    expect(created.createdAt).toBeGreaterThan(0);

    const reread = await repo.getById('pl-1');
    expect(reread).toEqual(created);
  });

  it('create applies defensive defaults for missing optional input fields', async () => {
    // Cast: the repo deliberately tolerates unvalidated API input (see the
    // eslint-disable in the source).
    const created = await repo.create('pl-2', {
      name: 'Bare',
    } as unknown as Parameters<PromptListRepository['create']>[1]);

    expect(created.description).toBe('');
    expect(created.prompts).toEqual([]);
    expect(created.promptOrder).toEqual([]);
  });

  it('getById returns undefined for a missing id', async () => {
    expect(await repo.getById('nope')).toBeUndefined();
  });

  it('getById falls back to empty arrays when a JSON column holds corrupt JSON', async () => {
    await client.execute({
      sql: `INSERT INTO prompt_lists (id, name, description, prompts_json, prompt_order_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ['bad-json', 'Bad', '', '{oops', 'not json at all', 1000, 1000],
    });

    const got = await repo.getById('bad-json');
    expect(got?.prompts).toEqual([]);
    expect(got?.promptOrder).toEqual([]);
  });

  it('list orders by name, then id', async () => {
    await repo.create('pl-b', { name: 'Beta', description: '', prompts: [], promptOrder: [] });
    await repo.create('pl-a2', { name: 'Alpha', description: '', prompts: [], promptOrder: [] });
    await repo.create('pl-a1', { name: 'Alpha', description: '', prompts: [], promptOrder: [] });

    const got = await repo.list();
    expect(got.map((p) => p.id)).toEqual(['pl-a1', 'pl-a2', 'pl-b']);
  });

  it('list skips a corrupt row instead of failing the whole read (mapRowsLenient)', async () => {
    await repo.create('good', { name: 'Good', description: '', prompts: [], promptOrder: [] });
    // TEXT in the INTEGER created_at column fails PromptListRowSchema.
    await client.execute({
      sql: `INSERT INTO prompt_lists (id, name, description, prompts_json, prompt_order_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ['corrupt', 'Corrupt', '', '[]', '[]', 'oops', 1000],
    });

    const got = await repo.list();
    expect(got.map((p) => p.id)).toEqual(['good']);
  });

  it('degrades prompts to [] when entries fail the domain schema (safeParseJson, not row skip)', async () => {
    await repo.create('good', { name: 'Good', description: '', prompts: [], promptOrder: [] });
    // Valid JSON, but the entries don't satisfy PresetPromptDefSchema —
    // safeParseJson degrades to [], the row itself still lists.
    await client.execute({
      sql: `INSERT INTO prompt_lists (id, name, description, prompts_json, prompt_order_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ['bad-shape', 'Bad', '', '[{"nope":1}]', '[]', 1000, 1000],
    });

    const got = await repo.list();
    expect(got.map((p) => p.id)).toEqual(['bad-shape', 'good']);
    expect(got.find((p) => p.id === 'bad-shape')?.prompts).toEqual([]);
  });

  it('listSummaries returns only id and name, ordered like list', async () => {
    await repo.create('pl-b', { name: 'Beta', description: 'hidden', prompts: [samplePrompt], promptOrder: [] });
    await repo.create('pl-a', { name: 'Alpha', description: 'hidden', prompts: [], promptOrder: [] });

    const got = await repo.listSummaries();
    expect(got).toEqual([
      { id: 'pl-a', name: 'Alpha' },
      { id: 'pl-b', name: 'Beta' },
    ]);
  });

  it('update persists only the patched fields', async () => {
    await repo.create('pl-1', {
      name: 'Old',
      description: 'old desc',
      prompts: [samplePrompt],
      promptOrder: [sampleOrder],
    });

    const updated = await repo.update('pl-1', { name: 'New', prompts: [] });

    expect(updated.name).toBe('New');
    expect(updated.prompts).toEqual([]);
    // Untouched fields survive.
    expect(updated.description).toBe('old desc');
    expect(updated.promptOrder).toEqual([sampleOrder]);

    const reread = await repo.getById('pl-1');
    expect(reread).toEqual(updated);
  });

  it('update throws for a missing id', async () => {
    // Note: a plain Error, not NotFoundError — pinned as-is (see source).
    await expect(repo.update('nope', { name: 'X' })).rejects.toThrow('Prompt list not found: nope');
  });

  it('delete removes the prompt list', async () => {
    await repo.create('pl-1', { name: 'X', description: '', prompts: [], promptOrder: [] });
    await repo.delete('pl-1');
    expect(await repo.getById('pl-1')).toBeUndefined();
  });

  it('delete throws NotFoundError for a missing id', async () => {
    await expect(repo.delete('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('count reflects the number of prompt lists', async () => {
    expect(await repo.count()).toBe(0);
    await repo.create('pl-1', { name: 'A', description: '', prompts: [], promptOrder: [] });
    await repo.create('pl-2', { name: 'B', description: '', prompts: [], promptOrder: [] });
    expect(await repo.count()).toBe(2);
  });
});
