/**
 * Character repository — CRUD + search for the characters table.
 */

import { safeParseJson } from '../lib/safeJson.js';
import { mapRowsLenient } from './rows.js';
import type { Client } from '@libsql/client';
import type { InValue } from '@libsql/core/api';
import { CharacterSchema, CharacterRowSchema, CharacterSummaryRowSchema } from '@tamari/types';
import type { Character, CharacterInsert, CharacterUpdate, WorldInfoEntry } from '@tamari/types';
import type {
  TavernCard,
  TavernCardV2Data,
  TavernCardV3Data,
  CharacterBookEntry,
} from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { z } from 'zod';

export interface ICharacterRepository {
  getById(id: string): Promise<Character | undefined>;
  getByIds(ids: string[]): Promise<Character[]>;
  getByName(name: string): Promise<Character | undefined>;
  list(opts?: {
    search?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Character[]; total: number }>;
  listSummaries(opts?: {
    search?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: Array<
      Pick<Character, 'id' | 'name' | 'tags' | 'avatarPath' | 'avatarThumbnailPath' | 'external' | 'createdAt' | 'updatedAt'>
    >;
    total: number;
  }>;
  create(id: string, data: CharacterInsert): Promise<Character>;
  update(id: string, patch: CharacterUpdate): Promise<Character>;
  delete(id: string): Promise<void>;
}

function rowToCharacter(row: unknown): Character {
  const r = CharacterRowSchema.parse(row);
  return CharacterSchema.parse({
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    personality: r.personality ?? '',
    scenario: r.scenario ?? '',
    firstMes: r.first_mes ?? '',
    mesExample: r.mes_example ?? '',
    creator: r.creator ?? '',
    characterVersion: r.character_version ?? '',
    tags: safeParseJson(r.tags, z.array(z.string()), []),
    avatarPath: r.avatar_path,
    avatarThumbnailPath: r.avatar_thumbnail_path,
    creatorNotes: r.creator_notes,
    systemPrompt: r.system_prompt,
    postHistoryInstructions: r.post_history_instructions,
    alternateGreetings: safeParseJson(r.alternate_greetings, z.array(z.string()), []),
    groupOnlyGreetings: safeParseJson(r.group_only_greetings, z.array(z.string()), []),
    nickname: r.nickname,
    creatorNotesMultilingual: safeParseJson(r.creator_notes_multilingual, z.record(z.string(), z.string()), {}),
    source: safeParseJson(r.source, z.array(z.string()), []),
    extensions: safeParseJson(r.extensions, z.record(z.string(), z.unknown()), {}),
    createDate: r.create_date,
    worldInfoId: r.world_info_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function rowToCharacterSummary(
  row: unknown,
): Pick<Character, 'id' | 'name' | 'tags' | 'avatarPath' | 'avatarThumbnailPath' | 'createdAt' | 'updatedAt'> {
  const r = CharacterSummaryRowSchema.parse(row);
  return {
    id: r.id,
    name: r.name,
    tags: safeParseJson(r.tags, z.array(z.string()), []),
    avatarPath: r.avatar_path,
    avatarThumbnailPath: r.avatar_thumbnail_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class CharacterRepository implements ICharacterRepository {
  constructor(private client: Client) {}

  async getById(id: string): Promise<Character | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM characters WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToCharacter(rs.rows[0]);
  }

  async getByIds(ids: string[]): Promise<Character[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rs = await this.client.execute({
      sql: `SELECT * FROM characters WHERE id IN (${placeholders})`,
      args: ids,
    });
    const byId = new Map(mapRowsLenient(rs.rows, rowToCharacter, 'CharacterRepository.getByIds').map((c) => [c.id, c]));
    return ids.map((id) => byId.get(id)).filter((c): c is Character => c !== undefined);
  }

  async getByName(name: string): Promise<Character | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM characters WHERE name = ? COLLATE NOCASE', args: [name] });
    if (rs.rows.length === 0) return undefined;
    return rowToCharacter(rs.rows[0]);
  }

  async list(
    opts: { search?: string; tag?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items: Character[]; total: number }> {
    const limit = opts.limit ?? 0;
    const offset = opts.offset ?? 0;

    const conditions: string[] = [];
    const params: InValue[] = [];

    if (opts.search) {
      conditions.push('name LIKE ?');
      params.push(`%${opts.search}%`);
    }
    if (opts.tag) {
      conditions.push('tags LIKE ?');
      params.push(`%"${opts.tag}"%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRs = await this.client.execute({
      sql: `SELECT COUNT(*) as total FROM characters ${where}`,
      args: params,
    });
    const limitClause = limit > 0 ? 'LIMIT ? OFFSET ?' : '';
    const args = limit > 0 ? [...params, limit, offset] : params;
    const rowsRs = await this.client.execute({
      sql: `SELECT * FROM characters ${where} ORDER BY updated_at DESC, id DESC ${limitClause}`,
      args,
    });

    return {
      items: mapRowsLenient(rowsRs.rows, rowToCharacter, 'CharacterRepository.list'),
      total: (totalRs.rows[0]?.total as number | undefined) ?? 0,
    };
  }

  async listSummaries(
    opts: { search?: string; tag?: string; limit?: number; offset?: number } = {},
  ): Promise<{
    items: Array<
      Pick<Character, 'id' | 'name' | 'tags' | 'avatarPath' | 'avatarThumbnailPath' | 'createdAt' | 'updatedAt'>
    >;
    total: number;
  }> {
    const limit = opts.limit ?? 0;
    const offset = opts.offset ?? 0;

    const conditions: string[] = [];
    const params: InValue[] = [];

    if (opts.search) {
      conditions.push('name LIKE ?');
      params.push(`%${opts.search}%`);
    }
    if (opts.tag) {
      conditions.push('tags LIKE ?');
      params.push(`%"${opts.tag}"%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRs = await this.client.execute({
      sql: `SELECT COUNT(*) as total FROM characters ${where}`,
      args: params,
    });
    const limitClause = limit > 0 ? 'LIMIT ? OFFSET ?' : '';
    const args = limit > 0 ? [...params, limit, offset] : params;
    const rowsRs = await this.client.execute({
      sql: `SELECT id, name, tags, avatar_path, avatar_thumbnail_path, created_at, updated_at FROM characters ${where} ORDER BY updated_at DESC, id DESC ${limitClause}`,
      args,
    });

    return {
      items: mapRowsLenient(rowsRs.rows, rowToCharacterSummary, 'CharacterRepository.listSummaries'),
      total: (totalRs.rows[0]?.total as number | undefined) ?? 0,
    };
  }

  async create(id: string, data: CharacterInsert): Promise<Character> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO characters (
        id, name, description, personality, scenario, first_mes, mes_example,
        creator, character_version, tags, avatar_path, avatar_thumbnail_path,
        creator_notes, system_prompt, post_history_instructions,
        alternate_greetings, group_only_greetings, nickname,
        creator_notes_multilingual, source, extensions,
        create_date, world_info_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        data.name,
        data.description ?? '',
        data.personality ?? '',
        data.scenario ?? '',
        data.firstMes ?? '',
        data.mesExample ?? '',
        data.creator ?? '',
        data.characterVersion ?? '',
        JSON.stringify(data.tags ?? []),
        data.avatarPath ?? null,
        data.avatarThumbnailPath ?? null,
        data.creatorNotes ?? '',
        data.systemPrompt ?? '',
        data.postHistoryInstructions ?? '',
        JSON.stringify(data.alternateGreetings ?? []),
        JSON.stringify(data.groupOnlyGreetings ?? []),
        data.nickname ?? '',
        JSON.stringify(data.creatorNotesMultilingual ?? {}),
        JSON.stringify(data.source ?? []),
        JSON.stringify(data.extensions ?? {}),
        data.createDate ?? new Date(now * 1000).toISOString(),
        data.worldInfoId ?? null,
        now,
        now,
      ],
    });

    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created character: ${id}`);
    return created;
  }

  async update(id: string, patch: CharacterUpdate): Promise<Character> {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundError('Character', id);

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
    if (patch.personality !== undefined) {
      sets.push('personality = ?');
      values.push(patch.personality);
    }
    if (patch.scenario !== undefined) {
      sets.push('scenario = ?');
      values.push(patch.scenario);
    }
    if (patch.firstMes !== undefined) {
      sets.push('first_mes = ?');
      values.push(patch.firstMes);
    }
    if (patch.mesExample !== undefined) {
      sets.push('mes_example = ?');
      values.push(patch.mesExample);
    }
    if (patch.creator !== undefined) {
      sets.push('creator = ?');
      values.push(patch.creator);
    }
    if (patch.characterVersion !== undefined) {
      sets.push('character_version = ?');
      values.push(patch.characterVersion);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      values.push(JSON.stringify(patch.tags));
    }
    if (patch.avatarPath !== undefined) {
      sets.push('avatar_path = ?');
      values.push(patch.avatarPath);
    }
    if (patch.avatarThumbnailPath !== undefined) {
      sets.push('avatar_thumbnail_path = ?');
      values.push(patch.avatarThumbnailPath);
    }
    if (patch.creatorNotes !== undefined) {
      sets.push('creator_notes = ?');
      values.push(patch.creatorNotes);
    }
    if (patch.systemPrompt !== undefined) {
      sets.push('system_prompt = ?');
      values.push(patch.systemPrompt);
    }
    if (patch.postHistoryInstructions !== undefined) {
      sets.push('post_history_instructions = ?');
      values.push(patch.postHistoryInstructions);
    }
    if (patch.alternateGreetings !== undefined) {
      sets.push('alternate_greetings = ?');
      values.push(JSON.stringify(patch.alternateGreetings));
    }
    if (patch.groupOnlyGreetings !== undefined) {
      sets.push('group_only_greetings = ?');
      values.push(JSON.stringify(patch.groupOnlyGreetings));
    }
    if (patch.nickname !== undefined) {
      sets.push('nickname = ?');
      values.push(patch.nickname);
    }
    if (patch.creatorNotesMultilingual !== undefined) {
      sets.push('creator_notes_multilingual = ?');
      values.push(JSON.stringify(patch.creatorNotesMultilingual));
    }
    if (patch.source !== undefined) {
      sets.push('source = ?');
      values.push(JSON.stringify(patch.source));
    }
    if (patch.extensions !== undefined) {
      sets.push('extensions = ?');
      values.push(JSON.stringify(patch.extensions));
    }
    if (patch.createDate !== undefined) {
      sets.push('create_date = ?');
      values.push(patch.createDate);
    }
    if (patch.worldInfoId !== undefined) {
      sets.push('world_info_id = ?');
      values.push(patch.worldInfoId);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);

    await this.client.execute({ sql: `UPDATE characters SET ${sets.join(', ')} WHERE id = ?`, args: values });
    const updated = await this.getById(id);
    if (!updated) throw new NotFoundError('Character', id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({ sql: 'DELETE FROM characters WHERE id = ?', args: [id] });
    if (rs.rowsAffected === 0) throw new NotFoundError('Character', id);
  }
}

/**
 * Build a Spec V3 card JSON object from canonical character fields.
 *
 * Spec reference: https://github.com/kwaroran/character-card-spec-v3
 */
export interface BuildCardOptions {
  format?: 'v2' | 'v3';
  assets?: Array<{ name: string; type: string; ext: string; uri: string }>;
  characterBook?: { name?: string; entries: WorldInfoEntry[] };
}

export function worldInfoEntryToV3(e: WorldInfoEntry): CharacterBookEntry {
  const v3: CharacterBookEntry = {
    keys: e.keys,
    content: e.content,
    extensions: {},
    enabled: !e.disable,
    insertion_order: e.order,
    constant: e.constant,
    selective: e.selective,
    name: '',
    comment: e.comment,
    case_sensitive: false,
    use_regex: e.regex,
    secondary_keys: e.secondaryKeys,
    position: e.position,
  };

  if (e.position === 'atDepth') {
    v3.depth = e.depth ?? 0;
    v3.role = e.role ?? 'system';
  }

  return v3;
}

export function buildCardJson(char: Character, opts: BuildCardOptions = {}): TavernCard {
  const format = opts.format ?? 'v3';
  const v2Data: TavernCardV2Data = {
    name: char.name,
    description: char.description,
    personality: char.personality,
    scenario: char.scenario,
    first_mes: char.firstMes,
    mes_example: char.mesExample,
    creator_notes: char.creatorNotes,
    system_prompt: char.systemPrompt,
    post_history_instructions: char.postHistoryInstructions,
    tags: char.tags,
    creator: char.creator,
    character_version: char.characterVersion,
    alternate_greetings: char.alternateGreetings,
    extensions: char.extensions,
  };

  if (format === 'v3') {
    const v3Data: TavernCardV3Data = {
      ...v2Data,
      group_only_greetings: char.groupOnlyGreetings,
    };
    if (char.nickname) v3Data.nickname = char.nickname;
    if (Object.keys(char.creatorNotesMultilingual).length > 0) {
      v3Data.creator_notes_multilingual = char.creatorNotesMultilingual;
    }
    v3Data.source = char.source;
    if (opts.assets && opts.assets.length > 0) {
      v3Data.assets = opts.assets;
    }
    if (opts.characterBook && opts.characterBook.entries.length > 0) {
      v3Data.character_book = {
        name: opts.characterBook.name ?? `${char.name} Book`,
        extensions: {},
        entries: opts.characterBook.entries.map(worldInfoEntryToV3),
      };
    }
    const card: TavernCard = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: v3Data,
    };
    if (char.createDate) {
      (card as Record<string, unknown>).create_date = char.createDate;
    }
    return card;
  }

  const card: TavernCard = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: v2Data,
  };
  if (char.createDate) {
    (card as Record<string, unknown>).create_date = char.createDate;
  }
  return card;
}
