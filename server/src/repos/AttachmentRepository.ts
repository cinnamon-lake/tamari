/**
 * Attachment repository — stores files (images, etc.) linked to messages.
 */

import type { Client } from '@libsql/client';
import { z } from 'zod';
import { AttachmentRowSchema } from '@tamari/types';
import type { Attachment } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { safeParseJson } from '../lib/safeJson.js';
import { mapRowsLenient } from './rows.js';

export interface AttachmentCreateParams {
  id: string;
  messageId: number | null;
  mimeType: string;
  filePath: string;
  meta?: Record<string, unknown>;
}

export interface IAttachmentRepository {
  create(params: AttachmentCreateParams): Promise<Attachment>;
  getById(id: string): Promise<Attachment | undefined>;
  getByIds(ids: string[]): Promise<Attachment[]>;
  listByMessage(messageId: number): Promise<Attachment[]>;
  linkToMessage(id: string, messageId: number): Promise<Attachment>;
  delete(id: string): Promise<void>;
}

function attachmentUrl(id: string): string {
  return `/api/attachments/${id}`;
}

function rowToAttachment(row: unknown): Attachment {
  const r = AttachmentRowSchema.parse(row);
  return {
    id: r.id,
    messageId: r.message_id,
    mimeType: r.mime_type,
    filePath: r.file_path ?? '',
    meta: safeParseJson(r.meta, z.record(z.string(), z.unknown()), {}),
    url: attachmentUrl(r.id),
  };
}

export class AttachmentRepository implements IAttachmentRepository {
  constructor(private client: Client) {}

  async create(params: AttachmentCreateParams): Promise<Attachment> {
    const { id, messageId, mimeType, filePath, meta = {} } = params;
    await this.client.execute({
      sql: `INSERT INTO attachments (id, message_id, mime_type, file_path, meta) VALUES (?, ?, ?, ?, ?)`,
      args: [id, messageId, mimeType, filePath, JSON.stringify(meta)],
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created attachment: ${id}`);
    return created;
  }

  async getById(id: string): Promise<Attachment | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM attachments WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToAttachment(rs.rows[0]);
  }

  async getByIds(ids: string[]): Promise<Attachment[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rs = await this.client.execute({
      sql: `SELECT * FROM attachments WHERE id IN (${placeholders})`,
      args: ids,
    });
    const byId = new Map(mapRowsLenient(rs.rows, rowToAttachment, 'AttachmentRepository.getByIds').map((a) => [a.id, a]));
    return ids.map((id) => byId.get(id)).filter((a): a is Attachment => a !== undefined);
  }

  async listByMessage(messageId: number): Promise<Attachment[]> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM attachments WHERE message_id = ?',
      args: [messageId],
    });
    return mapRowsLenient(rs.rows, rowToAttachment, 'AttachmentRepository.listByMessage');
  }

  async linkToMessage(id: string, messageId: number): Promise<Attachment> {
    const rs = await this.client.execute({
      sql: 'UPDATE attachments SET message_id = ? WHERE id = ? RETURNING *',
      args: [messageId, id],
    });
    if (rs.rows.length === 0) throw new NotFoundError('Attachment', id);
    return rowToAttachment(rs.rows[0]);
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({ sql: 'DELETE FROM attachments WHERE id = ?', args: [id] });
    if (rs.rowsAffected === 0) throw new NotFoundError('Attachment', id);
  }
}
