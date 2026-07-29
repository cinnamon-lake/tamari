/**
 * Settings repository — singleton JSON blob backed by SQLite.
 *
 * The settings table has exactly one row (id = 0). The `blob` column
 * stores the entire settings object as JSON. Reads and writes are
 * validated against AppSettingsSchema.
 *
 * The public interface exposes key-based get/setValue for dynamic keys,
 * patch-based set for typed merges, and getTyped() for a fully-typed
 * AppSettings read view (no index signature).
 */

import type { Client } from '@libsql/client';
import { AppSettingsSchema } from '@tamari/types';
import type { AppSettings, SettingsMap } from '@tamari/types';
import { z } from 'zod';
import { safeParseJson } from '../lib/safeJson.js';

export interface ISettingsRepository {
  /** Read the full settings blob. */
  get(): Promise<SettingsMap>;
  /** Read a single key from the blob. */
  get(key: string): Promise<unknown>;
  /**
   * Typed read view of the settings blob: known keys with defaults applied,
   * without the forward-compat index signature. Prefer this over list() +
   * String()/Number() coercions; use list() only for genuinely dynamic keys.
   */
  getTyped(): Promise<AppSettings>;
  /** Read the full settings blob. */
  getMany(): Promise<SettingsMap>;
  /** Merge a partial patch into the blob and validate. Returns the updated blob. */
  set(patch: Partial<AppSettings>): Promise<SettingsMap>;
  /** Set a single key. */
  setValue(key: string, value: unknown): Promise<void>;
  /** Delete a key from the blob (sets it to undefined, letting defaults take over). */
  delete(key: string): Promise<void>;
  /** Alias for get(). */
  list(): Promise<SettingsMap>;
  /**
   * Synchronous read from the in-memory snapshot. Returns undefined until the
   * first async read/write has populated the snapshot (CachedSettings serves
   * it from its fully-loaded cache).
   */
  getSync(key: string): unknown;
}

const SETTINGS_ID = 0;

/** Defaults applied when the settings blob is missing or corrupt, so a bad
 * row never bricks client boot — log + degrade rather than throw. */
const DEFAULT_SETTINGS = AppSettingsSchema.parse({});

function readBlob(row: unknown): SettingsMap {
  const r = z.object({ blob: z.string() }).parse(row);
  return safeParseJson(r.blob, AppSettingsSchema, DEFAULT_SETTINGS);
}

async function fetchFromDb(client: Client): Promise<SettingsMap> {
  const rs = await client.execute({
    sql: 'SELECT blob FROM settings WHERE id = ?',
    args: [SETTINGS_ID],
  });
  if (rs.rows.length === 0) {
    return AppSettingsSchema.parse({});
  }
  return readBlob(rs.rows[0]);
}

async function writeToDb(client: Client, blob: SettingsMap): Promise<SettingsMap> {
  const validated = AppSettingsSchema.parse(blob);
  const serialized = JSON.stringify(validated);
  const now = Math.floor(Date.now() / 1000);
  await client.execute({
    sql: `INSERT INTO settings (id, blob, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
    args: [SETTINGS_ID, serialized, now],
  });
  return validated;
}

export class SettingsRepository implements ISettingsRepository {
  /** Last blob seen by this instance; backs getSync. */
  private snapshot: SettingsMap | null = null;

  constructor(private client: Client) {}

  async get(): Promise<SettingsMap>;
  async get(key: string): Promise<unknown>;
  async get(key?: string): Promise<unknown> {
    const blob = await fetchFromDb(this.client);
    this.snapshot = blob;
    return key === undefined ? blob : blob[key];
  }

  async getTyped(): Promise<AppSettings> {
    const blob = await fetchFromDb(this.client);
    this.snapshot = blob;
    return blob;
  }

  async getMany(): Promise<SettingsMap> {
    const blob = await fetchFromDb(this.client);
    this.snapshot = blob;
    return blob;
  }

  async set(patch: Partial<AppSettings>): Promise<SettingsMap> {
    const current = await fetchFromDb(this.client);
    const next = { ...current, ...patch };
    const validated = await writeToDb(this.client, next);
    this.snapshot = validated;
    return validated;
  }

  async setValue(key: string, value: unknown): Promise<void> {
    const current = await fetchFromDb(this.client);
    const next = { ...current, [key]: value };
    const validated = await writeToDb(this.client, next);
    this.snapshot = validated;
  }

  async delete(key: string): Promise<void> {
    const current = await fetchFromDb(this.client);
    const next = { ...current };
    delete next[key];
    const validated = await writeToDb(this.client, next);
    this.snapshot = validated;
  }

  async list(): Promise<SettingsMap> {
    const blob = await fetchFromDb(this.client);
    this.snapshot = blob;
    return blob;
  }

  getSync(key: string): unknown {
    if (this.snapshot === null) return undefined;
    return AppSettingsSchema.parse(this.snapshot)[key];
  }
}

/**
 * Cached settings — in-memory cache over the settings blob.
 *
 * - Loads the settings blob once on first access
 * - All reads are served from memory (zero DB round-trips after warm-up)
 * - Writes merge in memory, persist to SQLite, and update the cache atomically
 * - Thread-safe for concurrent first-access via a loading promise
 */
export class CachedSettings implements ISettingsRepository {
  private cache: SettingsMap | null = null;
  private loading: Promise<SettingsMap> | null = null;

  constructor(private client: Client) {}

  private async load(): Promise<SettingsMap> {
    if (this.cache !== null) return this.cache;
    if (this.loading !== null) return this.loading;

    this.loading = fetchFromDb(this.client).then((blob) => {
      this.cache = blob;
      this.loading = null;
      return blob;
    });

    return this.loading;
  }

  async get(): Promise<SettingsMap>;
  async get(key: string): Promise<unknown>;
  async get(key?: string): Promise<unknown> {
    const blob = await this.load();
    const cloned = AppSettingsSchema.parse(blob);
    return key === undefined ? cloned : cloned[key];
  }

  async getTyped(): Promise<AppSettings> {
    const blob = await this.load();
    return AppSettingsSchema.parse(blob);
  }

  async getMany(): Promise<SettingsMap> {
    const blob = await this.load();
    return AppSettingsSchema.parse(blob);
  }

  async set(patch: Partial<AppSettings>): Promise<SettingsMap> {
    const current = await this.load();
    const next = { ...current, ...patch };
    const validated = await writeToDb(this.client, next);
    this.cache = validated;
    return { ...validated };
  }

  async setValue(key: string, value: unknown): Promise<void> {
    const current = await this.load();
    const next = { ...current, [key]: value };
    const validated = await writeToDb(this.client, next);
    this.cache = validated;
  }

  async delete(key: string): Promise<void> {
    const current = await this.load();
    const next = { ...current };
    delete next[key];
    const validated = await writeToDb(this.client, next);
    this.cache = validated;
  }

  async list(): Promise<SettingsMap> {
    const blob = await this.load();
    return AppSettingsSchema.parse(blob);
  }

  /** Synchronous read from the in-memory cache. Returns undefined if not loaded yet. */
  getSync(key: string): unknown {
    if (this.cache === null) return undefined;
    const parsed = AppSettingsSchema.parse(this.cache);
    return parsed[key];
  }
}
