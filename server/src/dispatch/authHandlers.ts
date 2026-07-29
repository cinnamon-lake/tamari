/**
 * `auth` message — initial full-state snapshot for a freshly connected client.
 */

import {
  toCharacterSummary,
  toChatSummary,
  toPersonaSummary,
  toBackendConfigSummary,
  toPromptListSummary,
} from '../lib/summaries.js';
import { getEnrichedChatMembers } from './helpers.js';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildAuthHandlers(deps: DispatcherDeps): Handlers<'auth'> {
  const {
    bus,
    characters,
    chats,
    settings,
    personas,
    backendConfigs,
    promptLists,
    toolRegistry,
    toolsets: toolsetRepo,
    toolTemplates: toolTemplateRepo,
    chatBroadcast,
  } = deps;

  return {
    auth: async (client, _msg) => {
      // The token is validated at WS connect (main.ts); by the time a message
      // reaches dispatch the client is already authenticated (unauthenticated
      // clients are rejected by the guard in dispatcher.ts). This message only
      // requests the initial full-state snapshot — it must NOT grant authentication.
      const activeGen = deps.generationService.getActiveGeneration();
      const allSettings = await settings.list();
      bus.sendSnapshot(client.id, {
        characters: (await characters.listSummaries()).items.map(toCharacterSummary),
        chats: (await chats.listChatSummaries({ limit: 1000 })).items.map(toChatSummary),
        settings: allSettings,
        generation: activeGen
          ? {
              id: activeGen.id,
              chatId: activeGen.chatId,
              messageId: activeGen.messageId,
              text: activeGen.text,
              reasoning: activeGen.reasoning,
            }
          : undefined,
        personas: (await personas.listSummaries()).map(toPersonaSummary),
        backendConfigs: (await backendConfigs.listSummaries()).map(toBackendConfigSummary),
        promptLists: (await promptLists.listSummaries()).map(toPromptListSummary),
        tools: toolRegistry
          ? await Promise.all(
              [
                // Built-in templates
                ...toolRegistry.getAllBuiltinTemplates().map(async (t) => {
                  const def = await t.getDefinition();
                  return {
                    id: t.id,
                    name: t.name,
                    description: t.name,
                    configSchema: def.configSchema,
                    tools: def.tools,
                  };
                }),
                // Lua templates
                ...(await toolTemplateRepo.list()).map(async (lt) => {
                  const tmpl = await toolRegistry.getTemplate(lt.id);
                  if (!tmpl) {
                    return {
                      id: lt.id,
                      name: lt.name,
                      description: lt.name,
                      configSchema: lt.configSchema,
                      tools: [] as Array<{ name: string; description: string; parameters?: Record<string, unknown> }>,
                    };
                  }
                  const def = await tmpl.getDefinition();
                  return {
                    id: lt.id,
                    name: lt.name,
                    description: lt.name,
                    configSchema: def.configSchema,
                    tools: def.tools,
                  };
                }),
              ],
            )
          : [],
        toolsets: await toolsetRepo.list(),
        toolTemplates: await toolTemplateRepo.list(),
      });

      // Automatically restore the last active chat when the setting is enabled.
      if (allSettings['autoLoadLastChat'] === true) {
        const lastChatId = typeof allSettings['lastChatId'] === 'string' ? allSettings['lastChatId'] : '';
        if (lastChatId) {
          const chat = await chats.getChatById(lastChatId);
          if (chat) {
            await chatBroadcast.broadcastSnapshot(chat.id, 30, client.id);
            if (chat.characterId === null) {
              const enriched = await getEnrichedChatMembers(deps, chat.id);
              bus.sendTo(client.id, { type: 'group.members', chatId: chat.id, members: enriched });
            }
          }
        }
      }
    },
  };
}
