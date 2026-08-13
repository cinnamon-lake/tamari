import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { applyMigrations } from './runMigrations.js';

let tmpDir: string | null = null;

function makeClient(): Client {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-migrate-test-'));
  return createClient({ url: `file:${join(tmpDir, 'test.db')}` });
}

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'st-migrate-fixtures-'));
  // So Node treats fixture .js files as ESM.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return dir;
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

    expect(await userVersion(client)).toBe(13);

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

    // 007 column landed.
    const generationMetaCols = await client.execute("SELECT name FROM pragma_table_info('generations')");
    expect(generationMetaCols.rows.map((r) => String(r.name))).toContain('meta');

    // Code migrations 009-013 are no-ops on a fresh database.
    const backendConfigCount = await client.execute('SELECT COUNT(*) as count FROM backend_configs');
    expect(Number(backendConfigCount.rows[0]?.count ?? 0)).toBe(0);

    client.close();
  });

  it('is idempotent on an already-migrated database', async () => {
    const client = makeClient();
    await applyMigrations(client);
    // Second run must be a no-op: no errors, version unchanged.
    await applyMigrations(client);
    expect(await userVersion(client)).toBe(13);
    client.close();
  });

  it('recovers from a crash that left a column behind without bumping user_version', async () => {
    const client = makeClient();
    await applyMigrations(client);

    // Simulate a crash mid-002: column exists, version rolled back to 1.
    await client.execute('PRAGMA user_version = 1');
    await applyMigrations(client);

    expect(await userVersion(client)).toBe(13);
    // 002's ALTER was tolerated as duplicate and its UPDATE re-ran cleanly.
    const rs = await client.execute("SELECT name FROM pragma_table_info('chats')");
    expect(rs.rows.map((r) => String(r.name))).toContain('materialized');
    client.close();
  });

  it('migration 010 moves legacy message content into extra.parts', async () => {
    const client = makeClient();
    await applyMigrations(client);

    // Simulate a pre-010 row: text in `content`, no parts.
    await client.execute({
      sql: "INSERT INTO messages (role, content, extra) VALUES ('user', 'hello world', '{}')",
    });
    // ...and a row that already has parts (must be left alone).
    await client.execute({
      sql: "INSERT INTO messages (role, content, extra) VALUES ('assistant', 'already', ?)",
      args: [JSON.stringify({ parts: [{ type: 'text', text: 'already' }] })],
    });

    // Rewind to just before 010 and re-run.
    await client.execute('PRAGMA user_version = 9');
    await applyMigrations(client);

    expect(await userVersion(client)).toBe(13);

    const migrated = await client.execute("SELECT content, extra FROM messages WHERE role = 'user'");
    expect(String(migrated.rows[0]?.content)).toBe('');
    const extra = JSON.parse(String(migrated.rows[0]?.extra)) as { parts: { type: string; text: string }[] };
    expect(extra.parts).toEqual([{ type: 'text', text: 'hello world' }]);

    const untouched = await client.execute("SELECT content, extra FROM messages WHERE role = 'assistant'");
    expect(String(untouched.rows[0]?.content)).toBe('already');

    client.close();
  });
});

describe('applyMigrations with code migrations (fixture dir)', () => {
  it('interleaves .sql and code migrations in version order', async () => {
    const client = makeClient();
    const dir = makeFixtureDir();

    writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT);');
    writeFileSync(
      join(dir, '002_seed.js'),
      `export default {
        async up({ db }) {
          await db.execute("INSERT INTO widget (name) VALUES ('from-code')");
        },
      };`,
    );
    writeFileSync(join(dir, '003_flag.sql'), 'ALTER TABLE widget ADD COLUMN flag INTEGER DEFAULT 0;');

    await applyMigrations(client, { migrationsDir: dir });

    expect(await userVersion(client)).toBe(3);
    const rs = await client.execute('SELECT name, flag FROM widget');
    expect(rs.rows.length).toBe(1);
    expect(String(rs.rows[0]?.name)).toBe('from-code');
    expect(Number(rs.rows[0]?.flag)).toBe(0);

    rmSync(dir, { recursive: true, force: true });
    client.close();
  });

  it('aborts without bumping user_version when a code migration throws', async () => {
    const client = makeClient();
    const dir = makeFixtureDir();

    writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE widget (id INTEGER PRIMARY KEY);');
    writeFileSync(
      join(dir, '002_broken.js'),
      `export default {
        async up() {
          throw new Error('boom');
        },
      };`,
    );

    await expect(applyMigrations(client, { migrationsDir: dir })).rejects.toThrow('boom');
    // 001 committed, 002 did not — the retry will re-run 002.
    expect(await userVersion(client)).toBe(1);

    rmSync(dir, { recursive: true, force: true });
    client.close();
  });

  it('rejects a code migration without an up() export', async () => {
    const client = makeClient();
    const dir = makeFixtureDir();

    writeFileSync(join(dir, '001_notamigration.js'), 'export default {};');

    await expect(applyMigrations(client, { migrationsDir: dir })).rejects.toThrow(/up\(\)/);
    expect(await userVersion(client)).toBe(0);

    rmSync(dir, { recursive: true, force: true });
    client.close();
  });
});
