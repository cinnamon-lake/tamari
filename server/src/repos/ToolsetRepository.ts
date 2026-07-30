import type { Client } from '@libsql/client';
import { z } from 'zod';
import { ToolsetRowSchema } from '@tamari/types';
import type { Toolset, ToolsetCreateInput, ToolsetUpdateInput } from '@tamari/types';
import { safeParseJson } from '../lib/safeJson.js';
import { NotFoundError } from '../errors.js';
import { mapRowsLenient } from './rows.js';

function rowToToolset(row: unknown): Toolset {
  const r = ToolsetRowSchema.parse(row);
  return {
    id: r.id,
    templateId: r.template_id,
    name: r.name,
    config: safeParseJson(r.config, z.record(z.string(), z.unknown()), {}),
    toolOverrides: safeParseJson(r.tool_overrides, z.record(z.string(), z.unknown()), {}) as unknown as Toolset['toolOverrides'],
    enabled: Boolean(r.enabled),
    agentVisible: Boolean(r.agent_visible),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface IToolsetRepository {
  list(): Promise<Toolset[]>;
  listEnabled(): Promise<Toolset[]>;
  /** Enabled toolsets explicitly marked as visible to sub-agents. */
  listAgentVisible(): Promise<Toolset[]>;
  getById(id: string): Promise<Toolset | undefined>;
  create(id: string, data: ToolsetCreateInput): Promise<Toolset>;
  update(id: string, patch: ToolsetUpdateInput): Promise<Toolset>;
  delete(id: string): Promise<void>;
}

export class ToolsetRepository implements IToolsetRepository {
  constructor(private client: Client) {}

  async list(): Promise<Toolset[]> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM toolsets ORDER BY created_at DESC',
      args: [],
    });
    return mapRowsLenient(rs.rows, rowToToolset, 'ToolsetRepository.list');
  }

  async listEnabled(): Promise<Toolset[]> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM toolsets WHERE enabled = 1 ORDER BY created_at DESC',
      args: [],
    });
    return mapRowsLenient(rs.rows, rowToToolset, 'ToolsetRepository.listEnabled');
  }

  async listAgentVisible(): Promise<Toolset[]> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM toolsets WHERE enabled = 1 AND agent_visible = 1 ORDER BY created_at DESC',
      args: [],
    });
    return mapRowsLenient(rs.rows, rowToToolset, 'ToolsetRepository.listAgentVisible');
  }

  async getById(id: string): Promise<Toolset | undefined> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM toolsets WHERE id = ?',
      args: [id],
    });
    if (rs.rows.length === 0) return undefined;
    return rowToToolset(rs.rows[0]);
  }

  async create(id: string, data: ToolsetCreateInput): Promise<Toolset> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO toolsets (id, template_id, name, config, tool_overrides, enabled, agent_visible, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      /* eslint-disable @typescript-eslint/no-unnecessary-condition -- defensive fallbacks for unvalidated API input */
      args: [
        id,
        data.templateId,
        data.name,
        JSON.stringify(data.config ?? {}),
        JSON.stringify(data.toolOverrides ?? {}),
        data.enabled ? 1 : 0,
        data.agentVisible ? 1 : 0,
        now,
        now,
      ],
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created toolset: ${id}`);
    return created;
  }

  async update(id: string, patch: ToolsetUpdateInput): Promise<Toolset> {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      args.push(patch.name);
    }
    if (patch.templateId !== undefined) {
      sets.push('template_id = ?');
      args.push(patch.templateId);
    }
    if (patch.config !== undefined) {
      sets.push('config = ?');
      args.push(JSON.stringify(patch.config));
    }
    if (patch.toolOverrides !== undefined) {
      sets.push('tool_overrides = ?');
      args.push(JSON.stringify(patch.toolOverrides));
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      args.push(patch.enabled ? 1 : 0);
    }
    if (patch.agentVisible !== undefined) {
      sets.push('agent_visible = ?');
      args.push(patch.agentVisible ? 1 : 0);
    }

    sets.push('updated_at = ?');
    args.push(Math.floor(Date.now() / 1000));
    args.push(id);

    await this.client.execute({
      sql: `UPDATE toolsets SET ${sets.join(', ')} WHERE id = ?`,
      args,
    });

    const updated = await this.getById(id);
    if (!updated) throw new NotFoundError('Toolset', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({
      sql: 'DELETE FROM toolsets WHERE id = ?',
      args: [id],
    });
    if (rs.rowsAffected === 0) throw new NotFoundError('Toolset', id);
  }}
