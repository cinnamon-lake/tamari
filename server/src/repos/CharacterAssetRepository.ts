/**
 * Character asset repository — CRUD for character_assets table.
 */

import type { Client } from '@libsql/client';
import { z } from 'zod';
import type { CharacterAsset, CharacterAssetInsert } from '@tamari/types';
import { CharacterAssetRowSchema } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { safeParseJson } from '../lib/safeJson.js';
import { mapRowsLenient } from './rows.js';

function rowToAsset(row: unknown): CharacterAsset {
  const r = CharacterAssetRowSchema.parse(row);
  return {
    id: r.id,
    characterId: r.character_id,
    name: r.name,
    type: r.type,
    ext: r.ext,
    filePath: r.file_path,
    meta: safeParseJson(r.meta, z.record(z.string(), z.unknown()), {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface ICharacterAssetRepository {
  listForCharacter(characterId: string): Promise<CharacterAsset[]>;
  getById(id: string): Promise<CharacterAsset | undefined>;
  create(characterId: string, data: CharacterAssetInsert): Promise<CharacterAsset>;
  deleteForCharacter(characterId: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export class CharacterAssetRepository implements ICharacterAssetRepository {
  constructor(private client: Client) {}

  async listForCharacter(characterId: string): Promise<CharacterAsset[]> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM character_assets WHERE character_id = ? ORDER BY created_at, id ASC',
      args: [characterId],
    });
    return mapRowsLenient(rs.rows, rowToAsset, 'CharacterAssetRepository.listForCharacter');
  }

  async getById(id: string): Promise<CharacterAsset | undefined> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM character_assets WHERE id = ?',
      args: [id],
    });
    if (rs.rows.length === 0) return undefined;
    return rowToAsset(rs.rows[0]);
  }

  async create(characterId: string, data: CharacterAssetInsert): Promise<CharacterAsset> {
    const id = data.id ?? crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO character_assets (
        id, character_id, name, type, ext, file_path, meta, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      /* eslint-disable @typescript-eslint/no-unnecessary-condition -- defensive fallbacks for unvalidated API input */
      args: [
        id,
        characterId,
        data.name ?? '',
        data.type ?? 'other',
        data.ext ?? 'png',
        data.filePath ?? null,
        JSON.stringify(data.meta ?? {}),
        now,
        now,
      ],
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    });
    const assets = await this.listForCharacter(characterId);
    const created = assets.find((a) => a.id === id);
    if (!created) throw new Error(`Failed to retrieve created character asset: ${id}`);
    return created;
  }

  async deleteForCharacter(characterId: string): Promise<void> {
    await this.client.execute({
      sql: 'DELETE FROM character_assets WHERE character_id = ?',
      args: [characterId],
    });
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({
      sql: 'DELETE FROM character_assets WHERE id = ?',
      args: [id],
    });
    if (rs.rowsAffected === 0) throw new NotFoundError('CharacterAsset', id);
  }
}
