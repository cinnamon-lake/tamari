/**
 * Secrets repository — encrypted key-value store.
 *
 * Note: Actual encryption/decryption is handled at a higher layer.
 * This repository stores opaque ciphertext.
 */

import type { Client } from '@libsql/client';
import { SecretRowSchema } from '@tamari/types';
import type { SecretRow } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { mapRowsLenient } from './rows.js';

function rowToSecret(row: unknown): SecretRow {
  const r = SecretRowSchema.parse(row);
  return {
    key: r.key,
    value: r.value,
    label: r.label,
    updatedAt: r.updated_at,
  };
}

export interface ISecretRepository {
  get(key: string): Promise<SecretRow | undefined>;
  list(): Promise<SecretRow[]>;
  set(key: string, value: string, label?: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class SecretRepository implements ISecretRepository {
  constructor(private client: Client) {}

  async get(key: string): Promise<SecretRow | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM secrets WHERE key = ?', args: [key] });
    if (rs.rows.length === 0) return undefined;
    return rowToSecret(rs.rows[0]);
  }

  async list(): Promise<SecretRow[]> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM secrets ORDER BY key' });
    return mapRowsLenient(rs.rows, rowToSecret, 'SecretRepository.list');
  }

  async set(key: string, value: string, label?: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO secrets (key, value, label, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, label = excluded.label, updated_at = excluded.updated_at`,
      args: [key, value, label ?? null, now],
    });
  }

  async delete(key: string): Promise<void> {
    const rs = await this.client.execute({ sql: 'DELETE FROM secrets WHERE key = ?', args: [key] });
    if (rs.rowsAffected === 0) throw new NotFoundError('Secret', key);
  }
}
