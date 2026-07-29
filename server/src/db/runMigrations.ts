/**
 * Shared migration runner — applies `db/migrations/*.sql` in version order
 * against any libsql client and tracks progress in `PRAGMA user_version`.
 *
 * Each file runs in its own transaction: a failed statement rolls the whole
 * file back and aborts the run. `duplicate column name` errors are tolerated
 * so a crash mid-file (column added, `user_version` not yet bumped) can
 * recover on the next attempt. Used by production boot (db/index.ts) and by
 * the TestHarness, so tests always run the real production schema.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { getLogger } from '../lib/logger.js';

const log = getLogger('db');

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function applyMigrations(client: Client): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const versionRow = await client.execute('PRAGMA user_version');
  const currentVersion = Number(versionRow.rows[0]?.user_version ?? 0);

  for (const file of files) {
    const match = /^(\d+)_.+\.sql$/.exec(file);
    const version = match?.[1] !== undefined ? parseInt(match[1], 10) : NaN;
    if (!Number.isFinite(version) || version <= currentVersion) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    log.info(`applying migration ${version}: ${file}`);
    const tx = await client.transaction('write');
    try {
      for (const stmt of statements) {
        try {
          await tx.execute(`${stmt};`);
        } catch (err) {
          // Tolerate already-applied columns — a crash mid-migration can leave
          // the column behind without bumping user_version, so the retry
          // re-runs the statement. SQLite keeps the transaction usable after
          // a statement error, so the rest of the file still applies.
          if (err instanceof Error && err.message.includes('duplicate column name')) {
            log.warn(`migration ${version}: column already exists, skipping: ${stmt}`);
            continue;
          }
          throw err;
        }
      }
      await tx.execute(`PRAGMA user_version = ${version}`);
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // Transaction already closed (e.g. commit failed) — nothing to roll back.
      }
      throw err;
    }
  }

  const newVersionRow = await client.execute('PRAGMA user_version');
  const newVersion = Number(newVersionRow.rows[0]?.user_version ?? 0);
  if (newVersion > currentVersion) {
    log.info(`migrations complete. Schema version: ${newVersion}`);
  }
}
