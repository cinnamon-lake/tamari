/**
 * World Info / Lorebook repository.
 */

import type { Client } from '@libsql/client';
import type { InValue } from '@libsql/core/api';
import { z } from 'zod';
import type { WorldInfo, WorldInfoInsert, WorldInfoUpdate } from '@tamari/types';
import { WorldInfoRowSchema, WorldInfoEntrySchema } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { safeParseJson } from '../lib/safeJson.js';
import { mapRowsLenient } from './rows.js';

export interface IWorldInfoRepository {
  getById(id: string): Promise<WorldInfo | undefined>;
  list(): Promise<WorldInfo[]>;
  create(id: string, data: WorldInfoInsert): Promise<WorldInfo>;
  update(id: string, patch: WorldInfoUpdate): Promise<WorldInfo>;
  delete(id: string): Promise<void>;
}

function rowToWorldInfo(row: unknown): WorldInfo {
  const r = WorldInfoRowSchema.parse(row);
  return {
    id: r.id,
    name: r.name,
    entries: safeParseJson(r.entries, z.array(WorldInfoEntrySchema), []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class WorldInfoRepository implements IWorldInfoRepository {
  constructor(private client: Client) {}

  async getById(id: string): Promise<WorldInfo | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM world_info WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToWorldInfo(rs.rows[0]);
  }

  async list(): Promise<WorldInfo[]> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM world_info ORDER BY updated_at DESC, id DESC' });
    return mapRowsLenient(rs.rows, rowToWorldInfo, 'WorldInfoRepository.list');
  }

  async create(id: string, data: WorldInfoInsert): Promise<WorldInfo> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO world_info (id, name, entries, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive fallback for unvalidated API input
      args: [id, data.name, JSON.stringify(data.entries ?? []), now, now],
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created world info: ${id}`);
    return created;
  }

  async update(id: string, patch: WorldInfoUpdate): Promise<WorldInfo> {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundError('WorldInfo', id);

    const sets: string[] = [];
    const values: InValue[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.entries !== undefined) {
      sets.push('entries = ?');
      values.push(JSON.stringify(patch.entries));
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);

    await this.client.execute({ sql: `UPDATE world_info SET ${sets.join(', ')} WHERE id = ?`, args: values });
    const updated = await this.getById(id);
    if (!updated) throw new NotFoundError('WorldInfo', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({ sql: 'DELETE FROM world_info WHERE id = ?', args: [id] });
    if (rs.rowsAffected === 0) throw new NotFoundError('WorldInfo', id);
  }
}
