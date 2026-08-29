/**
 * st-api domain: chat actions — send/continue/regenerate, swipe, and direct
 * message-history mutations (cut/edit/delete/hide/unhide/reset).
 */

import type { ContentPart } from '@tamari/types';
import { performSwipe } from '../../lib/swipe.js';
import { FULL_BRANCH_MESSAGE_LIMIT, type StApiContext } from './context.js';
import type { StApi } from './types.js';

export type ChatActionsApi = Pick<
  StApi,
  | 'send'
  | 'continue'
  | 'impersonate'
  | 'regenerate'
  | 'swipe'
  | 'cut'
  | 'edit'
  | 'delete'
  | 'hide'
  | 'unhide'
  | 'stop'
  | 'reset_chat'
>;

export function createChatActions(c: StApiContext): ChatActionsApi {
  const { generationService, chats, bus, chatBroadcast, chatMetaBroadcast } = c.deps;
  const { chatId, checkAbort } = c;

  return {
    send: async (text: string) => {
      checkAbort();
      if (typeof text !== 'string') throw new Error('send: expected string');
      await generationService.handleSend(chatId, text, undefined, generationService.heldLockFor(chatId));
    },

    continue: async () => {
      checkAbort();
      await generationService.handleContinue(chatId, generationService.heldLockFor(chatId));
    },

    impersonate: async () => {
      checkAbort();
      await generationService.handleImpersonate(chatId, generationService.heldLockFor(chatId));
    },

    regenerate: async () => {
      checkAbort();
      await generationService.handleRegenerate(chatId, undefined, generationService.heldLockFor(chatId));
    },

    swipe: async (direction: string) => {
      checkAbort();
      if (direction !== 'left' && direction !== 'right') {
        throw new Error('swipe: expected "left" or "right"');
      }
      await performSwipe({ bus, chats, chatMetaBroadcast }, chatId, direction);
    },

    cut: async (count: number) => {
      checkAbort();
      const n = Math.max(1, Math.floor(Number(count) || 1));
      const { deletedIds } = await chats.cutMessages(chatId, n);
      for (const id of deletedIds) {
        chatMetaBroadcast.broadcastMessageDeleted(chatId, id);
      }
      const updatedChat = await chats.getChatById(chatId);
      if (updatedChat) {
        chatMetaBroadcast.broadcastChatUpdated(updatedChat);
        // headMessageId changed (trunk) → refresh messages via snapshot.
        await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
      }
    },

    edit: async (messageId: number, content: string) => {
      checkAbort();
      if (typeof messageId !== 'number' || typeof content !== 'string') {
        throw new Error('edit: expected (number, string)');
      }
      const existing = await chats.getMessageById(messageId);
      const existingParts = existing?.extra.parts ?? [];
      let replaced = false;
      const newParts: ContentPart[] = existingParts.map((p) => {
        if (p.type === 'text' && !replaced) {
          replaced = true;
          return { type: 'text', text: content };
        }
        return p;
      });
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- TS does not track mutation inside .map() closures
      if (!replaced) {
        newParts.push({ type: 'text', text: content });
      }
      const extra = { ...(existing?.extra ?? {}), editedAt: Math.floor(Date.now() / 1000), parts: newParts };
      const updated = await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, updated.id);
    },

    delete: async (messageId: number) => {
      checkAbort();
      await chats.deleteMessage(messageId);
      chatMetaBroadcast.broadcastMessageDeleted(chatId, messageId);
    },

    hide: async (messageId: number) => {
      checkAbort();
      const existing = await chats.getMessageById(messageId);
      if (!existing) return;
      const extra = { ...existing.extra, hidden: true };
      await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, messageId);
    },

    unhide: async (messageId: number) => {
      checkAbort();
      const existing = await chats.getMessageById(messageId);
      if (!existing) return;
      const extra = { ...existing.extra, hidden: false };
      await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, messageId);
    },

    stop: async () => {
      checkAbort();
      const active = generationService.getActiveGeneration();
      if (active && active.chatId === chatId) {
        await generationService.handleStop(active.id);
      }
    },

    reset_chat: async () => {
      checkAbort();
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      const ids = msgs.map((m) => m.id);
      if (ids.length > 0) {
        await chats.deleteMessages(ids);
      }
      const updatedChat = await chats.updateChat(chatId, { headMessageId: null, activeChildId: null });
      chatMetaBroadcast.broadcastMessagesLoaded(chatId, []);
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
      // headMessageId changed (trunk cleared) → refresh messages/greeting via snapshot.
      await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
    },
  };
}
