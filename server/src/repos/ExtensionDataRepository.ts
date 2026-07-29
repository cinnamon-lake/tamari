/**
 * Extension data repository — per-extension JSON blobs keyed by
 * (extension_id, entity_type, entity_id).
 *
 * Used for out-of-fiction meta state (UI prefs, cross-route unlocks).
 * This data does NOT fork with chat branches — in-fiction world state
 * belongs in branch-aware `_toolState` instead.
 */

import { safeParseJson } from '../lib/safeJson.js';
import type { Client } from '@libsql/client';
import type { ExtensionData } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { mapRowsLenient } from './rows.js';
import { z } from 'zod';

/** Maximum serialized size of a single extension_data row (64 KB). */
const MAX_DATA_BYTES = 64 * 1024;

const ExtensionDataRowSchema = z.object({
  extension_id: z.string(),
  entity_type: z.enum(['global', 'character', 'chat', 'message']),
  entity_id: z.string(),
  data: z.string(),
});

export interface IExtensionDataRepository {
  get(
    extensionId: string,
    entityType: ExtensionData['entityType'],
    entityId: string,
  ): Promise<Record<string, unknown> | undefined>;
  set(
    extensionId: string,
    entityType: ExtensionData['entityType'],
    entityId: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  delete(extensionId: string, entityType: ExtensionData['entityType'], entityId: string): Promise<void>;
  /** Like delete(), but a missing row is not an error — for delete-if-exists flows. */
  deleteIfExists(extensionId: string, entityType: ExtensionData['entityType'], entityId: string): Promise<void>;
  listForEntity(entityType: ExtensionData['entityType'], entityId: string): Promise<ExtensionData[]>;
}

function rowToExtensionData(row: unknown): ExtensionData {
  const r = ExtensionDataRowSchema.parse(row);
  return {
    extensionId: r.extension_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    data: safeParseJson(r.data, z.record(z.string(), z.unknown()), {}),
  };
}

export class ExtensionDataRepository implements IExtensionDataRepository {
  constructor(private client: Client) {}

  async get(
    extensionId: string,
    entityType: ExtensionData['entityType'],
    entityId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const rs = await this.client.execute({
      sql: 'SELECT data FROM extension_data WHERE extension_id = ? AND entity_type = ? AND entity_id = ?',
      args: [extensionId, entityType, entityId],
    });
    if (rs.rows.length === 0) return undefined;
    const raw = (rs.rows[0] as Record<string, unknown>).data;
    return safeParseJson(raw, z.record(z.string(), z.unknown()), {});
  }

  async set(
    extensionId: string,
    entityType: ExtensionData['entityType'],
    entityId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(data);
    } catch {
      throw new Error('ExtensionDataRepository.set: data is not JSON-serializable');
    }
    if (typeof serialized !== 'string') {
      throw new Error('ExtensionDataRepository.set: data is not JSON-serializable');
    }
    if (serialized.length > MAX_DATA_BYTES) {
      throw new Error(`ExtensionDataRepository.set: data exceeds ${MAX_DATA_BYTES} bytes`);
    }
    await this.client.execute({
      sql: `INSERT INTO extension_data (extension_id, entity_type, entity_id, data)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(extension_id, entity_type, entity_id) DO UPDATE SET data = excluded.data`,
      args: [extensionId, entityType, entityId, serialized],
    });
  }

  async delete(extensionId: string, entityType: ExtensionData['entityType'], entityId: string): Promise<void> {
    const rs = await this.client.execute({
      sql: 'DELETE FROM extension_data WHERE extension_id = ? AND entity_type = ? AND entity_id = ?',
      args: [extensionId, entityType, entityId],
    });
    if (rs.rowsAffected === 0) {
      throw new NotFoundError('ExtensionData', `${extensionId}/${entityType}/${entityId}`);
    }
  }

  async deleteIfExists(extensionId: string, entityType: ExtensionData['entityType'], entityId: string): Promise<void> {
    try {
      await this.delete(extensionId, entityType, entityId);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  async listForEntity(entityType: ExtensionData['entityType'], entityId: string): Promise<ExtensionData[]> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM extension_data WHERE entity_type = ? AND entity_id = ? ORDER BY extension_id',
      args: [entityType, entityId],
    });
    return mapRowsLenient(rs.rows, rowToExtensionData, 'ExtensionDataRepository.listForEntity');
  }
}
