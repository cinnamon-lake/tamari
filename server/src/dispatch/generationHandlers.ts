/**
 * Generation-lifecycle `action.*` messages — send, generate, regenerate,
 * continue, impersonate, gen/genraw/ask/sysgen, stop.
 */

import { QuickReplyAutoExecute } from '@tamari/types';
import { ValidationError } from '../errors.js';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildGenerationHandlers(
  deps: DispatcherDeps,
): Handlers<
  | 'action.send'
  | 'action.sendAndGenerate'
  | 'action.generate'
  | 'action.regenerate'
  | 'action.continue'
  | 'action.impersonate'
  | 'action.gen'
  | 'action.genraw'
  | 'action.ask'
  | 'action.sysgen'
  | 'action.stop'
> {
  const { chats, generationService, quickReplyService } = deps;

  return {
    'action.send': async (client, msg) => {
      const chat = await chats.getChatById(msg.chatId);
      if (!chat) throw new ValidationError('Chat not found');

      // Append the user message only; generation is triggered separately via action.generate
      await generationService.handleSend(msg.chatId, msg.content, msg.attachments);
      await quickReplyService.runAutoExecute(msg.chatId, QuickReplyAutoExecute.USER_MESSAGE, client.id);
    },

    // Atomic send+generate. A separate action.send + action.generate pair is
    // dispatched fire-and-forget per WS frame, so the two coroutines race at
    // the chat mutex — generate can win and build a prompt without the new
    // user message. Doing the sequence in ONE dispatch coroutine makes the
    // ordering deterministic: append → USER_MESSAGE quick replies → generate.
    'action.sendAndGenerate': async (client, msg) => {
      const chat = await chats.getChatById(msg.chatId);
      if (!chat) throw new ValidationError('Chat not found');

      await generationService.handleSend(msg.chatId, msg.content, msg.attachments);
      // With the lock free at this point in the coroutine, auto-execute quick
      // replies always acquire it — no more silent skip when generation wins
      // the dispatch race.
      await quickReplyService.runAutoExecute(msg.chatId, QuickReplyAutoExecute.USER_MESSAGE, client.id);
      await generationService.handleGenerate(msg.chatId, undefined, client.id, msg.injections);
    },

    'action.generate': async (client, msg) => {
      const chat = await chats.getChatById(msg.chatId);
      if (!chat) throw new ValidationError('Chat not found');
      await generationService.handleGenerate(msg.chatId, undefined, client.id, msg.injections);
    },

    'action.regenerate': async (client, msg) => {
      await generationService.handleRegenerate(msg.chatId, msg.messageId, undefined, client.id);
    },

    'action.continue': async (client, msg) => {
      await generationService.handleContinue(msg.chatId, undefined, client.id);
    },

    'action.impersonate': async (client, msg) => {
      await generationService.handleImpersonate(msg.chatId, undefined, client.id);
    },

    'action.gen': async (client, msg) => {
      const chat = await chats.getChatById(msg.chatId);
      if (!chat) throw new ValidationError('Chat not found');
      await generationService.handleGen(msg.chatId, msg.prompt, client.id);
    },

    'action.genraw': async (client, msg) => {
      const chat = await chats.getChatById(msg.chatId);
      if (!chat) throw new ValidationError('Chat not found');
      await generationService.handleGenRaw(msg.chatId, msg.prompt, client.id);
    },

    'action.ask': async (client, msg) => {
      const chat = await chats.getChatById(msg.chatId);
      if (!chat) throw new ValidationError('Chat not found');
      await generationService.handleAsk(msg.chatId, msg.characterName, msg.content, client.id);
    },

    'action.sysgen': async (client, msg) => {
      const chat = await chats.getChatById(msg.chatId);
      if (!chat) throw new ValidationError('Chat not found');
      await generationService.handleSysGen(msg.chatId, msg.content, client.id);
    },

    'action.stop': async (_client, msg) => {
      const chatId = await generationService.handleStop(msg.generationId);
      if (chatId) {
        quickReplyService.abortChat(chatId);
      }
    },
  };
}
