/**
 * InMemoryChatRepository — the IChatRepository substrate for card-testing
 * sessions (TestSessionService). Runs the REAL generation path
 * (GenerationRunner + AssistantMessageTarget + ChatPromptAssembly unchanged)
 * against in-memory state instead of SQLite: no DB writes, no real chat rows.
 *
 * Only the linear-session subset is functional: chat row create/get/update,
 * appendMessage/updateMessage/getMessageById, branch reads
 * (getBulkOfMessages/getActiveBranch/getMessageChain), getSiblings (the
 * snapshot helper in lib/swipeInfo.ts reads it), and deleteChat (session
 * teardown). Everything else throws — swipes, forks, repairs, and listing
 * are not part of a linear test session.
 *
 * Pointer rules mirror ChatRepository.appendMessage (:746-798): an explicit
 * parentId wins, otherwise the message attaches to the current leaf
 * (activeChildId ?? headMessageId); a user message becomes the new head
 * (active_child cleared), any other role becomes the active child of its
 * parent (head moves to the parent). Multiple sessions coexist keyed by
 * chatId; message ids come from a simple incrementing counter (numbers,
 * like the real repo).
 */

import type { Chat, ChatInsert, Message, MessageInsert, MessageUpdate } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import type { IChatRepository } from '../repos/ChatRepository.js';

const NOT_SUPPORTED = 'not supported in test sessions';

function unsupported(): never {
  throw new Error(NOT_SUPPORTED);
}

export class InMemoryChatRepository implements IChatRepository {
  private chats = new Map<string, Chat>();
  private messages = new Map<number, Message>();
  /** Message id → owning chat (the messages table has no chat column; session
      teardown needs to know which rows belong to the dropped chat). */
  private messageChat = new Map<number, string>();
  private nextMessageId = 1;

  // ---- Chats (functional subset) ----

  async getChatById(id: string): Promise<Chat | undefined> {
    const chat = this.chats.get(id);
    return chat ? { ...chat, metadata: { ...chat.metadata } } : undefined;
  }

  async createChat(id: string, data: ChatInsert): Promise<Chat> {
    const now = Math.floor(Date.now() / 1000);
    const chat: Chat = {
      id,
      characterId: data.characterId,
      personaId: data.personaId ?? null,
      name: data.name,
      headMessageId: data.headMessageId ?? null,
      activeChildId: data.activeChildId ?? null,
      materialized: data.materialized ?? false,
      createdAt: now,
      updatedAt: now,
      metadata: { ...data.metadata },
      forkedFromChatId: data.forkedFromChatId ?? null,
      forkedAtMessageId: data.forkedAtMessageId ?? null,
    };
    this.chats.set(id, chat);
    return this.getChatById(id) as Promise<Chat>;
  }

  async updateChat(id: string, patch: Partial<Omit<ChatInsert, 'id'>>): Promise<Chat> {
    const chat = this.chats.get(id);
    if (!chat) throw new NotFoundError('Chat', id);
    if (patch.characterId !== undefined) chat.characterId = patch.characterId;
    if (patch.personaId !== undefined) chat.personaId = patch.personaId;
    if (patch.name !== undefined) chat.name = patch.name;
    if (patch.headMessageId !== undefined) chat.headMessageId = patch.headMessageId;
    if (patch.activeChildId !== undefined) chat.activeChildId = patch.activeChildId;
    if (patch.materialized !== undefined) chat.materialized = patch.materialized;
    if (patch.metadata !== undefined) chat.metadata = { ...patch.metadata };
    chat.updatedAt = Math.floor(Date.now() / 1000);
    return this.getChatById(id) as Promise<Chat>;
  }

  async deleteChat(id: string): Promise<void> {
    this.chats.delete(id);
    for (const [messageId, chatId] of this.messageChat) {
      if (chatId === id) {
        this.messageChat.delete(messageId);
        this.messages.delete(messageId);
      }
    }
  }

  // ---- Messages (functional subset) ----

  async getMessageById(id: number): Promise<Message | undefined> {
    const msg = this.messages.get(id);
    return msg ? { ...msg, extra: { ...msg.extra } } : undefined;
  }

