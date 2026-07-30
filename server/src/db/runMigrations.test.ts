import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { applyMigrations } from './runMigrations.js';

let tmpDir: string | null = null;

function makeClient(): Client {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-migrate-test-'));
  return createClient({ url: `file:${join(tmpDir, 'test.db')}` });
}

async function userVersion(client: Client): Promise<number> {
  const rs = await client.execute('PRAGMA user_version');
  return Number(rs.rows[0]?.user_version ?? 0);
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('applyMigrations', () => {
  it('applies all migrations from scratch', async () => {
    const client = makeClient();
    await applyMigrations(client);

    expect(await userVersion(client)).toBe(6);

    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables.rows.map((r) => String(r.name));
    expect(names).toContain('characters');
    expect(names).toContain('chats');
    expect(names).toContain('messages');
    expect(names).toContain('tool_templates');

    // 002 / 003 columns landed.
    const chatCols = await client.execute("SELECT name FROM pragma_table_info('chats')");
    expect(chatCols.rows.map((r) => String(r.name))).toContain('materialized');
    const templateCols = await client.execute("SELECT name FROM pragma_table_info('tool_templates')");
    expect(templateCols.rows.map((r) => String(r.name))).toContain('sandbox');

    // 005 columns landed.
    const generationCols = await client.execute("SELECT name FROM pragma_table_info('generations')");
    const generationColNames = generationCols.rows.map((r) => String(r.name));
    expect(generationColNames).toContain('kind');
    expect(generationColNames).toContain('parent_id');

    // 006 column landed.
    const toolsetCols = await client.execute("SELECT name FROM pragma_table_info('toolsets')");
    expect(toolsetCols.rows.map((r) => String(r.name))).toContain('agent_visible');

    client.close();
  });

  it('is idempotent on an already-migrated database', async () => {
    const client = makeClient();
    await applyMigrations(client);
    // Second run must be a no-op: no errors, version unchanged.
    await applyMigrations(client);
    expect(await userVersion(client)).toBe(6);
    client.close();
  });

  it('recovers from a crash that left a column behind without bumping user_version', async () => {
    const client = makeClient();
    await applyMigrations(client);

    // Simulate a crash mid-002: column exists, version rolled back to 1.
    await client.execute('PRAGMA user_version = 1');
    await applyMigrations(client);

    expect(await userVersion(client)).toBe(6);
    // 002's ALTER was tolerated as duplicate and its UPDATE re-ran cleanly.
    const rs = await client.execute("SELECT name FROM pragma_table_info('chats')");
    expect(rs.rows.map((r) => String(r.name))).toContain('materialized');
    client.close();
  });
});
