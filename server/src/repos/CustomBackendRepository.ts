/**
 * CustomBackend repository — named Lua-driven backend adapters.
 *
 * Each row is a Lua script (`lua_source`) implementing `generate(prompt, ctx)`,
 * selectable from a backend config via provider `custom` +
 * `providerParams.customBackendId`. See docs/design/scriptable-layers.md §2.
 */

import type { Client, InValue } from '@libsql/client';
import type { CustomBackend, CustomBackendInsert, CustomBackendUpdate } from '@tamari/types';
import { CustomBackendSchema, CustomBackendRowSchema } from '@tamari/types';
import { mapRowsLenient } from './rows.js';

export interface ICustomBackendRepository {
  list(): Promise<CustomBackend[]>;
  getById(id: string): Promise<CustomBackend | undefined>;
  create(id: string, data: CustomBackendInsert): Promise<CustomBackend>;
  update(id: string, patch: CustomBackendUpdate): Promise<CustomBackend>;
  delete(id: string): Promise<void>;
}

function rowToCustomBackend(row: unknown): CustomBackend {
  const r = CustomBackendRowSchema.parse(row);
  return CustomBackendSchema.parse({
    id: r.id,
    name: r.name,
    description: r.description,
    luaSource: r.lua_source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

export class CustomBackendRepository implements ICustomBackendRepository {
  constructor(private client: Client) {}

  async list(): Promise<CustomBackend[]> {
    const rs = await this.client.execute('SELECT * FROM custom_backends ORDER BY name, id');
    return mapRowsLenient(rs.rows, rowToCustomBackend, 'CustomBackendRepository.list');
  }

  async getById(id: string): Promise<CustomBackend | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM custom_backends WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToCustomBackend(rs.rows[0]);
  }

  async create(id: string, data: CustomBackendInsert): Promise<CustomBackend> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO custom_backends (id, name, description, lua_source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, data.name, data.description, data.luaSource, now, now],
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created custom backend: ${id}`);
    return created;
  }

  async update(id: string, patch: CustomBackendUpdate): Promise<CustomBackend> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Custom backend not found: ${id}`);

    const sets: string[] = [];
    const values: InValue[] = [];
    const add = (col: string, val: InValue) => {
      sets.push(`${col} = ?`);
      values.push(val);
    };

    if (patch.name !== undefined) add('name', patch.name);
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.luaSource !== undefined) add('lua_source', patch.luaSource);
    add('updated_at', Math.floor(Date.now() / 1000));

    await this.client.execute({
      sql: `UPDATE custom_backends SET ${sets.join(', ')} WHERE id = ?`,
      args: [...values, id],
    });
    const updated = await this.getById(id);
    if (!updated) throw new Error(`Failed to retrieve updated custom backend: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.client.execute({ sql: 'DELETE FROM custom_backends WHERE id = ?', args: [id] });
  }
}
