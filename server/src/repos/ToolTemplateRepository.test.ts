import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolTemplateRepository } from './ToolTemplateRepository.js';
import { NotFoundError } from '../errors.js';

let client: Client;
let repo: ToolTemplateRepository;
let tmpDir: string;

// Mirror the production `tool_templates` DDL (db/migrations/001_init.sql plus
// 003_tool_template_sandbox.sql's sandbox column).
async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS tool_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      config_schema TEXT DEFAULT '{}',
      sandbox TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-tooltmpl-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  await initSchema();
  repo = new ToolTemplateRepository(client);
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM tool_templates');
});

describe('ToolTemplateRepository', () => {
  it('create + getById round-trips a template', async () => {
    const created = await repo.create('tt-1', {
      name: 'Dice',
      code: 'return {}',
      configSchema: { sides: { type: 'number' } },
      sandbox: { allowOs: true },
    });

    expect(created).toMatchObject({
      id: 'tt-1',
      name: 'Dice',
      code: 'return {}',
      configSchema: { sides: { type: 'number' } },
      sandbox: { allowOs: true },
    });
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);

    const reread = await repo.getById('tt-1');
    expect(reread).toEqual(created);
  });

  it('create applies defensive defaults for missing configSchema/sandbox', async () => {
    // Cast: the repo deliberately tolerates unvalidated API input (see the
    // eslint-disable in the source).
    const created = await repo.create('tt-2', {
      name: 'Bare',
      code: 'x',
    } as unknown as Parameters<ToolTemplateRepository['create']>[1]);

    expect(created.configSchema).toEqual({});
    expect(created.sandbox).toEqual({});
  });

  it('getById returns undefined for a missing id', async () => {
    expect(await repo.getById('nope')).toBeUndefined();
  });

  it('falls back to {} when config_schema or sandbox hold corrupt JSON', async () => {
    await client.execute({
      sql: `INSERT INTO tool_templates (id, name, code, config_schema, sandbox, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ['bad-json', 'Bad', 'x', '{oops', 'not json', 1000, 1000],
    });

    const got = await repo.getById('bad-json');
    expect(got?.configSchema).toEqual({});
    expect(got?.sandbox).toEqual({});
  });

  it('list orders by created_at DESC', async () => {
    await client.execute({
      sql: `INSERT INTO tool_templates (id, name, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: ['older', 'O', 'x', 1000, 1000],
    });
    await client.execute({
      sql: `INSERT INTO tool_templates (id, name, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: ['newer', 'N', 'x', 2000, 2000],
    });

    const got = await repo.list();
    expect(got.map((t) => t.id)).toEqual(['newer', 'older']);
  });

  it('list skips a corrupt row instead of failing the whole read (mapRowsLenient)', async () => {
    await repo.create('good', { name: 'Good', code: 'x', configSchema: {}, sandbox: {} });
    // TEXT in the INTEGER created_at column fails ToolTemplateRowSchema.
    await client.execute({
      sql: `INSERT INTO tool_templates (id, name, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: ['corrupt', 'C', 'x', 'oops', 1000],
    });

    const got = await repo.list();
    expect(got.map((t) => t.id)).toEqual(['good']);
  });

  it('update persists only the patched fields', async () => {
    const created = await repo.create('tt-1', {
      name: 'Old',
      code: 'old code',
      configSchema: { a: 1 },
      sandbox: {},
    });

    const updated = await repo.update('tt-1', { code: 'new code', sandbox: { allowNet: true } });

    expect(updated.code).toBe('new code');
    expect(updated.sandbox).toEqual({ allowNet: true });
    // Untouched fields survive.
    expect(updated.name).toBe('Old');
    expect(updated.configSchema).toEqual({ a: 1 });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    const reread = await repo.getById('tt-1');
    expect(reread).toEqual(updated);
  });

  it('update throws NotFoundError for a missing id', async () => {
    await expect(repo.update('nope', { name: 'X' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete removes the template', async () => {
    await repo.create('tt-1', { name: 'X', code: 'x', configSchema: {}, sandbox: {} });
    await repo.delete('tt-1');
    expect(await repo.getById('tt-1')).toBeUndefined();
  });

  it('delete throws NotFoundError for a missing id', async () => {
    await expect(repo.delete('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
