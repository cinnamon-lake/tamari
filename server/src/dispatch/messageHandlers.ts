/**
 * Message-surgery `action.*` messages — edit, delete, hide, system, cut, swipe.
 */

import type { ContentPart, MessageExtra } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { ClientConnection } from '../bus/EventBus.js';
import { MacroResolver } from '../pipeline/MacroResolver.js';
import { performSwipe } from '../lib/swipe.js';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildMessageHandlers(
  deps: DispatcherDeps,
): Handlers<'action.edit' | 'action.delete' | 'action.hide' | 'action.unhide' | 'action.system' | 'action.cut' | 'action.swipe'> {
  const {
    bus,
    characters,
    chats,
    settings,
    personas,
    tokenCounter,
    chatBroadcast,
    chatMetaBroadcast,
  } = deps;

  async function setHidden(
    client: ClientConnection,
    chatId: string,
    messageId: number,
    hidden: boolean,
  ): Promise<void> {
    const existing = await chats.getMessageById(messageId);
    if (!existing) return;
    const extra: MessageExtra = { ...existing.extra, hidden };
    const message = await chats.updateMessage(messageId, { extra });
    await chatBroadcast.broadcastMessageSnapshot(chatId, message.id, client.id);
  }

  return {
    'action.edit': async (client, msg) => {
      const existing = await chats.getMessageById(msg.messageId);
      const chat = await chats.getChatById(msg.chatId);
      const character = chat?.characterId ? await characters.getById(chat.characterId) : undefined;
      const persona = chat?.personaId ? await personas.getById(chat.personaId) : undefined;
      const allSettings = await settings.list();
      const userName = persona?.name || allSettings.userName || 'User';

      // Resolve storage macros on edited text
      const storageResolver = MacroResolver.createStorageResolver();
      const existingVars = existing?.extra.macroVars ?? {};
      const macroCtx = {
        userName,
        charName: character?.name ?? 'Character',
        description: character?.description,
        personality: character?.personality,
        scenario: character?.scenario,
        model: allSettings.model,
        now: new Date(),
        macroVars: { ...existingVars },
      };
      const resolvedContent = storageResolver.resolve(msg.content, macroCtx);
      const newVars = { ...macroCtx.macroVars };

      const extra: MessageExtra = { ...(existing?.extra ?? {}), editedAt: Math.floor(Date.now() / 1000) };
      const existingParts = existing?.extra.parts ?? [];
      // Per-part editing: partIndex addresses exactly one text part. When
      // omitted (legacy callers), target the first text part; append one if
      // the message has none.
      const idx = msg.partIndex ?? existingParts.findIndex((p) => p.type === 'text');
      let newParts: ContentPart[];
      if (idx >= 0 && idx < existingParts.length) {
        const target = existingParts[idx]!;
        if (target.type !== 'text') {
          bus.sendTo(client.id, {
            type: 'error',
            message: `Part ${idx} is not a text part`,
            code: 'BAD_REQUEST',
          });
          return;
        }
        newParts = existingParts.map((p, i) => (i === idx ? { ...p, text: resolvedContent } : p));
      } else if (msg.partIndex !== undefined) {
        // Explicit index out of range — don't silently edit the wrong thing.
        bus.sendTo(client.id, {
          type: 'error',
          message: `Part index ${msg.partIndex} out of range`,
          code: 'BAD_REQUEST',
        });
        return;
      } else {
        newParts = [...existingParts, { type: 'text', text: resolvedContent }];
      }
      extra.parts = newParts;
      extra.macroVars = { ...existingVars, ...newVars };
      extra.tokenCount = tokenCounter.count(getMessageText(newParts));
      const message = await chats.updateMessage(msg.messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(msg.chatId, message.id, client.id);
    },

    'action.delete': async (client, msg) => {
      try {
        const {
          chat: updatedChat,
          wasActiveChild,
          wasHead,
        } = await chats.deleteMessageAndRepair(msg.chatId, msg.messageId);
        if (!updatedChat) {
          bus.sendTo(client.id, { type: 'error', message: 'Chat not found', code: 'NOT_FOUND' });
          return;
        }
        chatMetaBroadcast.broadcastMessageDeleted(msg.chatId, msg.messageId, client.id);
        if (wasActiveChild || wasHead) {
          await chatBroadcast.broadcastSnapshot(updatedChat.id, 10000, client.id);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('has replies or swipes')) {
          bus.sendTo(client.id, {
            type: 'error',
            message: err.message,
            code: 'HAS_CHILDREN',
          });
        } else {
          throw err;
        }
      }
    },

    'action.hide': async (client, msg) => {
      await setHidden(client, msg.chatId, msg.messageId, true);
    },

    'action.unhide': async (client, msg) => {
      await setHidden(client, msg.chatId, msg.messageId, false);
    },

    'action.system': async (client, msg) => {
      await chats.appendMessage(msg.chatId, {
        role: 'system',
        extra: { parts: [{ type: 'text', text: msg.content }] },
      });
      const updatedChat = await chats.getChatById(msg.chatId);
      if (updatedChat) {
        await chatBroadcast.broadcastSnapshot(updatedChat.id, 10000, client.id);
      }
    },

    'action.cut': async (client, msg) => {
      const { deletedIds } = await chats.cutMessages(msg.chatId, msg.count);
      for (const deletedId of deletedIds) {
        chatMetaBroadcast.broadcastMessageDeleted(msg.chatId, deletedId, client.id);
      }
      const updatedChat = await chats.getChatById(msg.chatId);
      if (updatedChat) {
        chatMetaBroadcast.broadcastChatUpdated(updatedChat, client.id);
        await chatBroadcast.broadcastSnapshot(updatedChat.id, 10000, client.id);
      }
    },

    'action.swipe': async (client, msg) => {
      await performSwipe({ bus, chats, chatMetaBroadcast }, msg.chatId, msg.direction, msg.messageId);
      const updatedChat = await chats.getChatById(msg.chatId);
      if (updatedChat) {
        await chatBroadcast.broadcastSnapshot(updatedChat.id, 10000, client.id);
      }
    },
  };
}
