/**
 * st-api domain: chat management — chat lifecycle (new/temp/rename/delete),
 * branching (soft fork / checkpoint / hard fork), chat-level metadata, and
 * the author's note.
 */

import { newId } from '@tamari/wordid';
import { toChatSummary } from '../../lib/summaries.js';
import type { StApiContext } from './context.js';
import type { StApi } from './types.js';

export type ChatManagementApi = Pick<
  StApi,
  | 'new_chat'
  | 'branch'
  | 'checkpoint'
  | 'hard_fork'
  | 'temp_chat'
  | 'rename_chat'
  | 'delete_chat'
  | 'get_chat'
  | 'get_chat_name'
  | 'get_chats'
  | 'set_chat_metadata'
  | 'get_chat_metadata'
  | 'set_author_note'
  | 'get_author_note'
>;

export function createChatManagement(c: StApiContext): ChatManagementApi {
  const { chats, bus, chatMetaBroadcast } = c.deps;
  const { chatId, checkAbort } = c;

  return {
    new_chat: async (name?: string) => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('new_chat: current chat not found');
      const id = newId();
      const newChat = await chats.createChat(id, {
        characterId: chat.characterId,
        personaId: chat.personaId,
        name: typeof name === 'string' ? name : chat.name,
        headMessageId: null,
        metadata: {},
      });
      bus.broadcast({ type: 'chat.created', chat: newChat });
      // Rebroadcast the full list so other tabs' sidebars converge (AGENTS.md §5).
      const createdChatList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({
        type: 'chat.listed',
        chats: createdChatList.items.map(toChatSummary),
        total: createdChatList.total,
      });
      return newChat.id;
    },

    branch: async (messageId: number, name?: string) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('branch: expected (messageId, name?)');
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('branch: chat not found');
      const branchName = typeof name === 'string' ? name : `${chat.name} (branch)`;
      const newChat = await chats.softFork(chatId, messageId, branchName);
      bus.broadcast({ type: 'chat.created', chat: newChat });
      // Rebroadcast the full list so other tabs' sidebars converge (AGENTS.md §5).
      const createdChatList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({
        type: 'chat.listed',
        chats: createdChatList.items.map(toChatSummary),
        total: createdChatList.total,
      });
      return newChat.id;
    },

    checkpoint: async (name?: string) => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('checkpoint: chat not found');
      const headId = chat.activeChildId ?? chat.headMessageId;
      if (headId === null) throw new Error('checkpoint: no messages to checkpoint');
      const checkpointName = typeof name === 'string' ? name : `${chat.name} (checkpoint)`;
      const newChat = await chats.softFork(chatId, headId, checkpointName);
      bus.broadcast({ type: 'chat.created', chat: newChat });
      // Rebroadcast the full list so other tabs' sidebars converge (AGENTS.md §5).
      const createdChatList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({
        type: 'chat.listed',
        chats: createdChatList.items.map(toChatSummary),
        total: createdChatList.total,
      });
      return newChat.id;
    },

    hard_fork: async (messageId: number, name?: string) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('hard_fork: expected (messageId, name?)');
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('hard_fork: chat not found');
      const forkName = typeof name === 'string' ? name : `${chat.name} (fork)`;
      const newChat = await chats.hardFork(chatId, messageId, forkName);
      bus.broadcast({ type: 'chat.created', chat: newChat });
      // Rebroadcast the full list so other tabs' sidebars converge (AGENTS.md §5).
      const createdChatList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({
        type: 'chat.listed',
        chats: createdChatList.items.map(toChatSummary),
        total: createdChatList.total,
      });
      return newChat.id;
    },

    temp_chat: async (name?: string) => {
      checkAbort();
      const id = newId();
      const chatName = typeof name === 'string' ? name : 'Temporary Chat';
      const chat = await chats.createChat(id, {
        characterId: null,
        personaId: null,
        name: chatName,
        headMessageId: null,
        metadata: {},
      });
      bus.broadcast({ type: 'chat.created', chat });
      const createdChatList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({
        type: 'chat.listed',
        chats: createdChatList.items.map(toChatSummary),
        total: createdChatList.total,
      });
      return chat.id;
    },

    rename_chat: async (name: string) => {
      checkAbort();
      if (typeof name !== 'string') throw new Error('rename_chat: expected string');
      const updated = await chats.updateChat(chatId, { name });
      chatMetaBroadcast.broadcastChatUpdated(updated);
    },

    delete_chat: async () => {
      checkAbort();
      await chats.deleteChat(chatId);
      chatMetaBroadcast.broadcastChatDeleted(chatId);
      const list = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({ type: 'chat.listed', chats: list.items.map(toChatSummary), total: list.total });
    },

    get_chat: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat) return null;
      return {
        id: chat.id,
        name: chat.name,
        characterId: chat.characterId,
        headMessageId: chat.headMessageId,
        metadata: chat.metadata,
      };
    },

    get_chat_name: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      return chat?.name ?? null;
    },

    get_chats: async (characterId?: string) => {
      checkAbort();
      const list = await chats.listChats({
        characterId: typeof characterId === 'string' ? characterId : undefined,
        limit: 100,
      });
      return list.items.map((c) => ({
        id: c.id,
        name: c.name,
        characterId: c.characterId,
        personaId: c.personaId,
        headMessageId: c.headMessageId,
        activeChildId: c.activeChildId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }));
    },

    set_chat_metadata: async (key: string, value: unknown) => {
      checkAbort();
      if (typeof key !== 'string') throw new Error('set_chat_metadata: expected (string, value)');
      const updatedChat = await chats.mergeChatMetadata(chatId, { [key]: value });
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
    },

    get_chat_metadata: async (key: string) => {
      checkAbort();
      if (typeof key !== 'string') throw new Error('get_chat_metadata: expected string');
      const chat = await chats.getChatById(chatId);
      if (!chat) return null;
      return chat.metadata[key] ?? null;
    },

    set_author_note: async (
      content: string,
      opts?: { depth?: number; interval?: number; position?: string; role?: string },
    ) => {
      checkAbort();
      if (typeof content !== 'string') throw new Error('set_author_note: expected string');
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('set_author_note: chat not found');
      const authorsNote = {
        content,
        depth: opts?.depth ?? 4,
        interval: opts?.interval ?? 1,
        position: ['before_prompt', 'after_prompt', 'in_chat'].includes(String(opts?.position))
          ? opts?.position
          : 'in_chat',
        role: ['system', 'user', 'assistant'].includes(String(opts?.role)) ? opts?.role : 'system',
      };
      const updatedChat = await chats.mergeChatMetadata(chatId, { authorsNote });
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
    },

    get_author_note: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat) return null;
      const an = chat.metadata['authorsNote'];
      if (!an || typeof an !== 'object') return null;
      return an as Record<string, unknown>;
    },
  };
}
