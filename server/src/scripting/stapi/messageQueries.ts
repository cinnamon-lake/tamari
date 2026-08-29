/**
 * st-api domain: message queries — read-only views over the active branch and
 * the message tree (positions, chains, siblings, swipes, head/active child).
 */

import type { Message } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import { getChatSnapshotMessages } from '../../lib/swipeInfo.js';
import { FULL_BRANCH_MESSAGE_LIMIT, type StApiContext } from './context.js';
import type { LuaMessage, StApi } from './types.js';

export type MessageQueriesApi = Pick<
  StApi,
  | 'get_messages'
  | 'get_message_by_id'
  | 'get_message_count'
  | 'get_last_message'
  | 'get_message_at'
  | 'get_message_index'
  | 'get_children'
  | 'get_message_chain'
  | 'get_swipes'
  | 'get_siblings'
  | 'repair_active_child'
  | 'get_head'
  | 'get_active_child'
  | 'find_message_by_content'
  | 'find_messages_by_role'
  | 'messages_as_text'
  | 'get_message_texts'
>;

function toLuaMessage(m: Message): LuaMessage {
  return {
    id: m.id,
    parentId: m.parentId,
    role: m.role,
    content: getMessageText(m.extra.parts),
    extra: m.extra,
    createdAt: m.createdAt,
  };
}

export function createMessageQueries(c: StApiContext): MessageQueriesApi {
  const { chats, chatMetaBroadcast } = c.deps;
  const { chatId, checkAbort } = c;

  return {
    get_messages: async (limit?: number) => {
      checkAbort();
      const msgs = await chats.getActiveBranch(chatId, { limit: limit ?? 100 });
      return msgs.map(toLuaMessage);
    },

    get_message_by_id: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_message_by_id: expected number');
      const msg = await chats.getMessageById(messageId);
      if (!msg) return null;
      return toLuaMessage(msg);
    },

    get_message_count: async () => {
      checkAbort();
      return await chats.getMessageCount(chatId);
    },

    get_last_message: async () => {
      checkAbort();
      const msgs = await chats.getActiveBranch(chatId, { limit: 1 });
      const m = msgs[0];
      return m ? toLuaMessage(m) : null;
    },

    get_message_at: async (index: number) => {
      checkAbort();
      if (typeof index !== 'number') throw new Error('get_message_at: expected number');
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      const idx = index < 0 ? msgs.length + index : index;
      if (idx < 0 || idx >= msgs.length) return null;
      const m = msgs[idx];
      return m ? toLuaMessage(m) : null;
    },

    get_message_index: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_message_index: expected number');
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      const idx = msgs.findIndex((m) => m.id === messageId);
      return idx >= 0 ? idx : null;
    },

    get_children: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_children: expected number');
      const children = await chats.getSiblings(messageId);
      return children.map(toLuaMessage);
    },

    get_message_chain: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_message_chain: expected number');
      const chain: LuaMessage[] = [];
      let current = await chats.getMessageById(messageId);
      while (current) {
        chain.unshift(toLuaMessage(current));
        if (current.parentId === null) break;
        current = await chats.getMessageById(current.parentId);
      }
      return chain;
    },

    get_swipes: async () => {
      checkAbort();
      const { swipes } = await getChatSnapshotMessages(chats, chatId, FULL_BRANCH_MESSAGE_LIMIT);
      return swipes.map(toLuaMessage);
    },

    get_siblings: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_siblings: expected number');
      const msg = await chats.getMessageById(messageId);
      if (!msg) throw new Error('get_siblings: message not found');
      const siblings = await chats.getSiblings(msg.parentId);
      return siblings.map(toLuaMessage);
    },

    repair_active_child: async () => {
      checkAbort();
      const repaired = await chats.repairActiveChild(chatId);
      if (repaired) {
        const updatedChat = await chats.getChatById(chatId);
        if (updatedChat) chatMetaBroadcast.broadcastChatUpdated(updatedChat);
      }
    },

    get_head: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat?.headMessageId) return null;
      const msg = await chats.getMessageById(chat.headMessageId);
      if (!msg) return null;
      return toLuaMessage(msg);
    },

    get_active_child: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat?.activeChildId) return null;
      const msg = await chats.getMessageById(chat.activeChildId);
      if (!msg) return null;
      return toLuaMessage(msg);
    },

    find_message_by_content: async (search: string) => {
      checkAbort();
      if (typeof search !== 'string') throw new Error('find_message_by_content: expected string');
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      const found = msgs.find((m) => getMessageText(m.extra.parts).includes(search));
      if (!found) return null;
      return toLuaMessage(found);
    },

    find_messages_by_role: async (role: string) => {
      checkAbort();
      if (typeof role !== 'string') throw new Error('find_messages_by_role: expected string');
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      return msgs.filter((m) => m.role === role).map(toLuaMessage);
    },

    messages_as_text: async (separator?: string) => {
      checkAbort();
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      const sep = typeof separator === 'string' ? separator : '\n';
      return msgs.map((m) => `${m.role}: ${getMessageText(m.extra.parts)}`).join(sep);
    },

    get_message_texts: async () => {
      checkAbort();
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      return msgs.map((m) => getMessageText(m.extra.parts));
    },
  };
}
