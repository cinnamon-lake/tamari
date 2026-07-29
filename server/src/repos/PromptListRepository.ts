/**
 * PromptList repository — prompt collection and ordering storage.
 */

import { safeParseJson } from '../lib/safeJson.js';
import { str } from '../lib/coerce.js';
import type { Client, InValue } from '@libsql/client';
import type { PromptList, PromptListInsert, PromptListUpdate } from '@tamari/types';
import { PromptListSchema, PresetPromptDefSchema, PresetPromptOrderEntrySchema, PromptListRowSchema } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { mapRowsLenient } from './rows.js';
import { z } from 'zod';

export interface IPromptListRepository {
  list(): Promise<PromptList[]>;
  listSummaries(): Promise<Array<Pick<PromptList, 'id' | 'name'>>>;
  getById(id: string): Promise<PromptList | undefined>;
  create(id: string, data: PromptListInsert): Promise<PromptList>;
  update(id: string, patch: PromptListUpdate): Promise<PromptList>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}

function rowToPromptList(row: unknown): PromptList {
  const r = PromptListRowSchema.parse(row);
  return PromptListSchema.parse({
    id: r.id,
    name: r.name,
    description: r.description,
    prompts: safeParseJson(r.prompts_json, z.array(PresetPromptDefSchema), []),
    promptOrder: safeParseJson(r.prompt_order_json, z.array(PresetPromptOrderEntrySchema), []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

export class PromptListRepository implements IPromptListRepository {
  constructor(private client: Client) {}

  async list(): Promise<PromptList[]> {
    const rs = await this.client.execute('SELECT * FROM prompt_lists ORDER BY name, id');
    return mapRowsLenient(rs.rows, rowToPromptList, 'PromptListRepository.list');
  }

  async listSummaries(): Promise<Array<Pick<PromptList, 'id' | 'name'>>> {
    const rs = await this.client.execute('SELECT id, name FROM prompt_lists ORDER BY name, id');
    return rs.rows.map((r) => ({
      id: str(r.id),
      name: str(r.name),
    }));
  }

  async getById(id: string): Promise<PromptList | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM prompt_lists WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToPromptList(rs.rows[0]);
  }

  async create(id: string, data: PromptListInsert): Promise<PromptList> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO prompt_lists (
        id, name, description, prompts_json, prompt_order_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      /* eslint-disable @typescript-eslint/no-unnecessary-condition -- defensive fallbacks for unvalidated API input */
      args: [
        id,
        data.name,
        data.description ?? '',
        JSON.stringify(data.prompts ?? []),
        JSON.stringify(data.promptOrder ?? []),
        now,
        now,
      ],
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created prompt list: ${id}`);
    return created;
  }

  async update(id: string, patch: PromptListUpdate): Promise<PromptList> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Prompt list not found: ${id}`);

    const sets: string[] = [];
    const values: InValue[] = [];

    const add = (col: string, val: InValue) => {
      sets.push(`${col} = ?`);
      values.push(val);
    };

    if (patch.name !== undefined) add('name', patch.name);
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.prompts !== undefined) add('prompts_json', JSON.stringify(patch.prompts));
    if (patch.promptOrder !== undefined) add('prompt_order_json', JSON.stringify(patch.promptOrder));

    const now = Math.floor(Date.now() / 1000);
    sets.push('updated_at = ?');
    values.push(now);
    values.push(id);

    await this.client.execute({
      sql: `UPDATE prompt_lists SET ${sets.join(', ')} WHERE id = ?`,
      args: values,
    });

    const updated = await this.getById(id);
    if (!updated) throw new Error(`Failed to retrieve updated prompt list: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({ sql: 'DELETE FROM prompt_lists WHERE id = ?', args: [id] });
    if (rs.rowsAffected === 0) throw new NotFoundError('PromptList', id);
  }

  async count(): Promise<number> {
    const rs = await this.client.execute('SELECT COUNT(*) as count FROM prompt_lists');
    return Number(rs.rows[0]?.count ?? 0);
  }
}
