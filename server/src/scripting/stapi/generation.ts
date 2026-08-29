/**
 * st-api domain: generation — drive generation flow (trigger, quiet one-shot
 * `generate`, slash-command parity genraw/ask/sysgen) and prompt-macro
 * substitution.
 */

import { getMessageText } from '@tamari/types';
import { str } from '../../lib/coerce.js';
import { MacroResolver } from '../../pipeline/MacroResolver.js';
import type { StApiContext } from './context.js';
import type { StApi } from './types.js';

export type GenerationApi = Pick<StApi, 'trigger' | 'generate' | 'genraw' | 'ask' | 'sysgen' | 'substitute_macros'>;

export function createGeneration(c: StApiContext): GenerationApi {
  const { generationService, settings, chats, characters, personas, backendConfigs, clientId } = c.deps;
  const { chatId, checkAbort } = c;

  return {
    trigger: async () => {
      checkAbort();
      await generationService.handleGenerate(chatId, generationService.heldLockFor(chatId), clientId);
    },

    generate: async (prompt: string, opts?: { maxTokens?: number; temperature?: number } | null) => {
      checkAbort();
      if (typeof prompt !== 'string') throw new Error('generate: expected string prompt');
      const result = await generationService.quietGenerate(
        chatId,
        prompt,
        opts ?? undefined,
        generationService.heldLockFor(chatId),
      );
      if ('error' in result) {
        throw new Error(result.error);
      }
      return result.text;
    },

    genraw: async (prompt: string) => {
      checkAbort();
      if (typeof prompt !== 'string') throw new Error('genraw: expected string prompt');
      // heldLockFor shares the script's lock tenure — without the pass-through
      // the nested chat-mutex acquire deadlocks against the script's own lock.
      await generationService.handleGenRaw(chatId, prompt, clientId, generationService.heldLockFor(chatId));
    },

    ask: async (characterName: string, content: string) => {
      checkAbort();
      if (typeof characterName !== 'string' || typeof content !== 'string') {
        throw new Error('ask: expected (characterName, content)');
      }
      await generationService.handleAsk(
        chatId,
        characterName,
        content,
        clientId,
        generationService.heldLockFor(chatId),
      );
    },

    sysgen: async (content: string) => {
      checkAbort();
      if (typeof content !== 'string') throw new Error('sysgen: expected string content');
      await generationService.handleSysGen(chatId, content, clientId, generationService.heldLockFor(chatId));
    },

    substitute_macros: async (text: string) => {
      checkAbort();
      const allSettings = await settings.list();
      const chat = await chats.getChatById(chatId);
      const character = chat?.characterId ? await characters.getById(chat.characterId) : null;
      const msgs = await chats.getActiveBranch(chatId, { limit: 100 });
      const persona = chat?.personaId ? await personas.getById(chat.personaId) : undefined;
      const settingsUserName = (allSettings['userName'] as string | undefined) ?? '';
      const activeBackendConfigId = str(allSettings['activeBackendConfigId']);
      const activeConfig = activeBackendConfigId ? await backendConfigs.getById(activeBackendConfigId) : null;
      const resolver = MacroResolver.createPromptResolver();
      const macroCtx = {
        userName: persona?.name || settingsUserName || 'User',
        charName: character?.name ?? 'Character',
        description: character?.description,
        personality: character?.personality,
        scenario: character?.scenario,
        model: String(allSettings['model']),
        maxContext: activeConfig?.contextLength ?? 4096,
        maxResponse: activeConfig?.maxTokens ?? 0,
        now: new Date(),
        messages: msgs.map((m) => ({ id: m.id, role: m.role, content: getMessageText(m.extra.parts) })),
      };
      return resolver.resolve(String(text), macroCtx);
    },
  };
}