  async appendMessage(chatId: string, msg: MessageInsert): Promise<Message> {
    const chat = this.chats.get(chatId);
    if (!chat) throw new NotFoundError('Chat', chatId);
    const now = Math.floor(Date.now() / 1000);

    // Explicit parent wins (greetings, regeneration); otherwise attach to the
    // current leaf — same rule as ChatRepository.appendMessage.
    const parentId =
      'parentId' in msg && msg.parentId !== undefined
        ? msg.parentId
        : (chat.activeChildId ?? chat.headMessageId ?? null);

    const message: Message = {
      id: this.nextMessageId++,
      parentId,
      role: msg.role,
      extra: { ...msg.extra },
      createdAt: now,
      updatedAt: now,
    };
    this.messages.set(message.id, message);
    this.messageChat.set(message.id, chatId);

    if (msg.role === 'user') {
      chat.headMessageId = message.id;
      chat.activeChildId = null;
    } else {
      chat.headMessageId = parentId;
      chat.activeChildId = message.id;
    }
    chat.updatedAt = now;
    return this.getMessageById(message.id) as Promise<Message>;
  }

  async updateMessage(id: number, patch: MessageUpdate): Promise<Message> {
    const message = this.messages.get(id);
    if (!message) throw new NotFoundError('Message', String(id));
    if (patch.role !== undefined) message.role = patch.role;
    if (patch.extra !== undefined) message.extra = { ...patch.extra };
    message.updatedAt = Math.floor(Date.now() / 1000);
    return this.getMessageById(id) as Promise<Message>;
  }

  // ---- Branch reads ----

  /** Parent-chain walk from `anchorId` toward the root, oldest first. */
  private walkUp(anchorId: number | null): Message[] {
    const chain: Message[] = [];
    let current = anchorId;
    while (current !== null) {
      const msg = this.messages.get(current);
      if (!msg) break;
      chain.push(msg);
      current = msg.parentId;
    }
    return chain.reverse();
  }

  async getBulkOfMessages(
    chatId: string,
    opts: { limit?: number; beforeId?: number; offset?: number } = {},
  ): Promise<Message[]> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    const anchor = opts.beforeId ?? chat.headMessageId;
    // Chain is oldest-first; the anchor is its last element. Pagination walks
    // from the anchor toward the root (older messages), skipping `offset`.
    const chain = this.walkUp(anchor);
    return chain.slice(Math.max(0, chain.length - offset - limit), chain.length - offset);
  }

  async getActiveBranch(
    chatId: string,
    opts: { limit?: number; beforeId?: number; offset?: number } = {},
  ): Promise<Message[]> {
    const bulk = await this.getBulkOfMessages(chatId, opts);
    const chat = this.chats.get(chatId);
    if (!chat?.activeChildId || bulk.some((m) => m.id === chat.activeChildId)) {
      return bulk;
    }
    const active = this.messages.get(chat.activeChildId);
    if (!active) return bulk;
    return [...bulk, active];
  }

  async getMessageChain(chatId: string): Promise<Message[]> {
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    return this.walkUp(chat.activeChildId ?? chat.headMessageId);
  }

  async getSiblings(parentId: number | null): Promise<Message[]> {
    return [...this.messages.values()]
      .filter((m) => m.parentId === parentId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }

  // ---- Everything else: not part of a linear test session ----

  async listChats(): Promise<{ items: Chat[]; total: number }> {
    return unsupported();
  }
  async listChatSummaries(): Promise<{
    items: Array<Pick<Chat, 'id' | 'characterId' | 'name' | 'createdAt' | 'updatedAt' | 'forkedFromChatId' | 'forkedAtMessageId'>>;
    total: number;
  }> {
    return unsupported();
  }
  async mergeChatMetadata(): Promise<Chat> {
    return unsupported();
  }
  async softFork(): Promise<Chat> {
    return unsupported();
  }
  async hardFork(): Promise<Chat> {
    return unsupported();
  }
  async getMessageCount(): Promise<number> {
    return unsupported();
  }
  async insertMessage(): Promise<Message> {
    return unsupported();
  }
  async deleteMessage(): Promise<void> {
    return unsupported();
  }
  async deleteMessages(): Promise<void> {
    return unsupported();
  }
  async deleteMessageAndRepair(): Promise<{ chat: Chat | undefined; wasActiveChild: boolean; wasHead: boolean }> {
    return unsupported();
  }
  async repairActiveChild(): Promise<Chat | undefined> {
    return unsupported();
  }
  async cutMessages(): Promise<{ deletedIds: number[]; newHeadId: number | null; newActiveChildId: number | null }> {
    return unsupported();
  }
}
