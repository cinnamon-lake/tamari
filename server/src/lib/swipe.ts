/**
 * Shared swipe logic used by the dispatcher and the Lua scripting API.
 *
 * Swiping cycles the chat's activeChildId through sibling messages
 * (messages sharing the same parentId = headMessageId).
 * This is the core branch-switching mechanism in the message tree.
 */

import type { EventBus } from '../bus/EventBus.js';
import type { IChatRepository } from '../repos/ChatRepository.js';

export interface SwipeDeps {
  bus: EventBus;
  chats: IChatRepository;
  chatMetaBroadcast: import('../services/ChatMetaBroadcastService.js').ChatMetaBroadcastService;
}

export async function performSwipe(
  deps: SwipeDeps,
  chatId: string,
  direction: 'left' | 'right',
  messageId?: number,
): Promise<void> {
  const { bus, chats } = deps;

  const chat = await chats.getChatById(chatId);
  if (!chat) {
    bus.broadcast({ type: 'error', message: 'Chat not found', code: 'NOT_FOUND' });
    return;
  }

  const targetMessageId = messageId ?? chat.activeChildId;
  if (!targetMessageId) {
    bus.broadcast({ type: 'error', message: 'No messages to swipe', code: 'NOT_FOUND' });
    return;
  }

  const message = await chats.getMessageById(targetMessageId);
  if (!message) {
    bus.broadcast({ type: 'error', message: 'Message not found', code: 'NOT_FOUND' });
    return;
  }
  const siblings = await chats.getSiblings(message.parentId);
  if (siblings.length <= 1) {
    bus.broadcast({ type: 'error', message: 'No swipes available for this message', code: 'NO_SWIPES' });
    return;
  }

  const currentIndex = siblings.findIndex((s) => s.id === message.id);
  if (currentIndex === -1) {
    bus.broadcast({ type: 'error', message: 'Message not found in sibling list', code: 'INTERNAL' });
    return;
  }

  const newIndex =
    direction === 'right'
      ? (currentIndex + 1) % siblings.length
      : (currentIndex - 1 + siblings.length) % siblings.length;

  const selected = siblings[newIndex];
  if (!selected) {
    bus.broadcast({ type: 'error', message: 'Message not found in sibling list', code: 'INTERNAL' });
    return;
  }
  const updated = await chats.updateChat(chatId, { activeChildId: selected.id });

  // Swiping only changes which sibling is active; the bulk and swipe set
  // remain identical, so broadcast the full chat (clients replace
  // activeChildId) without paying for a snapshot. See AGENTS.md §5.
  deps.chatMetaBroadcast.broadcastChatUpdated(updated);
}
