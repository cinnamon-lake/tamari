/**
 * Chat and Message repository.
 *
 * Messages form a tree via parent_id.
 *
 * - `head_message_id` = the message that potential swipes reply to.
 *   Bulk history is the path from head back to the root.
 * - `active_child_id` = the currently selected swipe (a child of head).
 *   If there are no swipes yet, `active_child_id` may equal head or be null.
 *
 * The rendered chat = bulk + active swipe.
 */

import { safeParseJson } from '../lib/safeJson.js';
import type { Client, Transaction } from '@libsql/client';
import type { InValue } from '@libsql/core/api';
import { ChatSchema, MessageSchema, ChatRowSchema, ChatSummaryRowSchema, MessageRowSchema, MessageExtraSchema } from '@tamari/types';
import type { Chat, ChatInsert, Message, MessageInsert, MessageUpdate } from '@tamari/types';
import { ConflictError, NotFoundError } from '../errors.js';
import { z } from 'zod';
import { mapRowsLenient } from './rows.js';

export interface IChatRepository {
  getChatById(id: string): Promise<Chat | undefined>;
  listChats(opts?: {
    characterId?: string;
    personaId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Chat[]; total: number }>;
  listChatSummaries(opts?: {
    characterId?: string;
    personaId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: Array<
      Pick<Chat, 'id' | 'characterId' | 'name' | 'createdAt' | 'updatedAt' | 'forkedFromChatId' | 'forkedAtMessageId'>
    >;
    total: number;
  }>;
  createChat(id: string, data: ChatInsert): Promise<Chat>;
  updateChat(id: string, patch: Partial<Omit<ChatInsert, 'id'>>): Promise<Chat>;
  /**
   * Atomically deep-merge `partial` into the chat's metadata column via a single
   * SQLite `json_patch` UPDATE — no read-modify-write, so concurrent writers that
   * touch different keys can't clobber each other. Returns the updated chat.
   * NOTE: a value of `null` deletes its key (RFC 7396 merge-patch semantics).
   */
  mergeChatMetadata(id: string, partial: Record<string, unknown>): Promise<Chat>;
  deleteChat(id: string): Promise<void>;
  softFork(chatId: string, messageId: number, name: string): Promise<Chat>;
  hardFork(chatId: string, messageId: number, name: string): Promise<Chat>;

  getMessageById(id: number): Promise<Message | undefined>;
  /**
   * Fetch the bulk of messages (from head back to root) in chronological order
   * (oldest first).  This does NOT include the active swipe.
   *
   * If `beforeId` is provided, pagination starts from that message and walks
   * toward the root (older messages). `offset` skips N messages from the anchor.
   */
  getBulkOfMessages(chatId: string, opts?: { limit?: number; beforeId?: number; offset?: number }): Promise<Message[]>;
  getActiveBranch(chatId: string, opts?: { limit?: number; beforeId?: number; offset?: number }): Promise<Message[]>;
  /**
   * Fetch the full active branch = bulk + active swipe, with no limit.
   * Use this when you need the complete message chain (e.g. for memory summarization).
   */
  getMessageChain(chatId: string): Promise<Message[]>;

  getMessageCount(chatId: string): Promise<number>;
  appendMessage(chatId: string, msg: MessageInsert): Promise<Message>;
  /**
   * Insert a message row without updating chat head/active_child pointers.
   * Used for creating swipes and other sibling messages.
   */
  insertMessage(msg: MessageInsert): Promise<Message>;
  updateMessage(id: number, patch: MessageUpdate): Promise<Message>;
  deleteMessage(id: number): Promise<void>;
  deleteMessages(ids: number[]): Promise<void>;
  /**
   * Delete a message and repair chat pointers.
   * - Rejects if the message has children and is not the head.
   * - If the message is the head with children, reparents children to the message's parent.
   * - If the message was the active_child, rolls up to siblings or ancestors per the tree rules.
   */
  deleteMessageAndRepair(chatId: string, messageId: number): Promise<{
    chat: Chat | undefined;
    wasActiveChild: boolean;
    wasHead: boolean;
  }>;
  getSiblings(parentId: number | null): Promise<Message[]>;
  /**
   * If active_child_id is null but head_message_id has swipe children,
   * point active_child_id at the newest swipe. Returns the (possibly updated) chat.
   */
  repairActiveChild(chatId: string): Promise<Chat | undefined>;
  /**
   * Atomically delete the last `count` messages from the active branch
   * and recalculate head / active_child pointers.
   */
  cutMessages(chatId: string, count: number): Promise<{
    deletedIds: number[];
    newHeadId: number | null;
    newActiveChildId: number | null;
  }>;
}

function rowToChat(row: unknown): Chat {
  const r = ChatRowSchema.parse(row);
  return ChatSchema.parse({
    id: r.id,
    characterId: r.character_id,
    personaId: r.persona_id,
    name: r.name,
    headMessageId: r.head_message_id,
    activeChildId: r.active_child_id,
    materialized: Boolean(r.materialized),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    metadata: safeParseJson(r.metadata, z.record(z.string(), z.unknown()), {}),
    forkedFromChatId: r.forked_from_chat_id,
    forkedAtMessageId: r.forked_at_message_id,
  });
}

function rowToMessage(row: unknown): Message {
  const r = MessageRowSchema.parse(row);
  const extra = safeParseJson(r.extra, MessageExtraSchema, {});
  return MessageSchema.parse({
    id: r.id,
    parentId: r.parent_id,
    role: r.role,
    extra,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

type ChatSummaryItem = Pick<
  Chat,
  'id' | 'characterId' | 'name' | 'createdAt' | 'updatedAt' | 'forkedFromChatId' | 'forkedAtMessageId'
>;

function rowToChatSummary(row: unknown): ChatSummaryItem {
  const r = ChatSummaryRowSchema.parse(row);
  return {
    id: r.id,
    characterId: r.character_id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    forkedFromChatId: r.forked_from_chat_id,
    forkedAtMessageId: r.forked_at_message_id,
  };
}

export class ChatRepository implements IChatRepository {
  constructor(private client: Client) {}

  // ---- Chats ----

  async getChatById(id: string): Promise<Chat | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM chats WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToChat(rs.rows[0]);
  }

  async listChats(
    opts: { characterId?: string; personaId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items: Chat[]; total: number }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const conditions: string[] = [];
    const params: InValue[] = [];

    if (opts.characterId !== undefined) {
      conditions.push('character_id = ?');
      params.push(opts.characterId);
    }
    if (opts.personaId !== undefined) {
      conditions.push('persona_id = ?');
      params.push(opts.personaId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRs = await this.client.execute({ sql: `SELECT COUNT(*) as total FROM chats ${where}`, args: params });
    const limitClause = limit > 0 ? 'LIMIT ? OFFSET ?' : '';
    const args = limit > 0 ? [...params, limit, offset] : params;
    const rowsRs = await this.client.execute({
      sql: `SELECT * FROM chats ${where} ORDER BY updated_at DESC, id DESC ${limitClause}`,
      args,
    });

    return {
      items: mapRowsLenient(rowsRs.rows, rowToChat, 'ChatRepository.listChats'),
      total: Number(totalRs.rows[0]?.total ?? 0),
    };
  }

  async listChatSummaries(
    opts: { characterId?: string; personaId?: string; limit?: number; offset?: number } = {},
  ): Promise<{
    items: Array<
      Pick<Chat, 'id' | 'characterId' | 'name' | 'createdAt' | 'updatedAt' | 'forkedFromChatId' | 'forkedAtMessageId'>
    >;
    total: number;
  }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const conditions: string[] = [];
    const params: InValue[] = [];

    if (opts.characterId !== undefined) {
      conditions.push('character_id = ?');
      params.push(opts.characterId);
    }
    if (opts.personaId !== undefined) {
      conditions.push('persona_id = ?');
      params.push(opts.personaId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRs = await this.client.execute({ sql: `SELECT COUNT(*) as total FROM chats ${where}`, args: params });
    const limitClause = limit > 0 ? 'LIMIT ? OFFSET ?' : '';
    const args = limit > 0 ? [...params, limit, offset] : params;
    const rowsRs = await this.client.execute({
      sql: `SELECT id, character_id, name, created_at, updated_at, forked_from_chat_id, forked_at_message_id FROM chats ${where} ORDER BY updated_at DESC, id DESC ${limitClause}`,
      args,
    });

    return {
      items: mapRowsLenient(rowsRs.rows, rowToChatSummary, 'ChatRepository.listChatSummaries'),
      total: Number(totalRs.rows[0]?.total ?? 0),
    };
  }

  async createChat(id: string, data: ChatInsert): Promise<Chat> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO chats (id, character_id, persona_id, name, head_message_id, active_child_id, materialized, created_at, updated_at, metadata, forked_from_chat_id, forked_at_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        data.characterId,
        data.personaId ?? null,
        data.name,
        data.headMessageId ?? null,
        data.activeChildId ?? null,
        data.materialized ? 1 : 0,
        now,
        now,
        JSON.stringify(data.metadata),
        data.forkedFromChatId ?? null,
        data.forkedAtMessageId ?? null,
      ],
    });
    const created = await this.getChatById(id);
    if (!created) throw new Error(`Failed to retrieve created chat: ${id}`);
    return created;
  }

  async updateChat(id: string, patch: Partial<Omit<ChatInsert, 'id'>>): Promise<Chat> {
    const existing = await this.getChatById(id);
    if (!existing) throw new NotFoundError('Chat', id);

    const sets: string[] = [];
    const values: InValue[] = [];

    if (patch.characterId !== undefined) {
      sets.push('character_id = ?');
      values.push(patch.characterId);
    }
    if (patch.personaId !== undefined) {
      sets.push('persona_id = ?');
      values.push(patch.personaId);
    }
    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }

    if (patch.headMessageId !== undefined) {
      sets.push('head_message_id = ?');
      values.push(patch.headMessageId);
    }
    if (patch.activeChildId !== undefined) {
      sets.push('active_child_id = ?');
      values.push(patch.activeChildId);
    }
    if (patch.materialized !== undefined) {
      sets.push('materialized = ?');
      values.push(patch.materialized ? 1 : 0);
    }
    if (patch.metadata !== undefined) {
      sets.push('metadata = ?');
      values.push(JSON.stringify(patch.metadata));
    }
    if (patch.forkedFromChatId !== undefined) {
      sets.push('forked_from_chat_id = ?');
      values.push(patch.forkedFromChatId);
    }
    if (patch.forkedAtMessageId !== undefined) {
      sets.push('forked_at_message_id = ?');
      values.push(patch.forkedAtMessageId);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);

    await this.client.execute({ sql: `UPDATE chats SET ${sets.join(', ')} WHERE id = ?`, args: values });
    const updated = await this.getChatById(id);
    if (!updated) throw new NotFoundError('Chat', id);
    return updated;
  }

  async mergeChatMetadata(id: string, partial: Record<string, unknown>): Promise<Chat> {
    const existing = await this.getChatById(id);
    if (!existing) throw new NotFoundError('Chat', id);
    // Single statement: json_patch deep-merges `partial` into the existing JSON
    // metadata atomically, eliminating the lost-update race.
    await this.client.execute({
      sql: 'UPDATE chats SET metadata = json_patch(metadata, ?), updated_at = ? WHERE id = ?',
      args: [JSON.stringify(partial), Math.floor(Date.now() / 1000), id],
    });
    const updated = await this.getChatById(id);
    if (!updated) throw new NotFoundError('Chat', id);
    return updated;
  }

  async deleteChat(id: string): Promise<void> {
    const rs = await this.client.execute({ sql: 'DELETE FROM chats WHERE id = ?', args: [id] });
    if (rs.rowsAffected === 0) throw new NotFoundError('Chat', id);
  }

  async softFork(chatId: string, messageId: number, name: string): Promise<Chat> {
    const source = await this.getChatById(chatId);
    if (!source) throw new NotFoundError('Chat', chatId);
    const message = await this.getMessageById(messageId);
    if (!message) throw new NotFoundError('Message', String(messageId));

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const isAssistant = message.role === 'assistant';
    const headId = isAssistant ? message.parentId : messageId;
    const activeId = isAssistant ? messageId : null;
    await this.client.execute({
      sql: `INSERT INTO chats (id, character_id, persona_id, name, head_message_id, active_child_id, materialized, created_at, updated_at, metadata, forked_from_chat_id, forked_at_message_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        source.characterId,
        source.personaId,
        name,
        headId,
        activeId,
        1,
        now,
        now,
        JSON.stringify(source.metadata),
        chatId,
        messageId,
      ],
    });
    const created = await this.getChatById(id);
    if (!created) throw new Error(`Failed to retrieve forked chat: ${id}`);
    return created;
  }

  async hardFork(chatId: string, messageId: number, name: string): Promise<Chat> {
    const source = await this.getChatById(chatId);
    if (!source) throw new NotFoundError('Chat', chatId);
    const message = await this.getMessageById(messageId);
    if (!message) throw new NotFoundError('Message', String(messageId));

    const tx = await this.client.transaction();
    try {
      // Gather ancestor chain from messageId back to root in one query
      const ancestorsRs = await tx.execute({
        sql: `
          WITH RECURSIVE ancestors(id, parent_id, role, content, extra, created_at, updated_at, depth) AS (
            SELECT id, parent_id, role, content, extra, created_at, updated_at, 0
            FROM messages WHERE id = ?
            UNION ALL
            SELECT m.id, m.parent_id, m.role, m.content, m.extra, m.created_at, m.updated_at, a.depth + 1
            FROM messages m JOIN ancestors a ON m.id = a.parent_id
          )
          SELECT id, parent_id, role, content, extra, created_at, updated_at
          FROM ancestors ORDER BY depth DESC
        `,
        args: [messageId],
      });
      const ancestors = ancestorsRs.rows.map((r) => rowToMessage(r));

      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      await tx.execute({
        sql: `INSERT INTO chats (id, character_id, persona_id, name, head_message_id, active_child_id, materialized, created_at, updated_at, metadata, forked_from_chat_id, forked_at_message_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          source.characterId,
          source.personaId,
          name,
          null,
          null,
          1,
          now,
          now,
          JSON.stringify(source.metadata),
          chatId,
          messageId,
        ],
      });

      // Copy ancestors preserving tree structure
      const idMap = new Map<number, number>();
      let lastNewId: number | null = null;
      for (const msg of ancestors) {
        const newParentId = msg.parentId !== null ? (idMap.get(msg.parentId) ?? null) : null;
        const insertRs = await tx.execute({
          sql: `INSERT INTO messages (parent_id, role, content, extra, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 RETURNING id`,
          args: [newParentId, msg.role, '', JSON.stringify(msg.extra), msg.createdAt, msg.updatedAt],
        });
        const newId = (insertRs.rows[0]?.id as number | undefined) ?? 0;
        idMap.set(msg.id, newId);
        lastNewId = newId;
      }

      if (lastNewId !== null) {
        const isAssistant = message.role === 'assistant';
        // The forked chat's head is the message that swipes reply to: the
        // forked assistant's parent, or the forked user message itself. Swipes
        // are its children — clone every one so `getSiblings(head)` in the fork
        // returns all swipes, not just the active child.
        const sourceHeadId = isAssistant ? message.parentId : messageId;
        const copiedHeadId = sourceHeadId !== null ? (idMap.get(sourceHeadId) ?? null) : null;

        if (sourceHeadId !== null && copiedHeadId !== null) {
          const swipesRs = await tx.execute({
            sql: `SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at ASC, id ASC`,
            args: [sourceHeadId],
          });
          for (const r of swipesRs.rows) {
            const swipe = rowToMessage(r);
            // The active child (the forked assistant) was already cloned as the
            // tip of the spine — skip it so it isn't duplicated.
            if (idMap.has(swipe.id)) continue;
            await tx.execute({
              sql: `INSERT INTO messages (parent_id, role, content, extra, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)`,
              args: [copiedHeadId, swipe.role, '', JSON.stringify(swipe.extra), swipe.createdAt, swipe.updatedAt],
            });
          }
        }

        const copiedMessageId = idMap.get(messageId);
        if (copiedMessageId === undefined) {
          throw new Error(`hardFork: failed to map forked message id: ${messageId}`);
        }
        const headId = isAssistant ? copiedHeadId : copiedMessageId;
        const activeId = isAssistant ? copiedMessageId : null;
        await tx.execute({
          sql: `UPDATE chats SET head_message_id = ?, active_child_id = ? WHERE id = ?`,
          args: [headId, activeId, id],
        });
      }

      await tx.commit();
      const created = await this.getChatById(id);
      if (!created) throw new Error(`Failed to retrieve forked chat: ${id}`);
      return created;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ---- Messages ----

  async getMessageById(id: number): Promise<Message | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM messages WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToMessage(rs.rows[0]);
  }

  /**
   * Atomically delete the last `count` messages from the active branch
   * and recalculate head / active_child pointers.
   */
  async cutMessages(
    chatId: string,
    count: number,
  ): Promise<{ deletedIds: number[]; newHeadId: number | null; newActiveChildId: number | null }> {
    const tx = await this.client.transaction();
    try {
      // Fetch the full active branch upfront — after we delete messages the
      // chat's active_child_id still points to the deleted row, so we cannot
      // re-query the branch inside the same transaction.
      const fullHistory = await this._getActiveBranchTx(chatId, { limit: 10000 }, tx);
      const toDelete = fullHistory.slice(-count);

      // Guard: cutting a message that has children would orphan them.
      if (toDelete.length > 0) {
        const placeholders = toDelete.map(() => '?').join(',');
        const childrenRs = await tx.execute({
          sql: `SELECT 1 FROM messages WHERE parent_id IN (${placeholders}) LIMIT 1`,
          args: toDelete.map((m) => m.id),
        });
        if (childrenRs.rows.length > 0) {
          throw new Error(
            `Cannot cut: one or more messages have replies or swipes. Remove those first.`,
          );
        }
      }

      const deletedIds = toDelete.map((m) => m.id);
      if (deletedIds.length > 0) {
        const placeholders = deletedIds.map(() => '?').join(',');
        await tx.execute({
          sql: `DELETE FROM messages WHERE id IN (${placeholders})`,
          args: deletedIds,
        });
      }

      const remaining = fullHistory.slice(0, -count);
      const newLast = remaining[remaining.length - 1];
      let newHeadId: number | null = null;
      let newActiveChildId: number | null = null;

      if (newLast) {
        if (newLast.role === 'user') {
          newHeadId = newLast.id;
          newActiveChildId = null;
        } else {
          newHeadId = newLast.parentId;
          newActiveChildId = newLast.id;
        }
      } else {
        newHeadId = null;
        newActiveChildId = null;
      }

      await tx.execute({
        sql: 'UPDATE chats SET head_message_id = ?, active_child_id = ? WHERE id = ?',
        args: [newHeadId, newActiveChildId, chatId],
      });

      await tx.commit();
      return { deletedIds, newHeadId, newActiveChildId };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  private async _getActiveBranchTx(
    chatId: string,
    opts: { limit?: number; beforeId?: number; offset?: number },
    tx: Transaction,
  ): Promise<Message[]> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const maxDepth = offset + limit - 1;

    const rs = await tx.execute({
      sql: `
        WITH RECURSIVE branch(id, parent_id, role, content, extra, created_at, updated_at, depth) AS (
          SELECT id, parent_id, role, content, extra, created_at, updated_at, 0
          FROM messages
          WHERE id = (SELECT COALESCE(active_child_id, head_message_id) FROM chats WHERE id = ?)
          UNION ALL
          SELECT m.id, m.parent_id, m.role, m.content, m.extra, m.created_at, m.updated_at, b.depth + 1
          FROM messages m
          JOIN branch b ON m.id = b.parent_id
          WHERE b.depth < ?
        )
        SELECT id, parent_id, role, content, extra, created_at, updated_at
        FROM branch
        ORDER BY created_at ASC, id ASC
        LIMIT ? OFFSET ?
      `,
      args: [chatId, maxDepth, limit, offset],
    });

    return mapRowsLenient(rs.rows, rowToMessage, 'ChatRepository.getActiveBranch');
  }

  /**
   * Fetch the bulk of messages (from head back to root) in chronological order.
   * Does NOT include the active swipe.
   */
  async getBulkOfMessages(
    chatId: string,
    opts: { limit?: number; beforeId?: number; offset?: number } = {},
  ): Promise<Message[]> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const maxDepth = offset + limit - 1;

    const rs = await this.client.execute({
      sql: `
        WITH RECURSIVE path(id, parent_id, role, content, extra, created_at, updated_at, depth) AS (
          SELECT id, parent_id, role, content, extra, created_at, updated_at, 0
          FROM messages
          WHERE id = COALESCE(?, (SELECT head_message_id FROM chats WHERE id = ?))
          UNION ALL
          SELECT m.id, m.parent_id, m.role, m.content, m.extra, m.created_at, m.updated_at, p.depth + 1
          FROM messages m
          JOIN path p ON m.id = p.parent_id
          WHERE p.depth < ?
        )
        SELECT * FROM path WHERE depth >= ? ORDER BY depth DESC
      `,
      args: [opts.beforeId ?? null, chatId, maxDepth, offset],
    });

    return mapRowsLenient(rs.rows, rowToMessage, 'ChatRepository.getBulkOfMessages');
  }

  /**
   * Fetch the full active branch = bulk + active swipe.
   */
  async getActiveBranch(
    chatId: string,
    opts: { limit?: number; beforeId?: number; offset?: number } = {},
  ): Promise<Message[]> {
    const bulk = await this.getBulkOfMessages(chatId, opts);
    const chat = await this.getChatById(chatId);
    if (!chat?.activeChildId || bulk.some((m) => m.id === chat.activeChildId)) {
      return bulk;
    }
    const active = await this.getMessageById(chat.activeChildId);
    if (!active) {
      return bulk;
    }
    return [...bulk, active];
  }

  /**
   * Fetch the full active branch with no limit.
   */
  async getMessageChain(chatId: string): Promise<Message[]> {
    const chat = await this.getChatById(chatId);
    if (!chat) return [];

    const rs = await this.client.execute({
      sql: `
        WITH RECURSIVE branch(id, parent_id, role, content, extra, created_at, updated_at) AS (
          SELECT id, parent_id, role, content, extra, created_at, updated_at
          FROM messages
          WHERE id = COALESCE((SELECT active_child_id FROM chats WHERE id = ?), (SELECT head_message_id FROM chats WHERE id = ?))
          UNION ALL
          SELECT m.id, m.parent_id, m.role, m.content, m.extra, m.created_at, m.updated_at
          FROM messages m
          JOIN branch b ON m.id = b.parent_id
        )
        SELECT id, parent_id, role, content, extra, created_at, updated_at
        FROM branch
        ORDER BY created_at ASC, id ASC
      `,
      args: [chatId, chatId],
    });

    return mapRowsLenient(rs.rows, rowToMessage, 'ChatRepository.getMessageChain');
  }

  async getMessageCount(chatId: string): Promise<number> {
    const rs = await this.client.execute({
      sql: `
        WITH RECURSIVE path(id, parent_id, depth) AS (
          SELECT id, parent_id, 0 FROM messages
          WHERE id = COALESCE((SELECT head_message_id FROM chats WHERE id = ?), (SELECT active_child_id FROM chats WHERE id = ?))
          UNION ALL
          SELECT m.id, m.parent_id, p.depth + 1
          FROM messages m JOIN path p ON m.id = p.parent_id
        )
        SELECT COUNT(*) as total FROM path
      `,
      args: [chatId, chatId],
    });
    return (rs.rows[0]?.total as number | undefined) ?? 0;
  }

  async insertMessage(msg: MessageInsert): Promise<Message> {
    const now = Math.floor(Date.now() / 1000);
    const rs = await this.client.execute({
      sql: `INSERT INTO messages (parent_id, role, content, extra, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING *`,
      args: [
        msg.parentId ?? null,
        msg.role,
        '',
        JSON.stringify(msg.extra),
        now,
        now,
      ],
    });
    return rowToMessage(rs.rows[0]);
  }

  async appendMessage(chatId: string, msg: MessageInsert): Promise<Message> {
    const tx = await this.client.transaction('write');
    try {
      const now = Math.floor(Date.now() / 1000);

      // Use explicit parent_id if provided (e.g. for regeneration),
      // otherwise attach to the current active child.
      let parentId: number | null;
      if ('parentId' in msg && msg.parentId !== undefined) {
        parentId = msg.parentId;
      } else {
        const chatRs = await tx.execute({
          sql: 'SELECT active_child_id, head_message_id FROM chats WHERE id = ?',
          args: [chatId],
        });
        const chatPeek = chatRs.rows[0];
        parentId =
          z.coerce.number().nullable().parse(chatPeek?.active_child_id ?? null) ??
          z.coerce.number().nullable().parse(chatPeek?.head_message_id ?? null) ??
          null;
      }

      const isUser = msg.role === 'user';

      const insertRs = await tx.execute({
        sql: `INSERT INTO messages (parent_id, role, content, extra, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             RETURNING *`,
        args: [parentId, msg.role, '', JSON.stringify(msg.extra), now, now],
      });
      const insertedId = z.coerce.number().parse(insertRs.rows[0]?.id);

      const updateSql = `UPDATE chats SET head_message_id = ?, active_child_id = ?, updated_at = ? WHERE id = ?`;
      const updateArgs = isUser
        ? [insertedId, null, now, chatId]
        : [parentId, insertedId, now, chatId];

      await tx.execute({
        sql: updateSql,
        args: updateArgs,
      });

      await tx.commit();
      return rowToMessage(insertRs.rows[0]);
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  async updateMessage(id: number, patch: MessageUpdate): Promise<Message> {
    const existing = await this.getMessageById(id);
    if (!existing) throw new NotFoundError('Message', String(id));

    const sets: string[] = [];
    const values: InValue[] = [];

    if (patch.role !== undefined) {
      sets.push('role = ?');
      values.push(patch.role);
    }
    if (patch.extra !== undefined) {
      // Message text lives in extra.parts; the legacy content column stays
      // blank — clear it only alongside an extra rewrite, so role-only
      // patches don't touch it (and an empty patch hits the no-op guard).
      sets.push('content = ?');
      values.push('');
      sets.push('extra = ?');
      values.push(JSON.stringify(patch.extra));
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);

    await this.client.execute({ sql: `UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, args: values });
    const updated = await this.getMessageById(id);
    if (!updated) throw new NotFoundError('Message', String(id));
    return updated;
  }

  async deleteMessage(id: number): Promise<void> {
    const rs = await this.client.execute({ sql: 'DELETE FROM messages WHERE id = ?', args: [id] });
    if (rs.rowsAffected === 0) throw new NotFoundError('Message', String(id));
  }

  async deleteMessages(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const BATCH_SIZE = 999; // SQLite host parameter limit
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      await this.client.execute({
        sql: `DELETE FROM messages WHERE id IN (${placeholders})`,
        args: batch,
      });
    }
  }

  async deleteMessageAndRepair(
    chatId: string,
    messageId: number,
  ): Promise<{ chat: Chat | undefined; wasActiveChild: boolean; wasHead: boolean }> {
    const tx = await this.client.transaction();
    try {
      const chatRs = await tx.execute({ sql: 'SELECT * FROM chats WHERE id = ?', args: [chatId] });
      if (chatRs.rows.length === 0) {
        await tx.rollback();
        return { chat: undefined, wasActiveChild: false, wasHead: false };
      }
      const chat = rowToChat(chatRs.rows[0]);

      const msgRs = await tx.execute({ sql: 'SELECT * FROM messages WHERE id = ?', args: [messageId] });
      if (msgRs.rows.length === 0) {
        await tx.rollback();
        return { chat, wasActiveChild: false, wasHead: false };
      }
      const message = rowToMessage(msgRs.rows[0]);

      const wasActiveChild = chat.activeChildId === messageId;
      const wasHead = chat.headMessageId === messageId;

      const childrenRs = await tx.execute({
        sql: 'SELECT id FROM messages WHERE parent_id = ?',
        args: [messageId],
      });
      const hasChildren = childrenRs.rows.length > 0;

      if (hasChildren && !wasHead) {
        throw new ConflictError('Cannot delete a message that has replies or swipes. Remove those first.');
      }

      // Rule C: head with children → reparent children to message's parent (node contraction)
      if (hasChildren && wasHead) {
        await tx.execute({
          sql: 'UPDATE messages SET parent_id = ? WHERE parent_id = ?',
          args: [message.parentId ?? null, messageId],
        });
        await tx.execute({
          sql: 'UPDATE chats SET head_message_id = ? WHERE id = ?',
          args: [message.parentId ?? null, chatId],
        });
      }

      await tx.execute({ sql: 'DELETE FROM messages WHERE id = ?', args: [messageId] });

      // Rules A & B: active_child was deleted → repair
      if (wasActiveChild) {
        const afterRs = await tx.execute({ sql: 'SELECT * FROM chats WHERE id = ?', args: [chatId] });
        const after = rowToChat(afterRs.rows[0]);

        if (after.activeChildId === null) {
          const siblingsRs = await tx.execute({
            sql: 'SELECT id FROM messages WHERE parent_id = ? ORDER BY created_at, id ASC',
            args: [message.parentId ?? null],
          });
          const siblingIds = siblingsRs.rows.map((r) => z.coerce.number().parse(r.id));

          if (siblingIds.length > 0) {
            // Rule A: more swipes exist → pick newest
            const newestSiblingId = siblingIds[siblingIds.length - 1];
            if (newestSiblingId === undefined) {
              throw new Error('deleteMessageAndRepair: sibling ids unexpectedly empty');
            }
            await tx.execute({
              sql: 'UPDATE chats SET active_child_id = ? WHERE id = ?',
              args: [newestSiblingId, chatId],
            });
          } else if (message.parentId !== null) {
            const parentRs = await tx.execute({
              sql: 'SELECT role FROM messages WHERE id = ?',
              args: [message.parentId],
            });
            const parentRole = z.string().optional().parse(parentRs.rows[0]?.role);

            if (parentRole !== 'user') {
              // Rule B (non-user parent): roll up
              const parentParentRs = await tx.execute({
                sql: 'SELECT parent_id FROM messages WHERE id = ?',
                args: [message.parentId],
              });
              const parentParentId = z.coerce.number().nullable().parse(parentParentRs.rows[0]?.parent_id ?? null);
              await tx.execute({
                sql: 'UPDATE chats SET active_child_id = ?, head_message_id = ? WHERE id = ?',
                args: [message.parentId, parentParentId, chatId],
              });
            }
            // Rule B (user parent): do nothing — active_child stays null
          }
        }
      }

      await tx.commit();
      const finalChat = await this.getChatById(chatId);
      return { chat: finalChat, wasActiveChild, wasHead };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  /**
   * Get sibling messages (swipes) for a given parent_id within a chat.
   */
  async getSiblings(parentId: number | null): Promise<Message[]> {
    const rs = await this.client.execute({
      sql: `SELECT * FROM messages WHERE parent_id IS ? ORDER BY created_at, id ASC`,
      args: [parentId],
    });
    return mapRowsLenient(rs.rows, rowToMessage, 'ChatRepository.getSiblings');
  }

  async repairActiveChild(chatId: string): Promise<Chat | undefined> {
    const chat = await this.getChatById(chatId);
    if (!chat) return undefined;
    if (chat.activeChildId !== null) return chat;
    if (chat.headMessageId === null) return chat;

    const siblings = await this.getSiblings(chat.headMessageId);
    if (siblings.length === 0) return chat;

    const newest = siblings[siblings.length - 1];
    if (newest === undefined) throw new Error('repairActiveChild: siblings unexpectedly empty');
    await this.updateChat(chatId, { activeChildId: newest.id });
    return this.getChatById(chatId);
  }
}
