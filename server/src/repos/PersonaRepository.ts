/**
 * Persona repository.
 */

import type { Client } from '@libsql/client';
import type { Transaction, TransactionMode } from '@libsql/core/api';
import type { InValue } from '@libsql/core/api';
import { PersonaRowSchema, PersonaSummaryRowSchema } from '@tamari/types';
import type { Persona, PersonaInsert, PersonaUpdate } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { mapRowsLenient } from './rows.js';

export interface IPersonaRepository {
  getById(id: string): Promise<Persona | undefined>;
  getByIds(ids: string[]): Promise<Persona[]>;
  list(): Promise<Persona[]>;
  listSummaries(): Promise<
    Array<Pick<Persona, 'id' | 'name' | 'description' | 'avatarPath' | 'avatarThumbnailPath'>>
  >;
  create(id: string, data: PersonaInsert): Promise<Persona>;
  update(id: string, patch: PersonaUpdate): Promise<Persona>;
  delete(id: string): Promise<void>;
  /**
   * Atomically reassign all chats from `fromId` to `toId` (skipped when `toId`
   * is null) and delete persona `fromId`, in a single transaction.
   */
  deleteAndReassign(fromId: string, toId: string | null): Promise<void>;
  count(): Promise<number>;
}

function rowToPersona(row: unknown): Persona {
  const r = PersonaRowSchema.parse(row);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    avatarPath: r.avatar_path,
    avatarThumbnailPath: r.avatar_thumbnail_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToPersonaSummary(
  row: unknown,
): Pick<Persona, 'id' | 'name' | 'description' | 'avatarPath' | 'avatarThumbnailPath'> {
  const r = PersonaSummaryRowSchema.parse(row);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    avatarPath: r.avatar_path,
    avatarThumbnailPath: r.avatar_thumbnail_path,
  };
}

export class PersonaRepository implements IPersonaRepository {
  constructor(private client: Client) {}

  /** Internal transaction helper — raw transactions never leave the repo. */
  private async withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const mode: TransactionMode = 'write';
    const tx = await this.client.transaction(mode);
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  async getById(id: string): Promise<Persona | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM personas WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToPersona(rs.rows[0]);
  }

  async getByIds(ids: string[]): Promise<Persona[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rs = await this.client.execute({
      sql: `SELECT * FROM personas WHERE id IN (${placeholders})`,
      args: ids,
    });
    const byId = new Map(
      mapRowsLenient(rs.rows, rowToPersona, 'PersonaRepository.getByIds').map((persona) => [persona.id, persona]),
    );
    return ids.map((id) => byId.get(id)).filter((p): p is Persona => p !== undefined);
  }

  async list(): Promise<Persona[]> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM personas ORDER BY updated_at DESC, id DESC' });
    return mapRowsLenient(rs.rows, rowToPersona, 'PersonaRepository.list');
  }

  async listSummaries(): Promise<
    Array<Pick<Persona, 'id' | 'name' | 'description' | 'avatarPath' | 'avatarThumbnailPath'>>
  > {
    const rs = await this.client.execute({
      sql: 'SELECT id, name, description, avatar_path, avatar_thumbnail_path FROM personas ORDER BY updated_at DESC, id DESC',
    });
    return mapRowsLenient(rs.rows, rowToPersonaSummary, 'PersonaRepository.listSummaries');
  }

  async create(id: string, data: PersonaInsert): Promise<Persona> {
    const now = Math.floor(Date.now() / 1000);

    await this.client.execute({
      sql: `INSERT INTO personas (id, name, description, avatar_path, avatar_thumbnail_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, data.name, data.description ?? '', data.avatarPath ?? null, data.avatarThumbnailPath ?? null, now, now],
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created persona: ${id}`);
    return created;
  }

  async update(id: string, patch: PersonaUpdate): Promise<Persona> {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundError('Persona', id);

    const sets: string[] = [];
    const values: InValue[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      values.push(patch.description);
    }
    if (patch.avatarPath !== undefined) {
      sets.push('avatar_path = ?');
      values.push(patch.avatarPath);
    }
    if (patch.avatarThumbnailPath !== undefined) {
      sets.push('avatar_thumbnail_path = ?');
      values.push(patch.avatarThumbnailPath);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);

    await this.client.execute({ sql: `UPDATE personas SET ${sets.join(', ')} WHERE id = ?`, args: values });
    const updated = await this.getById(id);
    if (!updated) throw new NotFoundError('Persona', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({ sql: 'DELETE FROM personas WHERE id = ?', args: [id] });
    if (rs.rowsAffected === 0) throw new NotFoundError('Persona', id);
  }

  async deleteAndReassign(fromId: string, toId: string | null): Promise<void> {
    await this.withTransaction(async (tx) => {
      if (toId !== null) {
        await tx.execute({
          sql: 'UPDATE chats SET persona_id = ? WHERE persona_id = ?',
          args: [toId, fromId],
        });
      }
      await tx.execute({ sql: 'DELETE FROM personas WHERE id = ?', args: [fromId] });
    });
  }

  async count(): Promise<number> {
    const rs = await this.client.execute('SELECT COUNT(*) as count FROM personas');
    return Number(rs.rows[0]?.count ?? 0);
  }
}
