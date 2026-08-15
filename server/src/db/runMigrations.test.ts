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

    expect(await userVersion(client)).toBe(17);

    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables.rows.map((r) => String(r.name));
    expect(names).toContain('characters');
    expect(names).toContain('chats');
    expect(names).toContain('messages');
    expect(names).toContain('message_parts');
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
    expect(await userVersion(client)).toBe(17);
    client.close();
  });

  it('recovers from a crash that left a column behind without bumping user_version', async () => {
    const client = makeClient();
    await applyMigrations(client);

    // Simulate a crash mid-002: column exists, version rolled back to 1.
    await client.execute('PRAGMA user_version = 1');
    await applyMigrations(client);

    expect(await userVersion(client)).toBe(17);
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

    expect(await userVersion(client)).toBe(17);

    const migrated = await client.execute("SELECT content, extra FROM messages WHERE role = 'user'");
    expect(String(migrated.rows[0]?.content)).toBe('');
    // 010 moved text into extra.parts; 015 (also re-run here) then moved the
    // parts into message_parts and stripped the blob.
    const migratedExtra = JSON.parse(String(migrated.rows[0]?.extra)) as Record<string, unknown>;
    expect(migratedExtra.parts).toBeUndefined();
    const migratedParts = await client.execute(
      "SELECT p.data FROM message_parts p JOIN messages m ON p.message_id = m.id WHERE m.role = 'user' ORDER BY p.idx",
    );
    expect(migratedParts.rows.map((r) => JSON.parse(String(r.data)))).toEqual([{ type: 'text', text: 'hello world' }]);

    const untouched = await client.execute("SELECT content, extra FROM messages WHERE role = 'assistant'");
    expect(String(untouched.rows[0]?.content)).toBe('already');

    client.close();
  });

  it('migration 015 moves extra.parts into message_parts and strips the blob', async () => {
    const client = makeClient();
    await applyMigrations(client);

    // Simulate a pre-015 row: parts inside the extra blob, other keys alongside.
    await client.execute({
      sql: "INSERT INTO messages (role, content, extra) VALUES ('assistant', '', ?)",
      args: [
        JSON.stringify({
          tokenCount: 3,
          parts: [
            { type: 'text', text: 'hi' },
            { type: 'reasoning', text: 'thinking' },
          ],
        }),
      ],
    });
    // ...and a row with no parts (must be left alone).
    await client.execute({
      sql: "INSERT INTO messages (role, content, extra) VALUES ('user', '', ?)",
      args: [JSON.stringify({ tokenCount: 1 })],
    });

    // Rewind to just before 015 and re-run.
    await client.execute('PRAGMA user_version = 14');
    await applyMigrations(client);

    expect(await userVersion(client)).toBe(17);

    const rows = await client.execute('SELECT idx, type, data FROM message_parts ORDER BY idx');
    expect(rows.rows.map((r) => [Number(r.idx), String(r.type)])).toEqual([
      [0, 'text'],
      [1, 'reasoning'],
    ]);
    expect(JSON.parse(String(rows.rows[1]?.data))).toEqual({ type: 'reasoning', text: 'thinking' });

    const assistant = await client.execute("SELECT extra FROM messages WHERE role = 'assistant'");
    const extra = JSON.parse(String(assistant.rows[0]?.extra)) as Record<string, unknown>;
    expect(extra).toEqual({ tokenCount: 3 });

    const user = await client.execute("SELECT extra FROM messages WHERE role = 'user'");
    expect(JSON.parse(String(user.rows[0]?.extra))).toEqual({ tokenCount: 1 });

    // Idempotent: re-running finds nothing to do.
    await client.execute('PRAGMA user_version = 14');
    await applyMigrations(client);
    const count = await client.execute('SELECT COUNT(*) as c FROM message_parts');
    expect(Number(count.rows[0]?.c)).toBe(2);

    client.close();
  });

  it('migration 016 moves legacy impersonation/memory prompts into every prompt list', async () => {
    const client = makeClient();
    await applyMigrations(client);

    // Simulate a pre-016 database: two prompt lists without the utility
    // prompts, and a settings blob with the legacy global keys.
    const legacyPrompts = [
      { identifier: 'main', name: 'Main Prompt', content: 'MAIN', role: 'system', enabled: true },
    ];
    for (const id of ['list-a', 'list-b']) {
      await client.execute({
        sql: "INSERT INTO prompt_lists (id, name, prompts_json, prompt_order_json) VALUES (?, ?, ?, '[]')",
        args: [id, `List ${id}`, JSON.stringify(legacyPrompts)],
      });
    }
    await client.execute({
      sql: 'INSERT INTO settings (id, blob) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET blob = excluded.blob',
      args: [
        JSON.stringify({
          impersonationPrompt: 'Custom impersonation.',
          memory: { enabled: true, systemPrompt: 'Custom summary prompt.', maxSummaryTokens: 256 },
        }),
      ],
    });

    // Rewind to just before 016 and re-run.
    await client.execute('PRAGMA user_version = 15');
    await applyMigrations(client);

    expect(await userVersion(client)).toBe(17);

    // Both lists gained both utility prompts with the legacy customizations.
    for (const id of ['list-a', 'list-b']) {
      const rs = await client.execute({ sql: 'SELECT prompts_json FROM prompt_lists WHERE id = ?', args: [id] });
      const prompts = JSON.parse(String(rs.rows[0]?.prompts_json)) as Array<{ identifier: string; content: string }>;
      expect(prompts.map((p) => p.identifier)).toEqual(['main', 'impersonation', 'memorySummary']);
      expect(prompts.find((p) => p.identifier === 'impersonation')?.content).toBe('Custom impersonation.');
      expect(prompts.find((p) => p.identifier === 'memorySummary')?.content).toBe('Custom summary prompt.');
    }

    // The legacy keys are gone from the settings blob; other memory fields survive.
    const settingsRow = await client.execute('SELECT blob FROM settings WHERE id = 0');
    const blob = JSON.parse(String(settingsRow.rows[0]?.blob)) as Record<string, unknown>;
    expect(blob.impersonationPrompt).toBeUndefined();
    const memory = blob.memory as Record<string, unknown>;
    expect(memory.systemPrompt).toBeUndefined();
    expect(memory.enabled).toBe(true);
    expect(memory.maxSummaryTokens).toBe(256);

    client.close();
  });

  it('migration 016 falls back to the builtin defaults without legacy customizations', async () => {
    const client = makeClient();
    await applyMigrations(client);

    await client.execute({
      sql: "INSERT INTO prompt_lists (id, name, prompts_json, prompt_order_json) VALUES ('list-c', 'List C', '[]', '[]')",
    });
    // No settings row at all.

    await client.execute('PRAGMA user_version = 15');
    await applyMigrations(client);

    const rs = await client.execute("SELECT prompts_json FROM prompt_lists WHERE id = 'list-c'");
    const prompts = JSON.parse(String(rs.rows[0]?.prompts_json)) as Array<{ identifier: string; content: string }>;
    const impersonation = prompts.find((p) => p.identifier === 'impersonation');
    const memorySummary = prompts.find((p) => p.identifier === 'memorySummary');
    expect(impersonation?.content).toContain('{{user}}');
    expect(memorySummary?.content).toContain('[msg:ID]');

    // Idempotent: re-running appends nothing.
    await client.execute('PRAGMA user_version = 15');
    await applyMigrations(client);
    const again = await client.execute("SELECT prompts_json FROM prompt_lists WHERE id = 'list-c'");
    expect(JSON.parse(String(again.rows[0]?.prompts_json))).toHaveLength(2);

    client.close();
  });

  it('migration 017 moves global claudeCache* settings into claude/openrouter backend configs', async () => {
    const client = makeClient();
    await applyMigrations(client);

    const { BackendConfigRepository } = await import('../repos/BackendConfigRepository.js');
    const repo = new BackendConfigRepository(client);
    const insert = (
      backendProvider: string,
      providerParams: Record<string, unknown>,
    ): import('@tamari/types').BackendConfigInsert => ({
      name: `Cfg ${backendProvider}`,
      description: '',
      backendProvider,
      generationMode: 'chat',
      model: 'model-1',
      instructTemplate: '',
      providerParams,
      stopStrings: [],
      openrouterProvider: null,
      logitBias: null,
    });
    await repo.create('cfg-claude', insert('claude', {}));
    // Already customized per config — must not be overwritten.
    await repo.create('cfg-or', insert('openrouter', { cacheMode: 'auto' }));
    await repo.create('cfg-openai', insert('openai', {}));

    // Simulate a pre-017 settings blob with the legacy global keys.
    await client.execute({
      sql: 'INSERT INTO settings (id, blob) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET blob = excluded.blob',
      args: [JSON.stringify({ claudeCacheMode: 'manual', claudeCacheDepth: 2, claudeCacheTTL: '1h', userName: 'Tester' })],
    });

    // Rewind to just before 017 and re-run.
    await client.execute('PRAGMA user_version = 16');
    await applyMigrations(client);

    expect(await userVersion(client)).toBe(17);

    const claude = await repo.getById('cfg-claude');
    expect(claude?.providerParams).toEqual({ cacheMode: 'manual', cacheDepth: 2, cacheTTL: '1h' });
    const openrouter = await repo.getById('cfg-or');
    expect(openrouter?.providerParams).toEqual({ cacheMode: 'auto', cacheDepth: 2, cacheTTL: '1h' });
    // Non-caching providers get nothing.
    const openai = await repo.getById('cfg-openai');
    expect(openai?.providerParams).toEqual({});

    // The globals are gone; unrelated settings survive.
    const settingsRow = await client.execute('SELECT blob FROM settings WHERE id = 0');
    const blob = JSON.parse(String(settingsRow.rows[0]?.blob)) as Record<string, unknown>;
    expect(blob.claudeCacheMode).toBeUndefined();
    expect(blob.claudeCacheDepth).toBeUndefined();
    expect(blob.claudeCacheTTL).toBeUndefined();
    expect(blob.userName).toBe('Tester');

    // Idempotent: re-running changes nothing.
    await client.execute('PRAGMA user_version = 16');
    await applyMigrations(client);
    expect((await repo.getById('cfg-claude'))?.providerParams).toEqual({
      cacheMode: 'manual',
      cacheDepth: 2,
      cacheTTL: '1h',
    });

    client.close();
  });

  it('migration 017 is a no-op without the legacy globals', async () => {
    const client = makeClient();
    await applyMigrations(client);

    const { BackendConfigRepository } = await import('../repos/BackendConfigRepository.js');
    const repo = new BackendConfigRepository(client);
    await repo.create('cfg-claude', {
      name: 'Claude',
      description: '',
      backendProvider: 'claude',
      generationMode: 'chat' as const,
      model: 'model-1',
      instructTemplate: '',
      providerParams: {},
      stopStrings: [],
      openrouterProvider: null,
      logitBias: null,
    });

    // No settings row at all.
    await client.execute('PRAGMA user_version = 16');
    await applyMigrations(client);

    expect((await repo.getById('cfg-claude'))?.providerParams).toEqual({});
    // No settings row was created either.
    const settingsRow = await client.execute('SELECT blob FROM settings WHERE id = 0');
    expect(settingsRow.rows.length).toBe(0);

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
