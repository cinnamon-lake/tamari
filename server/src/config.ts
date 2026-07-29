/**
 * Runtime configuration loader.
 */

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';

const ROOT_DIR = process.cwd();

/**
 * One-time rebrand migration: if the data dir still holds a pre-rename
 * `sillytavern.db` (and no `tamari.db` yet), rename it — including WAL/SHM
 * sidecars — before the database is opened.
 */
function resolveDbPath(dataDir: string): string {
  const dbPath = join(dataDir, 'tamari.db');
  const legacyPath = join(dataDir, 'sillytavern.db');
  if (!existsSync(dbPath) && existsSync(legacyPath)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(legacyPath + suffix)) {
        renameSync(legacyPath + suffix, dbPath + suffix);
      }
    }
  }
  return dbPath;
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  disableCsrf: boolean;
  secret: string;
  wsOrigins: string[];
  httpJsonLimit: string;
  wsMaxPayloadBytes: number;
  avatarMaxFileSizeBytes: number;
  wsAuthRejectionMs: number;
  shutdownTimeoutMs: number;
  /** Tool-call rounds allowed per generation turn before the loop stops. */
  maxToolRounds: number;
}

export function loadConfig(): ServerConfig {
  const port = parseInt(process.env.PORT ?? '8000', 10);
  const host = process.env.HOST ?? '::';
  const dataDir = process.env.DATA_DIR ?? join(ROOT_DIR, 'data-v2');
  const dbPath = resolveDbPath(dataDir);
  const logLevel = (process.env.LOG_LEVEL as ServerConfig['logLevel'] | undefined) ?? 'info';
  const disableCsrf = process.env.DISABLE_CSRF === 'true';
  // SILLYTAVERN_SECRET accepted as a pre-rebrand fallback.
  const secret = process.env.TAMARI_SECRET ?? process.env.SILLYTAVERN_SECRET ?? randomBytes(32).toString('hex');
  const wsOrigins = process.env.WS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? [];
  const httpJsonLimit = process.env.HTTP_JSON_LIMIT ?? '5mb';
  const wsMaxPayloadBytes = parseInt(process.env.WS_MAX_PAYLOAD_BYTES ?? String(1024 * 1024), 10);
  const avatarMaxFileSizeBytes = parseInt(process.env.AVATAR_MAX_FILE_SIZE_BYTES ?? String(50 * 1024 * 1024), 10);
  const wsAuthRejectionMs = parseInt(process.env.WS_AUTH_REJECTION_MS ?? '500', 10);
  const shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '5000', 10);
  // 100: agentic workflows (character porting, multi-step tool sequences)
  // treat 25 as an appetizer.
  const maxToolRounds = parseInt(process.env.MAX_TOOL_ROUNDS ?? '100', 10);

  return {
    port,
    host,
    dataDir,
    dbPath,
    logLevel,
    disableCsrf,
    secret,
    wsOrigins,
    httpJsonLimit,
    wsMaxPayloadBytes,
    avatarMaxFileSizeBytes,
    wsAuthRejectionMs,
    shutdownTimeoutMs,
    maxToolRounds,
  };
}
