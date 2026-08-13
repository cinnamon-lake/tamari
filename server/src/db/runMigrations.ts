/**
 * Shared migration runner — applies `db/migrations/*` in version order against
 * any libsql client and tracks progress in `PRAGMA user_version`.
 *
 * Two migration kinds share one numeric sequence:
 *   - `NNN_name.sql` — schema migrations. Each file runs in its own
 *     transaction: a failed statement rolls the whole file back and aborts the
 *     run. `duplicate column name` errors are tolerated so a crash mid-file
 *     (column added, `user_version` not yet bumped) can recover on retry.
 *   - `NNN_name.ts` — code migrations. Default-export a `Migration` whose
 *     `up(ctx)` runs arbitrary data work (repos, FileStorage, etc.). Code
 *     migrations are NOT wrapped in a transaction — they may touch the
 *     filesystem — so they must be idempotent/self-checking; `user_version`
 *     is bumped only after `up()` resolves, and a throw aborts the run.
 *
 * Used by production boot (db/index.ts) and by the TestHarness, so tests
 * always run the real production schema.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client } from '@libsql/client';
import { getLogger } from '../lib/logger.js';

const log = getLogger('db');

const defaultMigrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrationContext {
  db: Client;
  dataDir?: string;
}

export interface Migration {
  up(ctx: MigrationContext): Promise<void>;
}

export interface ApplyMigrationsOptions {
  dataDir?: string;
  /** Override the migrations directory (tests only). */
  migrationsDir?: string;
}

interface MigrationFile {
  version: number;
  file: string;
  kind: 'sql' | 'code';
}

function discoverMigrations(dir: string): MigrationFile[] {
  const sqlRe = /^(\d+)_.+\.sql$/;
  // `.ts` when running from src (tsx/vitest), `.js` when running from dist —
  // never both. Exclude declaration files and tests.
  const codeRe = /^(\d+)_.+\.(ts|js)$/;
  const found: MigrationFile[] = [];
  for (const file of readdirSync(dir)) {
    const sqlMatch = sqlRe.exec(file);
    if (sqlMatch?.[1] !== undefined) {
      found.push({ version: parseInt(sqlMatch[1], 10), file, kind: 'sql' });
      continue;
    }
    const codeMatch = codeRe.exec(file);
    if (
      codeMatch?.[1] !== undefined &&
      !file.endsWith('.d.ts') &&
      !file.includes('.test.')
    ) {
      found.push({ version: parseInt(codeMatch[1], 10), file, kind: 'code' });
    }
  }
  return found.sort((a, b) => a.version - b.version);
}

async function applySqlMigration(client: Client, dir: string, { version, file }: MigrationFile): Promise<void> {
  const sql = readFileSync(join(dir, file), 'utf-8');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

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

async function applyCodeMigration(
  client: Client,
  dir: string,
  { version, file }: MigrationFile,
  ctx: MigrationContext,
): Promise<void> {
  const mod: unknown = await import(pathToFileURL(join(dir, file)).href);
  const migration = (mod as { default?: Migration }).default;
  if (typeof migration?.up !== 'function') {
    throw new Error(`code migration ${file} must default-export a Migration with an up() function`);
  }
  await migration.up(ctx);
  await client.execute(`PRAGMA user_version = ${version}`);
}

export async function applyMigrations(client: Client, opts?: ApplyMigrationsOptions): Promise<void> {
  const dir = opts?.migrationsDir ?? defaultMigrationsDir;
  const migrations = discoverMigrations(dir);

  const versionRow = await client.execute('PRAGMA user_version');
  const currentVersion = Number(versionRow.rows[0]?.user_version ?? 0);

  const ctx: MigrationContext = { db: client };
  if (opts?.dataDir !== undefined) ctx.dataDir = opts.dataDir;

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

    log.info(`applying migration ${migration.version}: ${migration.file}`);
    if (migration.kind === 'sql') {
      await applySqlMigration(client, dir, migration);
    } else {
      await applyCodeMigration(client, dir, migration, ctx);
    }
  }

  const newVersionRow = await client.execute('PRAGMA user_version');
  const newVersion = Number(newVersionRow.rows[0]?.user_version ?? 0);
  if (newVersion > currentVersion) {
    log.info(`migrations complete. Schema version: ${newVersion}`);
  }
}
