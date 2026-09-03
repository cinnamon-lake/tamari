/**
 * 021_word_ids — backfill migration test.
 *
 * Applies the real production migrations against a temp-dir libsql client
 * (021 itself runs there on an empty DB and no-ops), seeds every remapped
 * table with UUID ids + on-disk files, then invokes the migration's `up()`
 * directly — twice, to prove idempotency.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { applyMigrations } from '../runMigrations.js';
import migration from './021_word_ids.js';

const WORD_ID = /^[a-z]+(-[a-z]+){3}$/;

// Fixed legacy UUIDs.
const WI_BOOK = '11111111-1111-4111-8111-111111111111';
const WI_EMPTY = '11111111-2222-4111-8111-111111111111';
const WI_ENTRY1 = '11111111-3333-4111-8111-111111111111';
const WI_ENTRY2 = '11111111-4444-4111-8111-111111111111';
const CHAR1 = '22222222-1111-4111-8111-111111111111';
const CHAR2 = '22222222-2222-4111-8111-111111111111';
const CHAR_UNPACKED = 'unpacked/foo';
const PERSONA1 = '33333333-1111-4111-8111-111111111111';
const CHAT1 = '44444444-1111-4111-8111-111111111111';
const CHAT2 = '44444444-2222-4111-8111-111111111111';
const GEN1 = '55555555-1111-4111-8111-111111111111';
const GEN2 = '55555555-2222-4111-8111-111111111111';
const ATT1 = '66666666-1111-4111-8111-111111111111';
const ATT2 = '66666666-2222-4111-8111-111111111111';
const ASSET1 = '77777777-1111-4111-8111-111111111111';
const QR_CHAR = '88888888-1111-4111-8111-111111111111';
const QR_CHAT = '88888888-2222-4111-8111-111111111111';
const QR_GLOBAL = '88888888-3333-4111-8111-111111111111';
const CFG1 = '99999999-1111-4111-8111-111111111111';
const CFG2 = '99999999-2222-4111-8111-111111111111';
const LIST1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const CUSTOM1 = 'bbbbbbbb-1111-4111-8111-111111111111';
const TPL1 = 'cccccccc-1111-4111-8111-111111111111';
const TOOLSET1 = 'dddddddd-1111-4111-8111-111111111111';
const SCRIPT1 = 'eeeeeeee-1111-4111-8111-111111111111';
const SCRIPT_PLAIN = 'my-script';
const CHAIN1 = 'ffffffff-1111-4111-8111-111111111111';
const REGEX1 = '12345678-1111-4111-8111-111111111111';

let db: Client;
let dataDir: string;

async function seed(): Promise<void> {
  // world_info (book with entries + an empty book)
  await db.execute({
    sql: 'INSERT INTO world_info (id, name, entries) VALUES (?, ?, ?)',
    args: [
      WI_BOOK,
      'Book One',
      JSON.stringify([
        { id: WI_ENTRY1, keys: ['alpha'], content: 'entry one' },
        { id: WI_ENTRY2, keys: ['beta'], content: 'entry two' },
        { id: 'custom-entry', keys: [], content: 'kept as-is' },
      ]),
    ],
  });
  await db.execute({ sql: 'INSERT INTO world_info (id, name) VALUES (?, ?)', args: [WI_EMPTY, 'Empty Book'] });

  // characters: one fully-linked, one bare, one non-UUID (unpacked)
  await db.execute({
    sql: 'INSERT INTO characters (id, name, world_info_id, extensions) VALUES (?, ?, ?, ?)',
    args: [
      CHAR1,
      'Alice',
      WI_BOOK,
      JSON.stringify({
        regexScripts: [
          { id: REGEX1, findRegex: '/a/', replaceString: 'b' },
          { id: 'plain-rule', findRegex: '/c/', replaceString: 'd' },
        ],
        risuModules: [
          { id: 'mod-1', name: 'Mod', source: 'attached', filePath: `files/character_modules/${CHAR1}/mod-1.json` },
        ],
      }),
    ],
  });
  await db.execute({ sql: 'INSERT INTO characters (id, name) VALUES (?, ?)', args: [CHAR2, 'Bob'] });
  await db.execute({ sql: 'INSERT INTO characters (id, name) VALUES (?, ?)', args: [CHAR_UNPACKED, 'Unpacked'] });

  await db.execute({ sql: 'INSERT INTO personas (id, name) VALUES (?, ?)', args: [PERSONA1, 'User'] });

  // chats: one linked, one forked from it
  await db.execute({
    sql: 'INSERT INTO chats (id, character_id, persona_id, name) VALUES (?, ?, ?, ?)',
    args: [CHAT1, CHAR1, PERSONA1, 'Chat 1'],
  });
  await db.execute({
    sql: 'INSERT INTO chats (id, character_id, forked_from_chat_id, name) VALUES (?, ?, ?, ?)',
    args: [CHAT2, CHAR2, CHAT1, 'Fork'],
  });

  await db.execute({ sql: 'INSERT INTO chat_members (chat_id, character_id) VALUES (?, ?)', args: [CHAT1, CHAR1] });
  await db.execute({ sql: 'INSERT INTO chat_members (chat_id, character_id) VALUES (?, ?)', args: [CHAT1, CHAR2] });

  const msg = await db.execute({ sql: "INSERT INTO messages (role, content) VALUES ('user', 'hello')" });
  const messageId = Number(msg.lastInsertRowid ?? 0);

  await db.execute({
    sql: "INSERT INTO generations (id, chat_id, status, backend) VALUES (?, ?, 'complete', 'openai')",
    args: [GEN1, CHAT1],
  });
  await db.execute({
    sql: "INSERT INTO generations (id, chat_id, status, backend, parent_id) VALUES (?, ?, 'complete', 'openai', ?)",
    args: [GEN2, CHAT1, GEN1],
  });

  // attachments + files (one with extension, one without)
  mkdirSync(join(dataDir, 'files', 'attachments'), { recursive: true });
  writeFileSync(join(dataDir, 'files', 'attachments', `${ATT1}.png`), 'png-bytes');
  writeFileSync(join(dataDir, 'files', 'attachments', ATT2), 'raw-bytes');
  await db.execute({
    sql: "INSERT INTO attachments (id, message_id, mime_type, file_path) VALUES (?, ?, 'image/png', ?)",
    args: [ATT1, messageId, `files/attachments/${ATT1}.png`],
  });
  await db.execute({
    sql: "INSERT INTO attachments (id, message_id, mime_type, file_path) VALUES (?, ?, 'application/octet-stream', ?)",
    args: [ATT2, messageId, `files/attachments/${ATT2}`],
  });

  // character asset + file
  mkdirSync(join(dataDir, 'files', 'character_assets', CHAR1), { recursive: true });
  writeFileSync(join(dataDir, 'files', 'character_assets', CHAR1, `${ASSET1}.png`), 'asset-bytes');
  await db.execute({
    sql: "INSERT INTO character_assets (id, character_id, name, ext, file_path) VALUES (?, ?, 'logo', 'png', ?)",
    args: [ASSET1, CHAR1, `files/character_assets/${CHAR1}/${ASSET1}.png`],
  });

  // character modules dir (referenced from extensions.risuModules[].filePath)
  mkdirSync(join(dataDir, 'files', 'character_modules', CHAR1), { recursive: true });
  writeFileSync(join(dataDir, 'files', 'character_modules', CHAR1, 'mod-1.json'), '{}');

  // quick replies in all three scopes
  await db.execute({
    sql: "INSERT INTO quick_replies (id, scope, scope_id, label) VALUES (?, 'character', ?, 'QR char')",
    args: [QR_CHAR, CHAR1],
  });
  await db.execute({
    sql: "INSERT INTO quick_replies (id, scope, scope_id, label) VALUES (?, 'chat', ?, 'QR chat')",
    args: [QR_CHAT, CHAT1],
  });
  await db.execute({
    sql: "INSERT INTO quick_replies (id, scope, scope_id, label) VALUES (?, 'global', '', 'QR global')",
    args: [QR_GLOBAL],
  });

  await db.execute({ sql: 'INSERT INTO backend_configs (id, name) VALUES (?, ?)', args: [CFG1, 'Main'] });
  await db.execute({
    sql: 'INSERT INTO backend_configs (id, name, transformer_chain_id) VALUES (?, ?, ?)',
    args: [CFG2, 'Chained', CHAIN1],
  });
  await db.execute({ sql: 'INSERT INTO prompt_lists (id, name) VALUES (?, ?)', args: [LIST1, 'List'] });
  await db.execute({
    sql: 'INSERT INTO custom_backends (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)',
    args: [CUSTOM1, 'Custom'],
  });
  await db.execute({ sql: "INSERT INTO tool_templates (id, name, code) VALUES (?, ?, '')", args: [TPL1, 'Tpl'] });
  await db.execute({
    sql: 'INSERT INTO toolsets (id, template_id, name) VALUES (?, ?, ?)',
    args: [TOOLSET1, TPL1, 'Set'],
  });
  await db.execute({
    sql: 'INSERT INTO transformer_scripts (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)',
    args: [SCRIPT1, 'Script'],
  });
  await db.execute({
    sql: 'INSERT INTO transformer_scripts (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)',
    args: [SCRIPT_PLAIN, 'Plain'],
  });
  await db.execute({
    sql: 'INSERT INTO transformer_chains (id, name, steps_json, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
    args: [
      CHAIN1,
      'Chain',
      JSON.stringify([
        { kind: 'builtin', id: 'whitespace', enabled: true, params: { mode: 'trim' } },
        { kind: 'lua', scriptId: SCRIPT1, enabled: true },
      ]),
    ],
  });

  // extension_data: character + chat remapped, message + global untouched
  await db.execute({
    sql: "INSERT INTO extension_data (extension_id, entity_type, entity_id) VALUES ('ext', 'character', ?)",
    args: [CHAR1],
  });
  await db.execute({
    sql: "INSERT INTO extension_data (extension_id, entity_type, entity_id) VALUES ('ext', 'chat', ?)",
    args: [CHAT1],
  });
  await db.execute({
    sql: "INSERT INTO extension_data (extension_id, entity_type, entity_id) VALUES ('ext', 'message', '42')",
  });
  await db.execute({
    sql: "INSERT INTO extension_data (extension_id, entity_type, entity_id) VALUES ('ext', 'global', '')",
  });

  await db.execute({
    sql: 'INSERT INTO settings (id, blob) VALUES (0, ?)',
    args: [
      JSON.stringify({
        activeBackendConfigId: CFG1,
        activePromptListId: LIST1,
        defaultPersonaId: PERSONA1,
        lastChatId: CHAT1,
        memory: { enabled: true, backendConfigId: CFG2 },
        theme: 'dark',
      }),
    ],
  });
}

async function scalar(sql: string, args: string[] = []): Promise<unknown> {
  const rs = await db.execute({ sql, args });
  const row = rs.rows[0];
  return row?.[1];
}

async function idByName(table: string, name: string): Promise<string> {
  const value = await scalar(`SELECT 1, id FROM ${table} WHERE name = ?`, [name]);
  expect(typeof value).toBe('string');
  return String(value);
}

function snapshotFiles(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, snapshotFiles(full, relPath));
    else out[relPath] = readFileSync(full, 'utf-8');
  }
  return out;
}

const DUMP_TABLES = [
  'characters',
  'world_info',
  'personas',
  'chats',
  'chat_members',
  'generations',
  'attachments',
  'character_assets',
  'quick_replies',
  'backend_configs',
  'prompt_lists',
  'custom_backends',
  'tool_templates',
  'toolsets',
  'transformer_scripts',
  'transformer_chains',
  'extension_data',
  'settings',
];

async function snapshotDb(): Promise<Record<string, unknown[]>> {
  const dump: Record<string, unknown[]> = {};
  for (const table of DUMP_TABLES) {
    const rs = await db.execute(`SELECT * FROM ${table} ORDER BY 1, 2`);
    dump[table] = JSON.parse(JSON.stringify(rs.rows)) as unknown[];
  }
  return dump;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'st-mig021-'));
  db = createClient({ url: `file:${join(dataDir, 'test.db')}` });
  await db.execute('PRAGMA foreign_keys = ON');
  // Full production schema. 021 runs here on the empty DB and no-ops; the
  // real backfill is invoked manually below so it can run with a dataDir.
  await applyMigrations(db);
  await seed();
  await migration.up({ db, dataDir });
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('migration 021_word_ids', () => {
  it('remaps every UUID primary key to a word-id and leaves other id formats alone', async () => {
    const untouched: Record<string, string[]> = {
      characters: [CHAR_UNPACKED],
      transformer_scripts: [SCRIPT_PLAIN],
      transformer_chains: ['default'], // seeded by migration 020
    };
    for (const table of DUMP_TABLES) {
      if (table === 'chat_members' || table === 'extension_data' || table === 'settings') continue;
      const rs = await db.execute(`SELECT id FROM ${table}`);
      for (const row of rs.rows) {
        const id = String(row.id);
        if ((untouched[table] ?? []).includes(id)) continue;
        expect(id, `${table}.id`).toMatch(WORD_ID);
      }
    }
    // untouched rows are still present
    expect(await idByName('characters', 'Unpacked')).toBe(CHAR_UNPACKED);
    expect(await idByName('transformer_scripts', 'Plain')).toBe(SCRIPT_PLAIN);
  });

  it('remaps all referencing columns consistently', async () => {
    const char1 = await idByName('characters', 'Alice');
    const char2 = await idByName('characters', 'Bob');
    const persona = await idByName('personas', 'User');
    const chat1 = await idByName('chats', 'Chat 1');
    const chat2 = await idByName('chats', 'Fork');
    const book = await idByName('world_info', 'Book One');
    const chain = await idByName('transformer_chains', 'Chain');
    const script = await idByName('transformer_scripts', 'Script');
    const template = await idByName('tool_templates', 'Tpl');
    const toolset = await idByName('toolsets', 'Set');

    // characters.world_info_id
    expect(await scalar('SELECT 1, world_info_id FROM characters WHERE id = ?', [char1])).toBe(book);
    // chats: character, persona, fork link
    expect(await scalar('SELECT 1, character_id FROM chats WHERE id = ?', [chat1])).toBe(char1);
    expect(await scalar('SELECT 1, persona_id FROM chats WHERE id = ?', [chat1])).toBe(persona);
    expect(await scalar('SELECT 1, forked_from_chat_id FROM chats WHERE id = ?', [chat2])).toBe(chat1);
    // chat_members
    const members = await db.execute({
      sql: 'SELECT character_id FROM chat_members WHERE chat_id = ? ORDER BY 1',
      args: [chat1],
    });
    expect(members.rows.map((r) => String(r.character_id))).toEqual([char1, char2].sort());
    // generations: chat link + parent chain
    const gen1 = await scalar('SELECT 1, id FROM generations WHERE parent_id IS NULL AND chat_id = ?', [chat1]);
    expect(String(gen1)).toMatch(WORD_ID);
    const gen2 = await scalar('SELECT 1, id FROM generations WHERE parent_id IS NOT NULL');
    expect(await scalar('SELECT 1, parent_id FROM generations WHERE id = ?', [String(gen2)])).toBe(gen1);
    expect(await scalar('SELECT 1, chat_id FROM generations WHERE id = ?', [String(gen2)])).toBe(chat1);
    // backend config → chain
    expect(await scalar("SELECT 1, transformer_chain_id FROM backend_configs WHERE name = 'Chained'")).toBe(chain);
    // toolset → template
    expect(toolset).toMatch(WORD_ID);
    expect(await scalar('SELECT 1, template_id FROM toolsets WHERE id = ?', [toolset])).toBe(template);
    // chain steps_json scriptId
    const stepsRaw = await scalar('SELECT 1, steps_json FROM transformer_chains WHERE id = ?', [chain]);
    const steps = JSON.parse(String(stepsRaw)) as Array<Record<string, unknown>>;
    expect(steps[1]?.['scriptId']).toBe(script);
    expect(steps[0]?.['id']).toBe('whitespace'); // builtin untouched
  });

  it('remaps quick_replies by scope', async () => {
    const char1 = await idByName('characters', 'Alice');
    const chat1 = await idByName('chats', 'Chat 1');
    expect(await scalar("SELECT 1, scope_id FROM quick_replies WHERE label = 'QR char'")).toBe(char1);
    expect(await scalar("SELECT 1, scope_id FROM quick_replies WHERE label = 'QR chat'")).toBe(chat1);
    expect(await scalar("SELECT 1, scope_id FROM quick_replies WHERE label = 'QR global'")).toBe('');
  });

  it('remaps extension_data by entity_type and leaves message/global alone', async () => {
    const char1 = await idByName('characters', 'Alice');
    const chat1 = await idByName('chats', 'Chat 1');
    const rs = await db.execute("SELECT entity_type, entity_id FROM extension_data WHERE extension_id = 'ext'");
    const byType = new Map(rs.rows.map((r) => [String(r.entity_type), String(r.entity_id)]));
    expect(byType.get('character')).toBe(char1);
    expect(byType.get('chat')).toBe(chat1);
    expect(byType.get('message')).toBe('42');
    expect(byType.get('global')).toBe('');
  });

  it('remaps id-holding settings keys', async () => {
    const blob = JSON.parse(String(await scalar('SELECT 1, blob FROM settings WHERE id = 0'))) as Record<
      string,
      unknown
    >;
    expect(blob['activeBackendConfigId']).toBe(await idByName('backend_configs', 'Main'));
    expect(blob['activePromptListId']).toBe(await idByName('prompt_lists', 'List'));
    expect(blob['defaultPersonaId']).toBe(await idByName('personas', 'User'));
    expect(blob['lastChatId']).toBe(await idByName('chats', 'Chat 1'));
    expect((blob['memory'] as Record<string, unknown>)['backendConfigId']).toBe(
      await idByName('backend_configs', 'Chained'),
    );
    expect(blob['theme']).toBe('dark'); // unrelated keys untouched
  });

  it('remaps embedded JSON ids in world_info entries and character regexScripts', async () => {
    const book = await idByName('world_info', 'Book One');
    const entries = JSON.parse(String(await scalar('SELECT 1, entries FROM world_info WHERE id = ?', [book]))) as Array<
      Record<string, unknown>
    >;
    expect(entries.map((e) => e['id'])).toHaveLength(3);
    expect(entries[0]?.['id']).toMatch(WORD_ID);
    expect(entries[1]?.['id']).toMatch(WORD_ID);
    expect(entries[2]?.['id']).toBe('custom-entry');
    expect(entries[0]?.['content']).toBe('entry one');

    const char1 = await idByName('characters', 'Alice');
    const extensions = JSON.parse(
      String(await scalar('SELECT 1, extensions FROM characters WHERE id = ?', [char1])),
    ) as Record<string, unknown>;
    const rules = extensions['regexScripts'] as Array<Record<string, unknown>>;
    expect(rules[0]?.['id']).toMatch(WORD_ID);
    expect(rules[1]?.['id']).toBe('plain-rule');
    const modules = extensions['risuModules'] as Array<Record<string, unknown>>;
    expect(modules[0]?.['filePath']).toBe(`files/character_modules/${char1}/mod-1.json`);
  });

  it('renames files on disk and updates file_path columns', async () => {
    const char1 = await idByName('characters', 'Alice');

    // attachments
    const att1 = String(await scalar("SELECT 1, id FROM attachments WHERE mime_type = 'image/png'"));
    const att2 = String(await scalar("SELECT 1, id FROM attachments WHERE mime_type = 'application/octet-stream'"));
    expect(att1).toMatch(WORD_ID);
    expect(await scalar('SELECT 1, file_path FROM attachments WHERE id = ?', [att1])).toBe(
      `files/attachments/${att1}.png`,
    );
    expect(await scalar('SELECT 1, file_path FROM attachments WHERE id = ?', [att2])).toBe(`files/attachments/${att2}`);
    expect(readFileSync(join(dataDir, 'files', 'attachments', `${att1}.png`), 'utf-8')).toBe('png-bytes');
    expect(readFileSync(join(dataDir, 'files', 'attachments', att2), 'utf-8')).toBe('raw-bytes');
    expect(existsSync(join(dataDir, 'files', 'attachments', `${ATT1}.png`))).toBe(false);

    // character asset: both path segments renamed
    const asset = String(await scalar("SELECT 1, id FROM character_assets WHERE name = 'logo'"));
    expect(asset).toMatch(WORD_ID);
    expect(await scalar('SELECT 1, character_id FROM character_assets WHERE id = ?', [asset])).toBe(char1);
    expect(await scalar('SELECT 1, file_path FROM character_assets WHERE id = ?', [asset])).toBe(
      `files/character_assets/${char1}/${asset}.png`,
    );
    expect(readFileSync(join(dataDir, 'files', 'character_assets', char1, `${asset}.png`), 'utf-8')).toBe(
      'asset-bytes',
    );
    expect(existsSync(join(dataDir, 'files', 'character_assets', CHAR1))).toBe(false);

    // character modules dir renamed
    expect(existsSync(join(dataDir, 'files', 'character_modules', char1, 'mod-1.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'files', 'character_modules', CHAR1))).toBe(false);
  });

  it('wrote a database backup and leaves foreign keys intact', async () => {
    expect(existsSync(join(dataDir, 'tamari.db.pre-wordids.bak'))).toBe(true);
    const violations = await db.execute('PRAGMA foreign_key_check');
    expect(violations.rows).toEqual([]);
    const fk = await db.execute('PRAGMA foreign_keys');
    expect(Number(fk.rows[0]?.[0])).toBe(1);
  });

  it('is a no-op on a second run', async () => {
    const beforeDb = await snapshotDb();
    const beforeFiles = snapshotFiles(join(dataDir, 'files'));
    await migration.up({ db, dataDir });
    expect(await snapshotDb()).toEqual(beforeDb);
    expect(snapshotFiles(join(dataDir, 'files'))).toEqual(beforeFiles);
  });
});

describe('migration 021_word_ids without dataDir', () => {
  it('still rewrites the database and skips filesystem work', async () => {
    // File-backed (not ':memory:') so migration transactions share one DB.
    const noFsDir = mkdtempSync(join(tmpdir(), 'st-mig021-nofs-'));
    const noDirDb = createClient({ url: `file:${join(noFsDir, 'test.db')}` });
    try {
      await applyMigrations(noDirDb);
      await noDirDb.execute({ sql: 'INSERT INTO characters (id, name) VALUES (?, ?)', args: [CHAR1, 'Solo'] });
      await noDirDb.execute({
        sql: "INSERT INTO attachments (id, mime_type, file_path) VALUES (?, 'image/png', ?)",
        args: [ATT1, `files/attachments/${ATT1}.png`],
      });
      await migration.up({ db: noDirDb });
      const charId = String((await noDirDb.execute('SELECT id FROM characters')).rows[0]?.id);
      expect(charId).toMatch(WORD_ID);
      const attId = String((await noDirDb.execute('SELECT id FROM attachments')).rows[0]?.id);
      expect(attId).toMatch(WORD_ID);
      expect((await noDirDb.execute('SELECT file_path FROM attachments')).rows[0]?.file_path).toBe(
        `files/attachments/${attId}.png`,
      );
      const violations = await noDirDb.execute('PRAGMA foreign_key_check');
      expect(violations.rows).toEqual([]);
    } finally {
      noDirDb.close();
      rmSync(noFsDir, { recursive: true, force: true });
    }
  });
});
