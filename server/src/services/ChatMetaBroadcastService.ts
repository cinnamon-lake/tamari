import type { EventBus } from '../bus/EventBus.js';
import type { Chat, Message, ChatMemberSummary } from '@tamari/types';

export interface ChatMetaBroadcastServiceDeps {
  bus: EventBus;
}

/**
 * Centralizes structural chat-meta broadcasts.
 *
 * These events carry simple patches or IDs rather than rendered HTML,
 * so this service is a thin typed wrapper around the bus. Every
 * broadcast goes to all connected clients; each client ignores events
 * for chats it isn't rendering (see AGENTS.md §5).
 */
export class ChatMetaBroadcastService {
  constructor(private deps: ChatMetaBroadcastServiceDeps) {}

  broadcastChatUpdated(chat: Chat, excludeClientId?: string): void {
    // chat.updated always carries the FULL Chat object — clients replace, never
    // merge. There is no patch form; structural changes (head/character/persona)
    // are followed by a chat.snapshot. See AGENTS.md §5.
    this.deps.bus.broadcast({ type: 'chat.updated', chat }, excludeClientId);
  }

  broadcastChatDeleted(chatId: string, excludeClientId?: string): void {
    this.deps.bus.broadcast({ type: 'chat.deleted', chatId }, excludeClientId);
  }

  broadcastMessageDeleted(
    chatId: string,
    messageId: number,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'message.deleted', chatId, messageId },
      excludeClientId,
    );
  }

  broadcastMessagesLoaded(
    chatId: string,
    messages: Message[],
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'messages.loaded', chatId, messages },
      excludeClientId,
    );
  }

  broadcastGroupMembers(
    chatId: string,
    members: ChatMemberSummary[],
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'group.members', chatId, members },
      excludeClientId,
    );
  }

  broadcastGroupMemberAdded(
    chatId: string,
    member: ChatMemberSummary,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'group.member.added', chatId, member },
      excludeClientId,
    );
  }

  broadcastGroupMemberRemoved(
    chatId: string,
    characterId: string,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'group.member.removed', chatId, characterId },
      excludeClientId,
    );
  }

  broadcastGroupMemberUpdated(
    chatId: string,
    member: ChatMemberSummary,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'group.member.updated', chatId, member },
      excludeClientId,
    );
  }
}
