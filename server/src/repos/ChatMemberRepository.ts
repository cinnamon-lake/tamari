/**
 * Chat member repository — tracks group chat membership and per-member settings.
 */

import type { Client } from '@libsql/client';
import type { InValue } from '@libsql/core/api';
import type { ChatMember, ChatMemberInsert, ChatMemberUpdate } from '@tamari/types';
import { ChatMemberRowSchema } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { mapRowsLenient } from './rows.js';

export interface IChatMemberRepository {
  getMembers(chatId: string): Promise<ChatMember[]>;
  addMember(chatId: string, characterId: string, data?: Partial<ChatMemberInsert>): Promise<ChatMember>;
  removeMember(chatId: string, characterId: string): Promise<void>;
  updateMember(chatId: string, characterId: string, patch: ChatMemberUpdate): Promise<ChatMember>;
  removeAllMembers(chatId: string): Promise<void>;
}

function rowToChatMember(row: unknown): ChatMember {
  const r = ChatMemberRowSchema.parse(row);
  return {
    chatId: r.chat_id,
    characterId: r.character_id,
    talkativeness: r.talkativeness,
    depthPrompt: r.depth_prompt,
    depthPromptDepth: r.depth_prompt_depth,
    enabled: Boolean(r.enabled),
  };
}

export class ChatMemberRepository implements IChatMemberRepository {
  constructor(private client: Client) {}

  async getMembers(chatId: string): Promise<ChatMember[]> {
    const rs = await this.client.execute({
      sql: 'SELECT * FROM chat_members WHERE chat_id = ? ORDER BY character_id',
      args: [chatId],
    });
    return mapRowsLenient(rs.rows, rowToChatMember, 'ChatMemberRepository.getMembers');
  }

  async addMember(chatId: string, characterId: string, data?: Partial<ChatMemberInsert>): Promise<ChatMember> {
    await this.client.execute({
      sql: `INSERT INTO chat_members (chat_id, character_id, talkativeness, depth_prompt, depth_prompt_depth, enabled)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(chat_id, character_id) DO UPDATE SET
               talkativeness = excluded.talkativeness,
               depth_prompt = excluded.depth_prompt,
               depth_prompt_depth = excluded.depth_prompt_depth,
               enabled = excluded.enabled`,
      args: [
        chatId,
        characterId,
        data?.talkativeness ?? 1.0,
        data?.depthPrompt ?? '',
        data?.depthPromptDepth ?? 4,
        data?.enabled ?? true,
      ],
    });
    const members = await this.getMembers(chatId);
    const member = members.find((m) => m.characterId === characterId);
    if (!member) throw new Error(`Failed to retrieve chat member: ${characterId}`);
    return member;
  }

  async removeMember(chatId: string, characterId: string): Promise<void> {
    const rs = await this.client.execute({
      sql: 'DELETE FROM chat_members WHERE chat_id = ? AND character_id = ?',
      args: [chatId, characterId],
    });
    if (rs.rowsAffected === 0) throw new NotFoundError('ChatMember', `${chatId}/${characterId}`);
  }

  async updateMember(chatId: string, characterId: string, patch: ChatMemberUpdate): Promise<ChatMember> {
    const sets: string[] = [];
    const values: InValue[] = [];

    if (patch.talkativeness !== undefined) {
      sets.push('talkativeness = ?');
      values.push(patch.talkativeness);
    }
    if (patch.depthPrompt !== undefined) {
      sets.push('depth_prompt = ?');
      values.push(patch.depthPrompt);
    }
    if (patch.depthPromptDepth !== undefined) {
      sets.push('depth_prompt_depth = ?');
      values.push(patch.depthPromptDepth);
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(patch.enabled ? 1 : 0);
    }

    if (sets.length === 0) {
      const members = await this.getMembers(chatId);
      const member = members.find((m) => m.characterId === characterId);
      if (!member) throw new Error(`Failed to retrieve chat member: ${characterId}`);
      return member;
    }

    values.push(chatId, characterId);
    await this.client.execute({
      sql: `UPDATE chat_members SET ${sets.join(', ')} WHERE chat_id = ? AND character_id = ?`,
      args: values,
    });

    const members = await this.getMembers(chatId);
    const member = members.find((m) => m.characterId === characterId);
    if (!member) throw new Error(`Failed to retrieve updated chat member: ${characterId}`);
    return member;
  }

  async removeAllMembers(chatId: string): Promise<void> {
    await this.client.execute({
      sql: 'DELETE FROM chat_members WHERE chat_id = ?',
      args: [chatId],
    });
  }
}
