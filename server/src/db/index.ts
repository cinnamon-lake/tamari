/**
 * Database connection and migration runner.
 * Uses @libsql/client for NixOS compatibility (no native compilation required).
 */

import { createClient, type Client } from '@libsql/client';
import { getLogger } from '../lib/logger.js';
import { DEFAULT_LEGACY_DATA_DIR, maybeImportLegacyData } from './import-legacy.js';
import { applyMigrations } from './runMigrations.js';
import { ProfiledClient, createProfilerConfig, isProfilingEnabled } from './profiler.js';

const log = getLogger('db');

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

  await applyMigrations(client, { dataDir: config.dataDir });

  // Boot task, deliberately not a migration: its every-boot re-check is what
  // lets a user drop a legacy v1 data dir in later and have it imported.
  if (config.dataDir) {
    await maybeImportLegacyData(client, config.dataDir, DEFAULT_LEGACY_DATA_DIR);
  }

  return client;
}
