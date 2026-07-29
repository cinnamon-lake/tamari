import type { Client } from '@libsql/client';
import { str } from '../lib/coerce.js';

export interface ChatStats {
  chatId: string;
  chatName: string;
  messageCount: number;
  lastActivity: number | null;
}

export interface CharacterStats {
  characterId: string;
  characterName: string;
  chatCount: number;
  totalMessages: number;
}

export interface GlobalStats {
  totalCharacters: number;
  totalChats: number;
  totalMessages: number;
  totalGenerations: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  chats: ChatStats[];
  characters: CharacterStats[];
}

export class StatsService {
  private cache: { promise: Promise<GlobalStats>; expiry: number } | null = null;
  private readonly TTL_MS = 30_000;

  constructor(private client: Client) {}

  async getGlobalStats(): Promise<GlobalStats> {
    const now = Date.now();
    if (this.cache && this.cache.expiry > now) {
      return this.cache.promise;
    }

    const promise = this._computeGlobalStats();
    this.cache = { promise, expiry: now + this.TTL_MS };
    promise.catch(() => {
      if (this.cache?.promise === promise) {
        this.cache = null;
      }
    });
    return promise;
  }

  private async _computeGlobalStats(): Promise<GlobalStats> {
    const [chars, chats, messages, generations] = await Promise.all([
      this.client.execute('SELECT COUNT(*) as count FROM characters'),
      this.client.execute('SELECT COUNT(*) as count FROM chats'),
      this.client.execute('SELECT COUNT(*) as count FROM messages'),
      this.client.execute('SELECT COUNT(*) as count FROM generations'),
    ]);

    const totalCharacters = Number(chars.rows[0]?.count);
    const totalChats = Number(chats.rows[0]?.count);
    const totalMessages = Number(messages.rows[0]?.count);
    const totalGenerations = Number(generations.rows[0]?.count);

    const [tokens, chatStats, charStats] = await Promise.all([
      this.client.execute(`
        SELECT COALESCE(SUM(prompt_tokens), 0) as prompt, COALESCE(SUM(completion_tokens), 0) as completion
        FROM generations WHERE status = 'complete'
      `),
      this.client.execute(`
        SELECT c.id as chat_id, c.name, COUNT(p.id) as message_count, MAX(p.updated_at) as last_activity
        FROM chats c
        LEFT JOIN (
          WITH RECURSIVE path(id, parent_id, updated_at, chat_id) AS (
            SELECT m.id, m.parent_id, m.updated_at, c.id
            FROM chats c JOIN messages m ON m.id = c.active_child_id
            UNION ALL
            SELECT m.id, m.parent_id, m.updated_at, p.chat_id
            FROM messages m JOIN path p ON m.id = p.parent_id
          )
          SELECT id, parent_id, updated_at, chat_id FROM path
        ) p ON p.chat_id = c.id
        GROUP BY c.id ORDER BY last_activity DESC, c.id DESC
      `),
      this.client.execute(`
        SELECT ch.id as char_id, ch.name, COUNT(DISTINCT c.id) as chat_count, COUNT(p.id) as total_messages
        FROM characters ch
        LEFT JOIN chats c ON c.character_id = ch.id
        LEFT JOIN (
          WITH RECURSIVE path(id, parent_id, chat_id) AS (
            SELECT m.id, m.parent_id, c.id
            FROM chats c JOIN messages m ON m.id = c.active_child_id
            UNION ALL
            SELECT m.id, m.parent_id, p.chat_id
            FROM messages m JOIN path p ON m.id = p.parent_id
          )
          SELECT id, chat_id FROM path
        ) p ON p.chat_id = c.id
        GROUP BY ch.id ORDER BY total_messages DESC, ch.id DESC
      `),
    ]);

    const promptTokens = Number(tokens.rows[0]?.prompt);
    const completionTokens = Number(tokens.rows[0]?.completion);

    return {
      totalCharacters,
      totalChats,
      totalMessages,
      totalGenerations,
      totalPromptTokens: promptTokens,
      totalCompletionTokens: completionTokens,
      chats: chatStats.rows.map((r) => ({
        chatId: str(r.chatId),
        chatName: str(r.name),
        messageCount: Number(r.message_count),
        lastActivity: (r.last_activity as number | null) ?? null,
      })),
      characters: charStats.rows.map((r) => ({
        characterId: str(r.char_id),
        characterName: str(r.name),
        chatCount: Number(r.chat_count),
        totalMessages: Number(r.total_messages),
      })),
    };
  }
}
