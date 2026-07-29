import type { Client } from '@libsql/client';
import { z } from 'zod';
import { ToolTemplateRowSchema } from '@tamari/types';
import { LuaSandboxFlagsSchema } from '@tamari/types';
import type { ToolTemplate, ToolTemplateCreateInput, ToolTemplateUpdateInput } from '@tamari/types';
import { safeParseJson } from '../lib/safeJson.js';
import { NotFoundError } from '../errors.js';
import { mapRowsLenient } from './rows.js';

function rowToToolTemplate(row: unknown): ToolTemplate {
  const r = ToolTemplateRowSchema.parse(row);
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    configSchema: safeParseJson(r.config_schema, z.record(z.string(), z.unknown()), {}),
    sandbox: safeParseJson(r.sandbox, LuaSandboxFlagsSchema, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface IToolTemplateRepository {
  list(): Promise<ToolTemplate[]>;
  getById(id: string): Promise<ToolTemplate | undefined>;
  create(id: string, data: ToolTemplateCreateInput): Promise<ToolTemplate>;
  update(id: string, patch: ToolTemplateUpdateInput): Promise<ToolTemplate>;
  delete(id: string): Promise<void>;
}

export class ToolTemplateRepository implements IToolTemplateRepository {
  constructor(private client: Client) {}

  async list(): Promise<ToolTemplate[]> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM tool_templates ORDER BY created_at DESC',
      args: [],
    });
    return mapRowsLenient(rs.rows, rowToToolTemplate, 'ToolTemplateRepository.list');
  }

  async getById(id: string): Promise<ToolTemplate | undefined> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM tool_templates WHERE id = ?',
      args: [id],
    });
    if (rs.rows.length === 0) return undefined;
    return rowToToolTemplate(rs.rows[0]);
  }

  async create(id: string, data: ToolTemplateCreateInput): Promise<ToolTemplate> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO tool_templates (id, name, code, config_schema, sandbox, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      /* eslint-disable @typescript-eslint/no-unnecessary-condition -- defensive fallbacks for unvalidated API input */
      args: [
        id,
        data.name,
        data.code,
        JSON.stringify(data.configSchema ?? {}),
        JSON.stringify(data.sandbox ?? {}),
        now,
        now,
      ],
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created tool template: ${id}`);
    return created;
  }

  async update(id: string, patch: ToolTemplateUpdateInput): Promise<ToolTemplate> {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      args.push(patch.name);
    }
    if (patch.code !== undefined) {
      sets.push('code = ?');
      args.push(patch.code);
    }
    if (patch.configSchema !== undefined) {
      sets.push('config_schema = ?');
      args.push(JSON.stringify(patch.configSchema));
    }
    if (patch.sandbox !== undefined) {
      sets.push('sandbox = ?');
      args.push(JSON.stringify(patch.sandbox));
    }

    sets.push('updated_at = ?');
    args.push(Math.floor(Date.now() / 1000));
    args.push(id);

    await this.client.execute({
      sql: `UPDATE tool_templates SET ${sets.join(', ')} WHERE id = ?`,
      args,
    });

    const updated = await this.getById(id);
    if (!updated) throw new NotFoundError('ToolTemplate', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({
      sql: 'DELETE FROM tool_templates WHERE id = ?',
      args: [id],
    });
    if (rs.rowsAffected === 0) throw new NotFoundError('ToolTemplate', id);
  }
}
