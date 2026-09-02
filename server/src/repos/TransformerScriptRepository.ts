/**
 * TransformerScript repository — user-authored Lua request transformers.
 *
 * Each row is a Lua script (`lua_source`) that receives the rendered prompt
 * as a mutable `messages` array (plus a `ctx` table) and rewrites it in
 * place or returns a new array. Scripts run as `lua` steps inside a
 * transformer chain (server/src/transformers/luaRunner.ts).
 */

import type { Client, InValue } from '@libsql/client';
import type { TransformerScript, TransformerScriptInsert, TransformerScriptUpdate } from '@tamari/types';
import { TransformerScriptSchema, TransformerScriptRowSchema } from '@tamari/types';
import { mapRowsLenient } from './rows.js';

export interface ITransformerScriptRepository {
  list(): Promise<TransformerScript[]>;
  getById(id: string): Promise<TransformerScript | undefined>;
  create(id: string, data: TransformerScriptInsert): Promise<TransformerScript>;
  update(id: string, patch: TransformerScriptUpdate): Promise<TransformerScript>;
  delete(id: string): Promise<void>;
}

function rowToTransformerScript(row: unknown): TransformerScript {
  const r = TransformerScriptRowSchema.parse(row);
  return TransformerScriptSchema.parse({
    id: r.id,
    name: r.name,
    description: r.description,
    luaSource: r.lua_source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

export class TransformerScriptRepository implements ITransformerScriptRepository {
  constructor(private client: Client) {}

  async list(): Promise<TransformerScript[]> {
    const rs = await this.client.execute('SELECT * FROM transformer_scripts ORDER BY name, id');
    return mapRowsLenient(rs.rows, rowToTransformerScript, 'TransformerScriptRepository.list');
  }

  async getById(id: string): Promise<TransformerScript | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM transformer_scripts WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToTransformerScript(rs.rows[0]);
  }

  async create(id: string, data: TransformerScriptInsert): Promise<TransformerScript> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO transformer_scripts (id, name, description, lua_source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, data.name, data.description, data.luaSource, now, now],
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created transformer script: ${id}`);
    return created;
  }

  async update(id: string, patch: TransformerScriptUpdate): Promise<TransformerScript> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Transformer script not found: ${id}`);

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
      sql: `UPDATE transformer_scripts SET ${sets.join(', ')} WHERE id = ?`,
      args: [...values, id],
    });
    const updated = await this.getById(id);
    if (!updated) throw new Error(`Failed to retrieve updated transformer script: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.client.execute({ sql: 'DELETE FROM transformer_scripts WHERE id = ?', args: [id] });
  }
}
