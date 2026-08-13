/**
 * 009 — one-time extraction of legacy BLOB columns to the filesystem.
 *
 * Moved from db/index.ts, where it ran as an ad-hoc boot-time migration.
 * Idempotent: skips rows that already have a file path, and no-ops entirely
 * when the legacy columns are absent from the schema.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { str } from '../../lib/coerce.js';
import { getLogger } from '../../lib/logger.js';
import { FileStorage } from '../../services/FileStorage.js';
import type { Migration } from '../runMigrations.js';

const log = getLogger('db');

async function hasColumn(db: Client, table: string, column: string): Promise<boolean> {
  const rs = await db.execute({
    sql: 'SELECT 1 FROM pragma_table_info(?) WHERE name = ?',
    args: [table, column],
  });
  return rs.rows.length > 0;
}

const migration: Migration = {
  async up({ db, dataDir }) {
    // Collect legacy rows first so a missing dataDir is only an error when
    // there is actual work to do (tests run migrations without one).
    const chars = (await hasColumn(db, 'characters', 'avatar_blob'))
      ? await db.execute(
          'SELECT id, avatar_blob FROM characters WHERE avatar_blob IS NOT NULL AND avatar_path IS NULL',
        )
      : null;
    const personas = (await hasColumn(db, 'personas', 'avatar_blob'))
      ? await db.execute(
          'SELECT id, avatar_blob FROM personas WHERE avatar_blob IS NOT NULL AND avatar_path IS NULL',
        )
      : null;
    const attachments = (await hasColumn(db, 'attachments', 'blob'))
      ? await db.execute('SELECT id, blob FROM attachments WHERE blob IS NOT NULL AND file_path IS NULL')
      : null;

    const charCount = chars?.rows.length ?? 0;
    const personaCount = personas?.rows.length ?? 0;
    const attachmentCount = attachments?.rows.length ?? 0;
    if (charCount + personaCount + attachmentCount === 0) return;

    if (dataDir === undefined) {
      throw new Error('migration 009_blobs_to_files: legacy BLOBs present but no dataDir configured');
    }
    const storage = new FileStorage(dataDir);

    for (const row of chars?.rows ?? []) {
      const id = str(row.id);
      const blob = Buffer.from(row.avatar_blob as unknown as Buffer | Uint8Array);
      const fileName = `${randomUUID()}.png`;
      const relPath = storage.write('avatars', fileName, new Uint8Array(blob));
      await db.execute({
        sql: 'UPDATE characters SET avatar_path = ? WHERE id = ?',
        args: [relPath, id],
      });
      log.info(`migrated character avatar: ${id}`);
    }

    for (const row of personas?.rows ?? []) {
      const id = str(row.id);
      const blob = Buffer.from(row.avatar_blob as unknown as Buffer | Uint8Array);
      const fileName = `${randomUUID()}.png`;
      const relPath = storage.write('personas', fileName, new Uint8Array(blob));
      await db.execute({
        sql: 'UPDATE personas SET avatar_path = ? WHERE id = ?',
        args: [relPath, id],
      });
      log.info(`migrated persona avatar: ${id}`);
    }

    for (const row of attachments?.rows ?? []) {
      const id = str(row.id);
      const blob = Buffer.from(row.blob as unknown as Buffer | Uint8Array);
      const relPath = storage.write('attachments', id, new Uint8Array(blob));
      await db.execute({
        sql: 'UPDATE attachments SET file_path = ? WHERE id = ?',
        args: [relPath, id],
      });
      log.info(`migrated attachment: ${id}`);
    }

    log.info(
      `BLOB migration complete: ${charCount} characters, ${personaCount} personas, ${attachmentCount} attachments`,
    );
  },
};

export default migration;
