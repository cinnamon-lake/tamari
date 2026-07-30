/**
 * Generation repository — tracks the lifecycle of AI generation jobs.
 */

import type { Client } from '@libsql/client';
import type { Generation, GenerationInsert } from '@tamari/types';
import { GenerationRowSchema } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { mapRowsLenient } from './rows.js';

export interface IGenerationRepository {
  getById(id: string): Promise<Generation | undefined>;
  listByChat(chatId: string): Promise<Generation[]>;
  create(id: string, data: Omit<GenerationInsert, 'id'>): Promise<Generation>;
  update(id: string, patch: Partial<Omit<Generation, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Generation>;
  delete(id: string): Promise<void>;
}

function rowToGeneration(row: unknown): Generation {
  const r = GenerationRowSchema.parse(row);
  return {
    id: r.id,
    chatId: r.chat_id,
    messageId: r.message_id,
    status: r.status,
    backend: r.backend,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    errorMessage: r.error_message,
    kind: r.kind,
    parentId: r.parent_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class GenerationRepository implements IGenerationRepository {
  constructor(private client: Client) {}

  async getById(id: string): Promise<Generation | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM generations WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToGeneration(rs.rows[0]);
  }

  async listByChat(chatId: string): Promise<Generation[]> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM generations WHERE chat_id = ? ORDER BY created_at DESC, id DESC',
      args: [chatId],
    });
    return mapRowsLenient(rs.rows, rowToGeneration, 'GenerationRepository.listByChat');
  }

  async create(id: string, data: Omit<GenerationInsert, 'id'>): Promise<Generation> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO generations (id, chat_id, message_id, status, backend, prompt_tokens, completion_tokens, error_message, kind, parent_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        data.chatId,
        data.messageId ?? null,
        data.status,
        data.backend,
        data.promptTokens ?? null,
        data.completionTokens ?? null,
        data.errorMessage ?? null,
        data.kind ?? 'send',
        data.parentId ?? null,
        now,
        now,
      ],
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created generation: ${id}`);
    return created;
  }

  async update(id: string, patch: Partial<Omit<Generation, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Generation> {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundError('Generation', id);

    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (patch.chatId !== undefined) {
      sets.push('chat_id = ?');
      values.push(patch.chatId);
    }
    if (patch.messageId !== undefined) {
      sets.push('message_id = ?');
      values.push(patch.messageId);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.backend !== undefined) {
      sets.push('backend = ?');
      values.push(patch.backend);
    }
    if (patch.promptTokens !== undefined) {
      sets.push('prompt_tokens = ?');
      values.push(patch.promptTokens);
    }
    if (patch.completionTokens !== undefined) {
      sets.push('completion_tokens = ?');
      values.push(patch.completionTokens);
    }
    if (patch.errorMessage !== undefined) {
      sets.push('error_message = ?');
      values.push(patch.errorMessage);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);

    await this.client.execute({ sql: `UPDATE generations SET ${sets.join(', ')} WHERE id = ?`, args: values });
    const updated = await this.getById(id);
    if (!updated) throw new NotFoundError('Generation', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({ sql: 'DELETE FROM generations WHERE id = ?', args: [id] });
    if (rs.rowsAffected === 0) throw new NotFoundError('Generation', id);
  }
}
