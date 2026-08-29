/**
 * st-api domain: message writes — append scripted messages (send_as /
 * send_narrator / comment / add_swipe), repoint the active child, and mutate
 * per-message `extra` payloads (reasoning, generation info, arbitrary keys).
 */

import type { MessageRole } from '@tamari/types';
import { materializeGreetings } from '../../lib/greetings.js';
import { FULL_BRANCH_MESSAGE_LIMIT, type StApiContext } from './context.js';
import type { StApi } from './types.js';

export type MessageWritesApi = Pick<
  StApi,
  | 'send_as'
  | 'send_narrator'
  | 'comment'
  | 'set_message_role'
  | 'add_swipe'
  | 'set_active_child'
  | 'get_reasoning'
  | 'set_reasoning'
  | 'clear_reasoning'
  | 'get_generation_info'
  | 'set_message_extra'
  | 'get_message_extra'
>;

export function createMessageWrites(c: StApiContext): MessageWritesApi {
  const { chats, characters, personas, settings, bus, chatBroadcast, chatMetaBroadcast } = c.deps;
  const { chatId, checkAbort } = c;

  /**
   * First real message in an unmaterialized chat: materialize the greeting
   * first (the UI does the same before sending), otherwise the appended
   * message lands on an empty branch and the client keeps showing only the
   * virtual greeting.
   */
  async function ensureChatMaterialized(): Promise<void> {
    const chat = await chats.getChatById(chatId);
    if (chat && !chat.materialized && chat.characterId) {
      const character = await characters.getById(chat.characterId);
      if (character) {
        const selectedIndex = Number(chat.metadata.selectedGreetingIndex ?? 0);
        const settingsUserName = (await settings.get('userName')) as string | undefined;
        await materializeGreetings(
          { bus, chats, chatBroadcast, personas, userName: settingsUserName },
          chatId,
          character,
          selectedIndex,
        );
      }
    }
  }

  return {
    send_as: async (name: string, content: string) => {
      checkAbort();
      if (typeof name !== 'string' || typeof content !== 'string') {
        throw new Error('send_as: expected (name, content)');
      }

      const character = await characters.getByName(name);
      if (!character) {
        throw new Error(`send_as: character "${name}" not found`);
      }

      await ensureChatMaterialized();

      const newMsg = await chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { characterId: character.id, parts: [{ type: 'text', text: content }] },
      });

      const updatedChat = await chats.getChatById(chatId);
      if (updatedChat) {
        await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
      }

      return newMsg.id;
    },

    send_narrator: async (name: string, content?: string) => {
      checkAbort();
      if (content === undefined) {
        // Called as st.send_narrator(content) — use default name
        content = name;
        name = 'Narrator';
      }
      if (typeof name !== 'string' || typeof content !== 'string') {
        throw new Error('send_narrator: expected (name, content) or (content)');
      }

      await ensureChatMaterialized();

      const newMsg = await chats.appendMessage(chatId, {
        role: 'system',
        extra: { type: 'narrator', parts: [{ type: 'text', text: content }] },
      });

      const updatedChat = await chats.getChatById(chatId);
      if (updatedChat) {
        await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
      }

      return newMsg.id;
    },

    comment: async (content: string) => {
      checkAbort();
      if (typeof content !== 'string') {
        throw new Error('comment: expected string');
      }

      await ensureChatMaterialized();

      const newMsg = await chats.appendMessage(chatId, {
        role: 'system',
        extra: { type: 'comment', hidden: true, parts: [{ type: 'text', text: content }] },
      });

      const updatedChat = await chats.getChatById(chatId);
      if (updatedChat) {
        await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
      }

      return newMsg.id;
    },

    set_message_role: async (messageId: number, role: string) => {
      checkAbort();
      if (typeof messageId !== 'number' || typeof role !== 'string') {
        throw new Error('set_message_role: expected (number, string)');
      }
      const allowed: readonly MessageRole[] = ['user', 'assistant', 'system'];
      const validatedRole = allowed.find((r) => r === role);
      if (!validatedRole) {
        throw new Error(`set_message_role: role must be one of ${allowed.join(', ')}`);
      }
      const updated = await chats.updateMessage(messageId, { role: validatedRole });
      await chatBroadcast.broadcastMessageSnapshot(chatId, updated.id);
    },

    add_swipe: async (content: string, switchTo?: boolean) => {
      checkAbort();
      if (typeof content !== 'string') throw new Error('add_swipe: expected string');

      const chat = await chats.getChatById(chatId);
      if (!chat || !chat.activeChildId) {
        throw new Error('add_swipe: no active message to swipe from');
      }

      const activeMsg = await chats.getMessageById(chat.activeChildId);
      if (!activeMsg) {
        throw new Error('add_swipe: active message not found');
      }

      if (activeMsg.role !== 'assistant') {
        throw new Error('add_swipe: can only add swipes to assistant messages');
      }

      const newMsg = await chats.insertMessage({
        parentId: activeMsg.parentId,
        role: 'assistant',
        extra: activeMsg.extra.characterId
          ? { characterId: activeMsg.extra.characterId, parts: [{ type: 'text', text: content }] }
          : { parts: [{ type: 'text', text: content }] },
      });

      if (switchTo) {
        await chats.updateChat(chatId, { activeChildId: newMsg.id });
      }

      const updatedChat = await chats.getChatById(chatId);
      if (updatedChat) {
        await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
      }

      return newMsg.id;
    },

    set_active_child: async (messageId: number) => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('set_active_child: chat not found');

      const msg = await chats.getMessageById(messageId);
      if (!msg) throw new Error('set_active_child: message not found');

      if (msg.parentId !== chat.headMessageId) {
        throw new Error('set_active_child: message is not a swipe of the current head');
      }

      const updatedChat = await chats.updateChat(chatId, { activeChildId: messageId });
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
    },

    get_reasoning: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_reasoning: expected number');
      const msg = await chats.getMessageById(messageId);
      if (!msg) return null;
      const reasoning = msg.extra['reasoning'];
      return reasoning ?? null;
    },

    set_reasoning: async (messageId: number, text: string) => {
      checkAbort();
      if (typeof messageId !== 'number' || typeof text !== 'string') {
        throw new Error('set_reasoning: expected (number, string)');
      }
      const existing = await chats.getMessageById(messageId);
      if (!existing) throw new Error('set_reasoning: message not found');
      const extra = { ...existing.extra, reasoning: text };
      const updated = await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, updated.id);
    },

    clear_reasoning: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('clear_reasoning: expected number');
      const existing = await chats.getMessageById(messageId);
      if (!existing) throw new Error('clear_reasoning: message not found');
      const extra = { ...existing.extra };
      delete extra['reasoning'];
      const updated = await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, updated.id);
    },

    get_generation_info: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_generation_info: expected number');
      const msg = await chats.getMessageById(messageId);
      if (!msg) return null;
      // snake_case keys are the historical shape; camelCase duplicates are
      // additive aliases for consistency with the rest of the API.
      return {
        model: msg.extra['model'] ?? null,
        token_count: msg.extra['tokenCount'] ?? null,
        tokenCount: msg.extra['tokenCount'] ?? null,
        generation_time: msg.extra['generationTime'] ?? null,
        generationTime: msg.extra['generationTime'] ?? null,
        api: msg.extra['api'] ?? null,
      };
    },

    set_message_extra: async (messageId: number, key: string, value: unknown) => {
      checkAbort();
      if (typeof messageId !== 'number' || typeof key !== 'string') {
        throw new Error('set_message_extra: expected (number, string, value)');
      }
      const existing = await chats.getMessageById(messageId);
      if (!existing) throw new Error('set_message_extra: message not found');
      const extra = { ...existing.extra, [key]: value };
      const updated = await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, updated.id);
    },

    get_message_extra: async (messageId: number, key: string) => {
      checkAbort();
      if (typeof messageId !== 'number' || typeof key !== 'string') {
        throw new Error('get_message_extra: expected (number, string)');
      }
      const msg = await chats.getMessageById(messageId);
      if (!msg) return null;
      return msg.extra[key] ?? null;
    },
  };
}
