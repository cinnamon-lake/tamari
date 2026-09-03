/**
 * 021 — backfill word-ids (`willing-bent-removal-contact`) over legacy UUID
 * entity ids.
 *
 * Rewrites the primary keys of every LLM-addressable entity table plus all
 * columns and JSON blobs that reference them:
 *   - FK columns (characters.world_info_id, chats.*, chat_members.*,
 *     generations.chat_id/parent_id, character_assets.character_id,
 *     backend_configs.transformer_chain_id, toolsets.template_id)
 *   - quick_replies.scope_id (resolved via the row's `scope`),
 *     extension_data.entity_id (resolved via `entity_type`)
 *   - id-holding settings keys (activeBackendConfigId, activePromptListId,
 *     defaultPersonaId, lastChatId, memory.backendConfigId)
 *   - JSON blobs: transformer_chains.steps_json scriptId values,
 *     world_info.entries entry ids, characters.extensions regexScripts[].id
 *     and risuModules[].filePath (character_modules dir segment)
 *   - id-based filesystem objects: files/attachments/<id>[.<ext>],
 *     files/character_assets/<charId>/<assetId>.* (both segments),
 *     files/character_modules/<charId>/ directories; the corresponding
 *     file_path columns are updated to match.
 *
 * Idempotent: only UUID-shaped ids (8-4-4-4-12 hex) are remapped, so
 * `unpacked/<slug>`, `test-session-*`, `name#seq` and existing word-ids are
 * left untouched and re-runs find nothing to do. The backup is skipped when
 * it already exists, and filesystem renames skip missing sources / existing
 * targets. If the process dies between the DB commit and the rename phase,
 * the DB points at new paths while some files still carry old names — rename
 * them manually to match (the DB backup allows a full retry otherwise).
 *
 * Backup: before any change, the whole database is snapshotted to
 * `<dataDir>/tamari.db.pre-wordids.bak` via VACUUM INTO. The `files/` tree is
 * NOT copied (renames are in-place and idempotent) — make a manual
 * `cp -r data-v2/` backup before running `db:migrate` if you want one.
 *
 * FK enforcement must be off while primary keys move (SQLite FK actions are
 * ON DELETE-only here). libsql treats `PRAGMA foreign_keys` as a no-op inside
 * a transaction, so it is toggled around (not inside) the write transaction
 * and restored to its prior state afterwards; `PRAGMA foreign_key_check`
 * then fails the migration loudly if any reference was missed.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Client, InValue, Transaction } from '@libsql/client';
import { newId } from '@tamari/wordid';
import { str } from '../../lib/coerce.js';
import { getLogger } from '../../lib/logger.js';
import type { Migration } from '../runMigrations.js';

const log = getLogger('db/migrations/021');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** LIKE heuristic (`_` matches any char) to spot UUID-shaped strings in JSON blobs. */
const UUID_LIKE = '%________-____-____-____-____________%';

/** Tables whose own TEXT primary key gets a word-id. (chat_members has no own id.) */
const PK_TABLES = [
  'characters',
  'world_info',
  'personas',
  'chats',
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
] as const;

type PkTable = (typeof PK_TABLES)[number];
type IdMap = Map<string, string>;
type Row = Record<string, unknown>;

