/**
 * Quick Reply repository.
 */

import type { Client } from '@libsql/client';
import { QuickReplyRowSchema } from '@tamari/types';
import type { QuickReply, QuickReplyInsert, QuickReplyUpdate } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { mapRowsLenient } from './rows.js';

export interface IQuickReplyRepository {
  listByScope(scope: QuickReply['scope'], scopeId: string): Promise<QuickReply[]>;
  listAll(): Promise<QuickReply[]>;
  getById(id: string): Promise<QuickReply | undefined>;
  create(id: string, data: QuickReplyInsert): Promise<QuickReply>;
  update(id: string, patch: QuickReplyUpdate): Promise<QuickReply>;
  delete(id: string): Promise<void>;
  deleteByScope(scope: QuickReply['scope'], scopeId: string): Promise<void>;
}

/** Maps camelCase QuickReplyUpdate keys to their snake_case SQLite columns.
 *  The patch arrives in camelCase (domain layer); SQL columns are snake_case.
 *  Translating here (instead of checking camelCase keys against a snake_case set)
 *  avoids silently dropping multi-word fields like autoExecute / orderIndex / scopeId. */
const QR_FIELD_TO_COLUMN: Record<string, string> = {
  scope: 'scope',
  scopeId: 'scope_id',
  label: 'label',
  icon: 'icon',
  color: 'color',
  script: 'script',
  language: 'language',
  autoExecute: 'auto_execute',
  orderIndex: 'order_index',
};

function rowToQr(row: unknown): QuickReply {
  const r = QuickReplyRowSchema.parse(row);
  return {
    id: r.id,
    scope: r.scope,
    scopeId: r.scope_id,
    label: r.label,
    icon: r.icon,
    color: r.color,
    script: r.script,
    language: r.language,
    autoExecute: r.auto_execute,
    orderIndex: r.order_index,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class QuickReplyRepository implements IQuickReplyRepository {
  constructor(private client: Client) {}

  async listByScope(scope: QuickReply['scope'], scopeId: string): Promise<QuickReply[]> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM quick_replies WHERE scope = ? AND scope_id = ? ORDER BY order_index, created_at, id ASC',
      args: [scope, scopeId],
    });
    return mapRowsLenient(rs.rows, rowToQr, 'QuickReplyRepository.listByScope');
  }

  async listAll(): Promise<QuickReply[]> {
    const rs = await this.client.execute(
      'SELECT * FROM quick_replies ORDER BY order_index, created_at, id ASC',
    );
    return mapRowsLenient(rs.rows, rowToQr, 'QuickReplyRepository.listAll');
  }

  async getById(id: string): Promise<QuickReply | undefined> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM quick_replies WHERE id = ?',
      args: [id],
    });
    if (rs.rows.length === 0) return undefined;
    return rowToQr(rs.rows[0]);
  }

  async create(id: string, data: QuickReplyInsert): Promise<QuickReply> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO quick_replies
        (id, scope, scope_id, label, icon, color, script, language, auto_execute, order_index, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      /* eslint-disable @typescript-eslint/no-unnecessary-condition -- defensive fallbacks for unvalidated API input */
      args: [
        id,
        data.scope,
        data.scopeId,
        data.label,
        data.icon ?? '',
        data.color ?? '',
        data.script ?? '',
        data.language ?? 'lua',
        data.autoExecute ?? 0,
        data.orderIndex ?? 0,
        now,
        now,
      ],
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    });
    // Return the authoritative row re-read from the DB (not a spread of the
    // caller's data, which could omit DB-applied defaults).
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created quick reply: ${id}`);
    return created;
  }

  async update(id: string, patch: QuickReplyUpdate): Promise<QuickReply> {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundError('QuickReply', id);
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = QR_FIELD_TO_COLUMN[key];
      if (!column) continue; // unknown / non-updatable key
      fields.push(`${column} = ?`);
      values.push(value);
    }
    if (fields.length === 0) {
      return existing;
    }
    fields.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);
    await this.client.execute({
      sql: `UPDATE quick_replies SET ${fields.join(', ')} WHERE id = ?`,
      args: values,
    });
    // Return the authoritative row re-read from the DB (not a spread of the
    // caller's patch, which could carry un-persisted keys).
    const updated = await this.getById(id);
    if (!updated) throw new NotFoundError('QuickReply', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({
      sql: 'DELETE FROM quick_replies WHERE id = ?',
      args: [id],
    });
    if (rs.rowsAffected === 0) throw new NotFoundError('QuickReply', id);
  }

  async deleteByScope(scope: QuickReply['scope'], scopeId: string): Promise<void> {
    await this.client.execute({
      sql: 'DELETE FROM quick_replies WHERE scope = ? AND scope_id = ?',
      args: [scope, scopeId],
    });
  }
}
