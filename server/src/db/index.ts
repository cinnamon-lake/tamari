/**
 * Database connection and migration runner.
 * Uses @libsql/client for NixOS compatibility (no native compilation required).
 */

import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../lib/logger.js';
import { str } from '../lib/coerce.js';

const log = getLogger('db');
// Layering exception: db/ importing a service is an inversion, tolerated for
// the one-shot BLOB→file migration at boot (see import-legacy.ts header).
import { FileStorage } from '../services/FileStorage.js';
import { DEFAULT_LEGACY_DATA_DIR, maybeImportLegacyData } from './import-legacy.js';
import { applyMigrations } from './runMigrations.js';
import { ProfiledClient, createProfilerConfig, isProfilingEnabled } from './profiler.js';

export interface DbConfig {
  path: string;
  dataDir?: string;
}

/**
 * Open the SQLite database, run any pending migrations, and return the handle.
 */
export async function initDatabase(config: DbConfig): Promise<Client> {
  let client: Client = createClient({ url: `file:${config.path}` });

  if (isProfilingEnabled()) {
    client = new ProfiledClient(client, createProfilerConfig());
    log.info('SQL profiler enabled');
  }

  // Enable WAL mode for better concurrent read performance.
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA foreign_keys = ON');

  await applyMigrations(client);

  if (config.dataDir) {
    await migrateBlobsToFiles(client, config.dataDir);
    await maybeImportLegacyData(client, config.dataDir, DEFAULT_LEGACY_DATA_DIR);
    await migrateMessageContentToParts(client);
  }

  return client;
}

/**
 * One-time extraction of existing BLOB columns to the filesystem.
 * Safe to run multiple times (idempotent).
 */
async function migrateBlobsToFiles(client: Client, dataDir: string): Promise<void> {
  const storage = new FileStorage(dataDir);

  // Helper: check if a column exists on a table.
  async function hasColumn(table: string, column: string): Promise<boolean> {
    const rs = await client.execute({
      sql: 'SELECT 1 FROM pragma_table_info(?) WHERE name = ?',
      args: [table, column],
    });
    return rs.rows.length > 0;
  }

  let charCount = 0;
  let personaCount = 0;

  // Characters
  if (await hasColumn('characters', 'avatar_blob')) {
    const chars = await client.execute(
      'SELECT id, avatar_blob FROM characters WHERE avatar_blob IS NOT NULL AND avatar_path IS NULL',
    );
    for (const row of chars.rows) {
      const id = str(row.id);
      const blob = Buffer.from(row.avatar_blob as unknown as Buffer | Uint8Array);
      const fileName = `${randomUUID()}.png`;
      const relPath = storage.write('avatars', fileName, new Uint8Array(blob));
      await client.execute({
        sql: 'UPDATE characters SET avatar_path = ? WHERE id = ?',
        args: [relPath, id],
      });
      log.info(`migrated character avatar: ${id}`);
    }
    charCount = chars.rows.length;
  }

  // Personas
  if (await hasColumn('personas', 'avatar_blob')) {
    const personas = await client.execute(
      'SELECT id, avatar_blob FROM personas WHERE avatar_blob IS NOT NULL AND avatar_path IS NULL',
    );
    for (const row of personas.rows) {
      const id = str(row.id);
      const blob = Buffer.from(row.avatar_blob as unknown as Buffer | Uint8Array);
      const fileName = `${randomUUID()}.png`;
      const relPath = storage.write('personas', fileName, new Uint8Array(blob));
      await client.execute({
        sql: 'UPDATE personas SET avatar_path = ? WHERE id = ?',
        args: [relPath, id],
      });
      log.info(`migrated persona avatar: ${id}`);
    }
    personaCount = personas.rows.length;
  }

  // Attachments
  const attachments = await client.execute(
    'SELECT id, blob FROM attachments WHERE blob IS NOT NULL AND file_path IS NULL',
  );
  for (const row of attachments.rows) {
    const id = str(row.id);
    const blob = Buffer.from(row.blob as unknown as Buffer | Uint8Array);
    const relPath = storage.write('attachments', id, new Uint8Array(blob));
    await client.execute({
      sql: 'UPDATE attachments SET file_path = ? WHERE id = ?',
      args: [relPath, id],
    });
    log.info(`migrated attachment: ${id}`);
  }
  const attachmentCount = attachments.rows.length;

  if (charCount + personaCount + attachmentCount > 0) {
    log.info(
      `BLOB migration complete: ${charCount} characters, ${personaCount} personas, ${attachmentCount} attachments`,
    );
  }
}

/**
 * One-time migration: move message text from the legacy `content` column
 * into `extra.parts`. Safe to run multiple times (idempotent).
 */
async function migrateMessageContentToParts(client: Client): Promise<void> {
  const rs = await client.execute(
    "SELECT id, content, extra FROM messages WHERE content != '' AND content IS NOT NULL",
  );
  let migrated = 0;
  for (const row of rs.rows) {
    const id = Number(row.id);
    const content = str(row.content);
    let extra: Record<string, unknown>;
    try {
      extra = JSON.parse(str(row.extra) || '{}') as Record<string, unknown>;
    } catch {
      extra = {};
    }
    const parts = extra.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      extra.parts = [{ type: 'text', text: content }];
      await client.execute({
        sql: 'UPDATE messages SET extra = ?, content = ? WHERE id = ?',
        args: [JSON.stringify(extra), '', id],
      });
      migrated++;
    }
  }
  if (migrated > 0) {
    log.info(`migrated ${migrated} messages from content to extra.parts`);
  }
}
