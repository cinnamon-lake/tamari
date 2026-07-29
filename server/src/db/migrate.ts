/**
 * CLI script to run database migrations manually.
 *
 * Usage:
 *   npx tsx server/src/db/migrate.ts
 */

import { initDatabase } from './index.js';
import { loadConfig } from '../config.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });

const client = await initDatabase({ path: config.dbPath, dataDir: config.dataDir });
console.log(`[migrate] Database ready at ${config.dbPath}`);
client.close();
