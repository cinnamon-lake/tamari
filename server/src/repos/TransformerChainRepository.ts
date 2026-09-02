/**
 * TransformerChain repository — named, ordered chains of request
 * transformers (built-in steps + Lua script steps) referenced by backend
 * configs via `backend_configs.transformer_chain_id`.
 *
 * Steps persist as JSON in `steps_json` (`TransformerStep[]`); Lua steps
 * reference rows in `transformer_scripts` by id.
 */

import type { Client, InValue } from '@libsql/client';
import type { TransformerChain, TransformerChainInsert, TransformerChainUpdate } from '@tamari/types';
import { TransformerChainSchema, TransformerChainRowSchema, TransformerStepSchema } from '@tamari/types';
import { z } from 'zod';
import { safeParseJson } from '../lib/safeJson.js';
import { mapRowsLenient } from './rows.js';

export interface ITransformerChainRepository {
  list(): Promise<TransformerChain[]>;
  getById(id: string): Promise<TransformerChain | undefined>;
  create(id: string, data: TransformerChainInsert): Promise<TransformerChain>;
  update(id: string, patch: TransformerChainUpdate): Promise<TransformerChain>;
  delete(id: string): Promise<void>;
}

function rowToTransformerChain(row: unknown): TransformerChain {
  const r = TransformerChainRowSchema.parse(row);
  return TransformerChainSchema.parse({
    id: r.id,
    name: r.name,
    description: r.description,
    steps: safeParseJson(r.steps_json, z.array(TransformerStepSchema), []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

export class TransformerChainRepository implements ITransformerChainRepository {
  constructor(private client: Client) {}

  async list(): Promise<TransformerChain[]> {
    const rs = await this.client.execute('SELECT * FROM transformer_chains ORDER BY name, id');
    return mapRowsLenient(rs.rows, rowToTransformerChain, 'TransformerChainRepository.list');
  }

  async getById(id: string): Promise<TransformerChain | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM transformer_chains WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToTransformerChain(rs.rows[0]);
  }

  async create(id: string, data: TransformerChainInsert): Promise<TransformerChain> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO transformer_chains (id, name, description, steps_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, data.name, data.description, JSON.stringify(data.steps), now, now],
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created transformer chain: ${id}`);
    return created;
  }

  async update(id: string, patch: TransformerChainUpdate): Promise<TransformerChain> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Transformer chain not found: ${id}`);

    const sets: string[] = [];
    const values: InValue[] = [];
    const add = (col: string, val: InValue) => {
      sets.push(`${col} = ?`);
      values.push(val);
    };

    if (patch.name !== undefined) add('name', patch.name);
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.steps !== undefined) add('steps_json', JSON.stringify(patch.steps));
    add('updated_at', Math.floor(Date.now() / 1000));

    await this.client.execute({
      sql: `UPDATE transformer_chains SET ${sets.join(', ')} WHERE id = ?`,
      args: [...values, id],
    });
    const updated = await this.getById(id);
    if (!updated) throw new Error(`Failed to retrieve updated transformer chain: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.client.execute({ sql: 'DELETE FROM transformer_chains WHERE id = ?', args: [id] });
  }
}
