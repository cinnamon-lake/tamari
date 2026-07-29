/**
 * `chat.*` messages — loading, selection, CRUD, forks, resets, materialization.
 */

import { randomUUID } from 'node:crypto';
import { QuickReplyAutoExecute } from '@tamari/types';
import type { RegexRule } from '@tamari/types';
import { mergeRegexRules } from '../services/characterRegex.js';
import { renderMessageHtml } from '../services/DisplayRenderer.js';
import { materializeGreetings } from '../lib/greetings.js';
import { toChatSummary, withChatUrls } from '../lib/summaries.js';
import { broadcastQuickReplyList } from '../services/quickReplyBroadcast.js';
import { getEnrichedChatMembers } from './helpers.js';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildChatHandlers(
  deps: DispatcherDeps,
): Handlers<
  | 'chat.load'
  | 'chat.select'
  | 'chat.materialize'
  | 'chat.create'
  | 'chat.update'
  | 'chat.delete'
  | 'chat.reset'
  | 'chat.softFork'
  | 'chat.hardFork'
  | 'chat.list'
> {
  const {
    bus,
    characters,
    chats,
    settings,
    personas,
    characterAssets,
    quickReplyService,
    quickReplies,
    chatBroadcast,
    chatMetaBroadcast,
  } = deps;

  return {
    'chat.load': async (client, msg) => {
      const messages = await chats.getBulkOfMessages(msg.chatId, {
        limit: msg.limit ?? 100,
        beforeId: msg.beforeId,
        offset: msg.offset ?? 0,
      });
      const chat = await chats.getChatById(msg.chatId);
      const character = chat?.characterId ? await characters.getById(chat.characterId) : undefined;
      const persona = chat?.personaId ? await personas.getById(chat.personaId) : undefined;
      const allSettings = await settings.list();
      const regexRules = mergeRegexRules((allSettings['regexRules'] as RegexRule[] | undefined) ?? [], character);
      const strictHtml = Boolean(allSettings['strictHtmlSanitization']);
      const settingsUserName = (allSettings['userName'] as string | undefined) ?? '';
      const userName = persona?.name || settingsUserName || 'User';
      const charName = character?.name ?? 'Character';
      const assets = character ? await characterAssets.listForCharacter(character.id) : [];
      const renderedMessages = await Promise.all(
        messages.map(async (msg) => {
          if (msg.role === 'tool') return msg;
          const html = await renderMessageHtml({
            message: msg,
            character,
            characterAssets: assets,
            regexRules,
            strictHtmlSanitization: strictHtml,
            userName,
            charName,
          });
          return { ...msg, renderedHtml: html };
        }),
      );
      bus.sendTo(client.id, { type: 'messages.loaded', chatId: msg.chatId, messages: renderedMessages });
    },

    'chat.select': async (client, msg) => {
      let chat = await chats.getChatById(msg.chatId);
      if (!chat) {
        bus.sendTo(client.id, { type: 'error', message: 'Chat not found', code: 'NOT_FOUND' });
        return;
      }
      chat = (await chats.repairActiveChild(msg.chatId)) ?? chat;
      await settings.setValue('lastChatId', chat.id);
      bus.broadcast({ type: 'settings.changed', key: 'lastChatId', value: chat.id }, client.id);
      await chatBroadcast.broadcastSnapshot(chat.id, msg.limit ?? 30, client.id);
      if (chat.characterId === null) {
        const enriched = await getEnrichedChatMembers(deps, msg.chatId);
        bus.sendTo(client.id, { type: 'group.members', chatId: msg.chatId, members: enriched });
      }
      await quickReplyService.runAutoExecute(msg.chatId, QuickReplyAutoExecute.CHAT_CHANGE, client.id);
    },

    'chat.materialize': async (client, msg) => {
      const chat = await chats.getChatById(msg.chatId);
      if (!chat) {
        bus.sendTo(client.id, { type: 'error', message: 'Chat not found', code: 'NOT_FOUND' });
        return;
      }
      if (chat.materialized) return; // already materialized
      if (!chat.characterId) return;

      const character = await characters.getById(chat.characterId);
      if (!character) return;

      const selectedIndex = Number(chat.metadata.selectedGreetingIndex ?? 0);
      const settingsUserName = (await settings.get('userName')) as string | undefined;
      await materializeGreetings({ bus, chats, chatBroadcast, assets: characterAssets, personas, userName: settingsUserName }, chat.id, character, selectedIndex);
      await quickReplyService.runAutoExecute(msg.chatId, QuickReplyAutoExecute.NEW_CHAT, client.id);
    },

    'chat.create': async (client, msg) => {
      const id = randomUUID();
      let personaId = msg.data.personaId ?? null;
      if (!personaId) {
        const first = (await personas.listSummaries())[0];
        personaId = first?.id ?? null;
      }
      const chat = await chats.createChat(id, {
        characterId: msg.data.characterId ?? null,
        personaId: personaId,
        name: msg.data.name,
        headMessageId: null,
        metadata: {},
      });
      bus.broadcast({ type: 'chat.created', chat: withChatUrls(chat) }, client.id);
      // Rebroadcast the full chat list so every tab's sidebar converges (wholesale-replace
      // beats incremental append — see AGENTS.md §5). Avoids sidebar drift if a .created is
      // missed during reconnect.
      const createdList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast(
        { type: 'chat.listed', chats: createdList.items.map(toChatSummary), total: createdList.total },
        client.id,
      );
    },

    'chat.update': async (client, msg) => {
      const updatedChat = await chats.updateChat(msg.chatId, msg.patch);
      chatMetaBroadcast.broadcastChatUpdated(updatedChat, client.id);
      // Structural changes (bound character/persona) need a snapshot so the client
      // refreshes chatCharacter/chatPersona; an empty chat with a character also needs
      // one for the resolved greeting (e.g. after cycling greetings).
      const touchesEntity = 'characterId' in msg.patch || 'personaId' in msg.patch;
      if (touchesEntity || (updatedChat.characterId && !updatedChat.materialized)) {
        await chatBroadcast.broadcastSnapshot(updatedChat.id, 30, client.id);
      }
    },

    'chat.delete': async (client, msg) => {
      quickReplyService.abortChat(msg.chatId);
      deps.groupChatService.stopAutoMode(msg.chatId);
      await quickReplies.deleteByScope('chat', msg.chatId);
      await chats.deleteChat(msg.chatId);
      chatMetaBroadcast.broadcastChatDeleted(msg.chatId, client.id);
      // Rebroadcast the full list so a client that missed `chat.deleted`
      // (brief disconnect) still converges — consistent with chat.create/fork.
      const deletedList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast(
        { type: 'chat.listed', chats: deletedList.items.map(toChatSummary), total: deletedList.total },
        client.id,
      );
      // The chat-scoped quick replies are gone too — converge QR lists (§5).
      await broadcastQuickReplyList(bus, quickReplies, client.id);
    },

    'chat.reset': async (client, msg) => {
      quickReplyService.abortChat(msg.chatId);
      const msgs = await chats.getActiveBranch(msg.chatId, { limit: 10000 });
      // Delete newest-first (leaves first) to avoid FK violations
      const idsToDelete = msgs.slice().reverse().map((m) => m.id);
      if (idsToDelete.length > 0) {
        await chats.deleteMessages(idsToDelete);
      }
      const updatedChat = await chats.updateChat(msg.chatId, { headMessageId: null, activeChildId: null });
      chatMetaBroadcast.broadcastMessagesLoaded(msg.chatId, [], client.id);
      chatMetaBroadcast.broadcastChatUpdated(updatedChat, client.id);
      // headMessageId changed (trunk cleared) → refresh messages/greeting via snapshot.
      await chatBroadcast.broadcastSnapshot(updatedChat.id, 10000, client.id);
    },

    'chat.softFork': async (client, msg) => {
      const chat = await chats.softFork(msg.chatId, msg.messageId, msg.name);
      bus.broadcast({ type: 'chat.forked', chat: withChatUrls(chat) }, client.id);
      const softForkList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast(
        { type: 'chat.listed', chats: softForkList.items.map(toChatSummary), total: softForkList.total },
        client.id,
      );
    },

    'chat.hardFork': async (client, msg) => {
      const chat = await chats.hardFork(msg.chatId, msg.messageId, msg.name);
      bus.broadcast({ type: 'chat.forked', chat: withChatUrls(chat) }, client.id);
      const hardForkList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast(
        { type: 'chat.listed', chats: hardForkList.items.map(toChatSummary), total: hardForkList.total },
        client.id,
      );
    },

    'chat.list': async (client, msg) => {
      const result = await chats.listChatSummaries({
        characterId: msg.characterId,
        limit: msg.limit ?? (msg.characterId ? 0 : 5),
        offset: msg.offset ?? 0,
      });
      bus.sendTo(client.id, {
        type: 'chat.listed',
        chats: result.items.map(toChatSummary),
        total: result.total,
      });
    },
  };
}
