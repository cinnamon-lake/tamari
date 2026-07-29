import type { IChatRepository } from '../repos/ChatRepository.js';
import type { Message } from '@tamari/types';

/**
 * Build the canonical chat snapshot: the bulk of messages (head back to root)
 * plus all swipes (children of head).
 *
 * The active swipe is selected client-side using `chat.activeChildId`.
 * Swiping only changes `activeChildId`, so the server broadcasts a lightweight
 * `chat.updated` instead of a full snapshot.
 */
export async function getChatSnapshotMessages(
  chats: IChatRepository,
  chatId: string,
  limit: number,
): Promise<{ messages: Message[]; bulk: Message[]; swipes: Message[] }> {
  const chat = await chats.getChatById(chatId);
  const bulk = await chats.getBulkOfMessages(chatId, { limit });
  const headId = chat?.headMessageId ?? null;

  // When head is null but active_child is set, the active child is a
  // standalone root message (e.g. a lone greeting). Include it so the
  // client can render it.
  if (headId === null && chat && chat.activeChildId !== null) {
    const activeChild = await chats.getMessageById(chat.activeChildId);
    const messages = activeChild ? [activeChild] : [];
    return { messages, bulk, swipes: activeChild ? [activeChild] : [] };
  }

  const swipes = headId !== null ? await chats.getSiblings(headId) : [];
  const activeSwipe = chat?.activeChildId ? swipes.find((s) => s.id === chat.activeChildId) : undefined;
  const messages = activeSwipe && !bulk.some((m) => m.id === activeSwipe.id)
    ? [...bulk, activeSwipe]
    : bulk;
  return { messages, bulk, swipes };
}