/** Shared fallback for `maps.get(table)` — IdMaps are never mutated after buildMaps. */
const EMPTY_MAP: IdMap = new Map();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a JSON TEXT column; undefined when empty or invalid. */
function parseJson(raw: unknown): unknown {
  const text = str(raw, '');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Generate a word-id not yet in `used` (which is updated as a side effect). */
function takeId(used: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = newId();
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error('021_word_ids: could not generate a unique word-id after 100 attempts');
}

/**
 * Build old→new id maps per table. `used` is seeded with EVERY id already
 * present in every in-scope table (not only UUIDs) so a fresh word-id can
 * never collide with an existing non-migrated id.
 */
async function buildMaps(db: Client): Promise<{ maps: Map<PkTable, IdMap>; used: Set<string> }> {
  const used = new Set<string>();
  const idsByTable = new Map<PkTable, string[]>();
  for (const table of PK_TABLES) {
    const rs = await db.execute(`SELECT id FROM ${table}`);
    const ids = rs.rows.map((r) => str(r.id));
    idsByTable.set(table, ids);
    for (const id of ids) used.add(id);
  }
  const maps = new Map<PkTable, IdMap>();
  for (const table of PK_TABLES) {
    const map: IdMap = new Map();
    for (const id of idsByTable.get(table) ?? []) {
      if (UUID_RE.test(id)) map.set(id, takeId(used));
    }
    maps.set(table, map);
  }
  return { maps, used };
}

/** Heuristic: embedded JSON ids (world_info entries, character regex rules)
 * may need remapping even when no PK does (e.g. `unpacked/` rows). */
async function blobsMayNeedWork(db: Client): Promise<boolean> {
  for (const sql of [
    `SELECT 1 FROM world_info WHERE entries LIKE '${UUID_LIKE}' LIMIT 1`,
    `SELECT 1 FROM characters WHERE extensions LIKE '${UUID_LIKE}' LIMIT 1`,
  ]) {
    const rs = await db.execute(sql);
    if (rs.rows.length > 0) return true;
  }
  return false;
}

/** Snapshot asset ids per character for the filesystem rename phase (only
 * assets whose id is actually being remapped). */
async function collectAssetsByChar(db: Client, assets: IdMap): Promise<Map<string, IdMap>> {
  const byChar = new Map<string, IdMap>();
  if (assets.size === 0) return byChar;
  const rs = await db.execute('SELECT id, character_id FROM character_assets');
  for (const row of rs.rows) {
    const id = str(row.id);
    if (!assets.has(id)) continue;
    const charId = str(row.character_id);
    let list = byChar.get(charId);
    if (list === undefined) {
      list = new Map();
      byChar.set(charId, list);
    }
    list.set(id, assets.get(id) ?? id);
  }
  return byChar;
}

/**
 * Select `cols` from `table` and UPDATE each row for which `remap` returns a
 * column→value patch (null = untouched). Rows are matched by their CURRENT id
 * from the upfront snapshot, so rewriting the id column mid-loop is safe —
 * old (UUID) and new (word-id) namespaces never overlap.
 */
async function remapTable(
  tx: Transaction,
  table: string,
  cols: string[],
  remap: (row: Row) => Record<string, InValue> | null,
): Promise<number> {
  const rs = await tx.execute(`SELECT ${cols.join(', ')} FROM ${table}`);
  let changed = 0;
  for (const row of rs.rows) {
    const r = row as Row;
    const sets = remap(r);
    if (sets === null) continue;
    const keys = Object.keys(sets);
    await tx.execute({
      sql: `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      args: [...keys.map((k) => sets[k] ?? null), str(r.id)],
    });
    changed++;
  }
  return changed;
}

/** Patch for the id column plus simple map-driven reference columns. */
function pkAndRefs(
  row: Row,
  idMap: IdMap,
  refs: ReadonlyArray<readonly [string, IdMap]>,
): Record<string, InValue> | null {
  const sets: Record<string, InValue> = {};
  const mapped = idMap.get(str(row.id));
  if (mapped !== undefined) sets['id'] = mapped;
  for (const [col, map] of refs) {
    const value = row[col];
    if (typeof value !== 'string') continue;
    const target = map.get(value);
    if (target !== undefined) sets[col] = target;
  }
  return Object.keys(sets).length > 0 ? sets : null;
}

/** Remap UUID-shaped entry ids inside a world_info entries blob (per-book
 * fresh word-ids drawn from the global used-set). */
function remapEntryIds(entriesRaw: unknown, used: Set<string>): string | null {
  const parsed = parseJson(entriesRaw);
  if (!Array.isArray(parsed)) return null;
  let changed = false;
  for (const entry of parsed) {
    if (isRecord(entry) && typeof entry['id'] === 'string' && UUID_RE.test(entry['id'])) {
      entry['id'] = takeId(used);
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : null;
}

/** Remap characters.extensions: regexScripts[].id (fresh word-ids) and
 * risuModules[].filePath (character_modules directory segment follows the
 * character id). */
function remapCharacterExtensions(
  extensionsRaw: unknown,
  oldCharId: string,
  newCharId: string | undefined,
  used: Set<string>,
): string | null {
  const parsed = parseJson(extensionsRaw);
  if (!isRecord(parsed)) return null;
  let changed = false;

  const regexScripts = parsed['regexScripts'];
  if (Array.isArray(regexScripts)) {
    for (const script of regexScripts) {
      if (isRecord(script) && typeof script['id'] === 'string' && UUID_RE.test(script['id'])) {
        script['id'] = takeId(used);
        changed = true;
      }
    }
  }

  if (newCharId !== undefined) {
    const modules = parsed['risuModules'];
    if (Array.isArray(modules)) {
      const oldPrefix = `files/character_modules/${oldCharId}/`;
      for (const meta of modules) {
        if (!isRecord(meta)) continue;
        const filePath = meta['filePath'];
        if (typeof filePath === 'string' && filePath.startsWith(oldPrefix)) {
          meta['filePath'] = `files/character_modules/${newCharId}/${filePath.slice(oldPrefix.length)}`;
          changed = true;
        }
      }
    }
  }

  return changed ? JSON.stringify(parsed) : null;
}

/** Remap files/attachments/<oldId>[.<ext>] to the new id, preserving the suffix. */
function remapAttachmentPath(filePath: string, oldId: string, newId: string): string | null {
  const prefix = `files/attachments/${oldId}`;
  if (filePath === prefix) return `files/attachments/${newId}`;
  if (filePath.startsWith(`${prefix}.`)) {
    return `files/attachments/${newId}${filePath.slice(prefix.length)}`;
  }
  return null;
}

/** Remap files/character_assets/<charId>/<assetId>[.<ext>] — both segments. */
function remapAssetPath(
  filePath: string,
  characters: IdMap,
  oldAssetId: string,
  newAssetId: string | undefined,
): string | null {
  const segments = filePath.split('/');
  if (segments.length !== 4 || segments[0] !== 'files' || segments[1] !== 'character_assets') return null;
  const oldCharId = segments[2] ?? '';
  const name = segments[3] ?? '';
  const newCharId = characters.get(oldCharId) ?? oldCharId;
  let newName = name;
  if (newAssetId !== undefined) {
    if (name === oldAssetId) newName = newAssetId;
    else if (name.startsWith(`${oldAssetId}.`)) newName = `${newAssetId}${name.slice(oldAssetId.length)}`;
  }
  if (newCharId === oldCharId && newName === name) return null;
  return `files/character_assets/${newCharId}/${newName}`;
}

/** Remap scriptId values inside transformer_chains.steps_json. */
function remapChainSteps(stepsRaw: unknown, scripts: IdMap): string | null {
  const parsed = parseJson(stepsRaw);
  if (!Array.isArray(parsed)) return null;
  let changed = false;
  for (const step of parsed) {
    if (isRecord(step) && typeof step['scriptId'] === 'string') {
      const mapped = scripts.get(step['scriptId']);
      if (mapped !== undefined) {
        step['scriptId'] = mapped;
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(parsed) : null;
}

async function rewriteSettings(tx: Transaction, maps: Map<PkTable, IdMap>): Promise<void> {
  const rs = await tx.execute('SELECT blob FROM settings WHERE id = 0');
  if (rs.rows.length === 0) return;
  const parsed = parseJson(rs.rows[0]?.blob);
  if (!isRecord(parsed)) return;

  let changed = false;
  const remapKey = (key: string, map: IdMap): void => {
    const value = parsed[key];
    if (typeof value !== 'string') return;
    const mapped = map.get(value);
    if (mapped !== undefined) {
      parsed[key] = mapped;
      changed = true;
    }
  };

  remapKey('activeBackendConfigId', maps.get('backend_configs') ?? EMPTY_MAP);
  remapKey('activePromptListId', maps.get('prompt_lists') ?? EMPTY_MAP);
  remapKey('defaultPersonaId', maps.get('personas') ?? EMPTY_MAP);
  remapKey('lastChatId', maps.get('chats') ?? EMPTY_MAP);

  const memory = parsed['memory'];
  if (isRecord(memory)) {
    const value = memory['backendConfigId'];
    if (typeof value === 'string') {
      const mapped = (maps.get('backend_configs') ?? EMPTY_MAP).get(value);
      if (mapped !== undefined) {
        memory['backendConfigId'] = mapped;
        changed = true;
      }
    }
  }

  if (changed) {
    await tx.execute({ sql: 'UPDATE settings SET blob = ? WHERE id = 0', args: [JSON.stringify(parsed)] });
  }
}

async function rewriteExtensionData(tx: Transaction, characters: IdMap, chats: IdMap): Promise<number> {
  const rs = await tx.execute(
    "SELECT extension_id, entity_type, entity_id FROM extension_data WHERE entity_type IN ('character', 'chat')",
  );
  let changed = 0;
  for (const row of rs.rows) {
    const entityType = str(row.entity_type);
    const map = entityType === 'character' ? characters : chats;
    const oldId = str(row.entity_id);
    const mapped = map.get(oldId);
    if (mapped === undefined) continue;
    await tx.execute({
      sql: 'UPDATE extension_data SET entity_id = ? WHERE extension_id = ? AND entity_type = ? AND entity_id = ?',
      args: [mapped, str(row.extension_id), entityType, oldId],
    });
    changed++;
  }
  return changed;
}

async function rewriteChatMembers(tx: Transaction, characters: IdMap, chats: IdMap): Promise<number> {
  const rs = await tx.execute('SELECT chat_id, character_id FROM chat_members');
  let changed = 0;
  for (const row of rs.rows) {
    const chatId = str(row.chat_id);
    const charId = str(row.character_id);
    const newChat = chats.get(chatId) ?? chatId;
    const newChar = characters.get(charId) ?? charId;
    if (newChat === chatId && newChar === charId) continue;
    await tx.execute({
      sql: 'UPDATE chat_members SET chat_id = ?, character_id = ? WHERE chat_id = ? AND character_id = ?',
      args: [newChat, newChar, chatId, charId],
    });
    changed++;
  }
  return changed;
}

/** The full DB rewrite in one write transaction, FK checks off around it. */
async function rewriteDatabase(db: Client, maps: Map<PkTable, IdMap>, used: Set<string>): Promise<void> {
  const map = (table: PkTable): IdMap => maps.get(table) ?? EMPTY_MAP;
  const characters = map('characters');
  const worldInfo = map('world_info');
  const personas = map('personas');
  const chats = map('chats');
  const generations = map('generations');
  const attachments = map('attachments');
  const assets = map('character_assets');
  const scripts = map('transformer_scripts');
  const chains = map('transformer_chains');

  const fkRow = (await db.execute('PRAGMA foreign_keys')).rows[0];
  const fkWasOn = fkRow !== undefined && Number(fkRow[0] ?? 0) === 1;
  await db.execute('PRAGMA foreign_keys = OFF');

  const counts: Record<string, number> = {};
  const tx = await db.transaction('write');
  try {
    counts['characters'] = await remapTable(tx, 'characters', ['id', 'world_info_id', 'extensions'], (row) => {
      const oldId = str(row.id);
      const sets = pkAndRefs(row, characters, [['world_info_id', worldInfo]]) ?? {};
      const extensions = remapCharacterExtensions(row.extensions, oldId, characters.get(oldId), used);
      if (extensions !== null) sets['extensions'] = extensions;
      return Object.keys(sets).length > 0 ? sets : null;
    });

    counts['world_info'] = await remapTable(tx, 'world_info', ['id', 'entries'], (row) => {
      const sets = pkAndRefs(row, worldInfo, []) ?? {};
      const entries = remapEntryIds(row.entries, used);
      if (entries !== null) sets['entries'] = entries;
      return Object.keys(sets).length > 0 ? sets : null;
    });

    counts['personas'] = await remapTable(tx, 'personas', ['id'], (row) => pkAndRefs(row, personas, []));

    counts['chats'] = await remapTable(
      tx,
      'chats',
      ['id', 'character_id', 'persona_id', 'forked_from_chat_id'],
      (row) =>
        pkAndRefs(row, chats, [
          ['character_id', characters],
          ['persona_id', personas],
          ['forked_from_chat_id', chats],
        ]),
    );

    counts['chat_members'] = await rewriteChatMembers(tx, characters, chats);

    counts['generations'] = await remapTable(tx, 'generations', ['id', 'chat_id', 'parent_id'], (row) =>
      pkAndRefs(row, generations, [
        ['chat_id', chats],
        ['parent_id', generations],
      ]),
    );

    counts['attachments'] = await remapTable(tx, 'attachments', ['id', 'file_path'], (row) => {
      const oldId = str(row.id);
      const newId = attachments.get(oldId);
      const sets: Record<string, InValue> = {};
      if (newId !== undefined) {
        sets['id'] = newId;
        if (typeof row.file_path === 'string') {
          const path = remapAttachmentPath(row.file_path, oldId, newId);
          if (path !== null) sets['file_path'] = path;
        }
      }
      return Object.keys(sets).length > 0 ? sets : null;
    });

    counts['character_assets'] = await remapTable(
      tx,
      'character_assets',
      ['id', 'character_id', 'file_path'],
      (row) => {
        const oldId = str(row.id);
        const sets = pkAndRefs(row, assets, [['character_id', characters]]) ?? {};
        if (typeof row.file_path === 'string') {
          const path = remapAssetPath(row.file_path, characters, oldId, assets.get(oldId));
          if (path !== null) sets['file_path'] = path;
        }
        return Object.keys(sets).length > 0 ? sets : null;
      },
    );

    counts['quick_replies'] = await remapTable(tx, 'quick_replies', ['id', 'scope', 'scope_id'], (row) => {
      const sets = pkAndRefs(row, map('quick_replies'), []) ?? {};
      const scope = str(row.scope);
      const scopeMap = scope === 'character' ? characters : scope === 'chat' ? chats : null;
      const scopeId = str(row.scope_id);
      const mappedScope = scopeMap?.get(scopeId);
      if (mappedScope !== undefined) sets['scope_id'] = mappedScope;
      return Object.keys(sets).length > 0 ? sets : null;
    });

    counts['backend_configs'] = await remapTable(tx, 'backend_configs', ['id', 'transformer_chain_id'], (row) =>
      pkAndRefs(row, map('backend_configs'), [['transformer_chain_id', chains]]),
    );

    counts['prompt_lists'] = await remapTable(tx, 'prompt_lists', ['id'], (row) =>
      pkAndRefs(row, map('prompt_lists'), []),
    );
    counts['custom_backends'] = await remapTable(tx, 'custom_backends', ['id'], (row) =>
      pkAndRefs(row, map('custom_backends'), []),
    );
    counts['tool_templates'] = await remapTable(tx, 'tool_templates', ['id'], (row) =>
      pkAndRefs(row, map('tool_templates'), []),
    );
    counts['toolsets'] = await remapTable(tx, 'toolsets', ['id', 'template_id'], (row) =>
      pkAndRefs(row, map('toolsets'), [['template_id', map('tool_templates')]]),
    );
    counts['transformer_scripts'] = await remapTable(tx, 'transformer_scripts', ['id'], (row) =>
      pkAndRefs(row, scripts, []),
    );

    counts['transformer_chains'] = await remapTable(tx, 'transformer_chains', ['id', 'steps_json'], (row) => {
      const sets = pkAndRefs(row, chains, []) ?? {};
      const steps = remapChainSteps(row.steps_json, scripts);
      if (steps !== null) sets['steps_json'] = steps;
      return Object.keys(sets).length > 0 ? sets : null;
    });

    counts['extension_data'] = await rewriteExtensionData(tx, characters, chats);
    await rewriteSettings(tx, maps);

    await tx.commit();
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // Transaction already closed (e.g. commit failed) — nothing to roll back.
    }
    throw err;
  } finally {
    await db.execute(`PRAGMA foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);
  }

  const violations = await db.execute('PRAGMA foreign_key_check');
  if (violations.rows.length > 0) {
    throw new Error(
      `021_word_ids: foreign_key_check violations after rewrite: ${JSON.stringify(violations.rows.slice(0, 5))}`,
    );
  }

  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${table}: ${n}`)
    .join(', ');
  log.info(`database rewrite committed (${summary === '' ? 'no row changes' : summary}); foreign_key_check clean`);
}

// ---------- filesystem rename phase (after the DB commit) ----------

function renameIfNeeded(from: string, to: string, label: string): void {
  if (from === to || !existsSync(from)) return;
  if (existsSync(to)) {
    log.warn(`skipping ${label} rename — target already exists: ${to}`);
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  log.info(`renamed ${label}: ${from} -> ${to}`);
}

function renameAttachmentFiles(dataDir: string, attachments: IdMap): void {
  if (attachments.size === 0) return;
  const dir = join(dataDir, 'files', 'attachments');
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  for (const [oldId, newId] of attachments) {
    for (const entry of entries) {
      if (entry === oldId || entry.startsWith(`${oldId}.`)) {
        renameIfNeeded(join(dir, entry), join(dir, `${newId}${entry.slice(oldId.length)}`), 'attachment file');
      }
    }
  }
}

function renameCharacterAssetFiles(dataDir: string, characters: IdMap, assetsByChar: Map<string, IdMap>): void {
  const root = join(dataDir, 'files', 'character_assets');
  if (!existsSync(root)) return;

  // Char directory renames first, so asset files below are found in the new dir.
  for (const [oldChar, newChar] of characters) {
    renameIfNeeded(join(root, oldChar), join(root, newChar), 'character assets dir');
  }

  for (const [charId, assetMap] of assetsByChar) {
    const newDir = join(root, characters.get(charId) ?? charId);
    const oldDir = join(root, charId);
    // Scan both dirs: a partial previous run may have left files in either.
    for (const dir of [...new Set([newDir, oldDir])]) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        for (const [oldAsset, newAsset] of assetMap) {
          if (entry === oldAsset || entry.startsWith(`${oldAsset}.`)) {
            renameIfNeeded(join(dir, entry), join(newDir, `${newAsset}${entry.slice(oldAsset.length)}`), 'asset file');
          }
        }
      }
    }
    if (oldDir !== newDir && existsSync(oldDir)) {
      try {
        rmdirSync(oldDir);
      } catch {
        // Not empty (untracked files) — leave it.
      }
    }
  }
}

function renameCharacterModuleDirs(dataDir: string, characters: IdMap): void {
  if (characters.size === 0) return;
  const root = join(dataDir, 'files', 'character_modules');
  if (!existsSync(root)) return;
  for (const [oldChar, newChar] of characters) {
    renameIfNeeded(join(root, oldChar), join(root, newChar), 'character modules dir');
  }
}

const migration: Migration = {
  async up({ db, dataDir }) {
    const { maps, used } = await buildMaps(db);
    const totalPk = [...maps.values()].reduce((n, m) => n + m.size, 0);

    if (totalPk === 0 && !(await blobsMayNeedWork(db))) {
      log.info('no legacy UUID ids found — nothing to do');
      return;
    }
    log.info(`backfilling word-ids: ${totalPk} primary keys plus embedded JSON ids`);

    if (dataDir !== undefined) {
      const backup = join(dataDir, 'tamari.db.pre-wordids.bak');
      if (existsSync(backup)) {
        log.info(`backup already exists, skipping: ${backup}`);
      } else {
        await db.execute(`VACUUM INTO '${backup.split("'").join("''")}'`);
        log.info(`wrote database backup: ${backup}`);
      }
    } else {
      log.warn('no dataDir in migration context — skipping backup and filesystem renames');
    }

    // Snapshot before the rewrite: character_assets rows still carry old ids.
    const assetsByChar = await collectAssetsByChar(db, maps.get('character_assets') ?? EMPTY_MAP);

    await rewriteDatabase(db, maps, used);

    if (dataDir !== undefined) {
      renameAttachmentFiles(dataDir, maps.get('attachments') ?? EMPTY_MAP);
      renameCharacterAssetFiles(dataDir, maps.get('characters') ?? EMPTY_MAP, assetsByChar);
      renameCharacterModuleDirs(dataDir, maps.get('characters') ?? EMPTY_MAP);
      log.info('filesystem renames complete');
    }
  },
};

export default migration;
