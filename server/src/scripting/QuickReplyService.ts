/**
 * Quick Reply service — loads QR definitions and executes Lua scripts.
 */

import type { EventBus } from '../bus/EventBus.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('QuickReplyService');
import type { ScriptGenerationApi } from './ScriptGenerationApi.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { IPromptListRepository } from '../repos/PromptListRepository.js';
import type { IQuickReplyRepository } from '../repos/QuickReplyRepository.js';
import type { QuickReply } from '@tamari/types';
import type { IWorldInfoRepository } from '../repos/WorldInfoRepository.js';
import type { IChatMemberRepository } from '../repos/ChatMemberRepository.js';
import type { IExtensionDataRepository } from '../repos/ExtensionDataRepository.js';
import { LuaRuntime } from './LuaRuntime.js';
import { ScriptContext } from './ScriptContext.js';
import { createStApi } from './StApi.js';

export interface QuickReplyServiceDeps {
  bus: EventBus;
  generationService: ScriptGenerationApi;
  chats: IChatRepository;
  characters: ICharacterRepository;
  personas: IPersonaRepository;
  settings: ISettingsRepository;
  backendConfigs: IBackendConfigRepository;
  promptLists: IPromptListRepository;
  worldInfo: IWorldInfoRepository;
  quickReplies: IQuickReplyRepository;
  chatMembers: IChatMemberRepository;
  extensionData: IExtensionDataRepository;
  chatBroadcast: import('../services/ChatBroadcastService.js').ChatBroadcastService;
  chatMetaBroadcast: import('../services/ChatMetaBroadcastService.js').ChatMetaBroadcastService;
}

export class QuickReplyService {
  private luaRuntime: LuaRuntime;
  private activeScripts = new Map<string, ScriptContext[]>();

  constructor(private deps: QuickReplyServiceDeps) {
    this.luaRuntime = new LuaRuntime();
  }

  async executeById(id: string, chatId: string, clientId: string): Promise<void> {
    const qr = await this.deps.quickReplies.getById(id);
    if (!qr) {
      this.deps.bus.sendTo(clientId, {
        type: 'script.error',
        message: `QuickReply ${id} not found`,
        source: 'quickreply',
      });
      return;
    }
    await this.execute(qr, chatId, clientId);
  }

  /**
   * Load Quick Replies applicable to a chat, in scope precedence order:
   * chat-specific first, then character, then global.
   */
  private async loadQuickRepliesForChat(chatId: string): Promise<QuickReply[]> {
    const { chats, characters } = this.deps;
    const chat = await chats.getChatById(chatId);
    if (!chat) return [];

    const character = chat.characterId ? await characters.getById(chat.characterId) : null;
    const characterId = character?.id ?? '';

    const [chatQrs, charQrs, globalQrs] = await Promise.all([
      this.deps.quickReplies.listByScope('chat', chatId),
      characterId ? this.deps.quickReplies.listByScope('character', characterId) : Promise.resolve([]),
      this.deps.quickReplies.listByScope('global', ''),
    ]);

    return [...chatQrs, ...charQrs, ...globalQrs].sort((a, b) => {
      if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * Run all Quick Replies whose autoExecute bitmask includes the given trigger.
   * Errors are reported to the client but do not stop subsequent matching QRs.
   */
  async runAutoExecute(chatId: string, trigger: number, clientId: string): Promise<void> {
    const qrs = await this.loadQuickRepliesForChat(chatId);
    const matching = qrs.filter((qr) => qr.language === 'lua' && (qr.autoExecute & trigger) !== 0);
    if (matching.length === 0) return;

    log.debug({ chatId, trigger, count: matching.length }, 'running auto-execute QRs');

    for (const qr of matching) {
      await this.execute(qr, chatId, clientId, { silent: true });
    }
  }

  async execute(
    qr: { script: string; language: string; label: string },
    chatId: string,
    clientId: string,
    options?: { silent?: boolean },
  ): Promise<void> {
    if (qr.language !== 'lua') {
      this.deps.bus.sendTo(clientId, {
        type: 'script.error',
        message: `QuickReply "${qr.label}" uses legacy STScript and cannot execute. Convert it to Lua.`,
        source: 'quickreply',
      });
      return;
    }

    const ctx = new ScriptContext(chatId, this.deps.generationService);
    if (!ctx.acquireLock()) {
      if (!options?.silent) {
        this.deps.bus.sendTo(clientId, {
          type: 'script.error',
          message: 'Chat is busy (another script or generation is running)',
          source: 'quickreply',
        });
      }
      return;
    }

    this.registerScript(chatId, ctx);

    const pendingPromises = new Set<Promise<unknown>>();

    const wrapApi = (obj: Record<string, unknown>): Record<string, unknown> => {
      const wrapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'function') {
          wrapped[key] = (...args: unknown[]) => {
            const result = (value as (...args: unknown[]) => unknown)(...args);
            if (result instanceof Promise) {
              pendingPromises.add(result);
              // Prevent unhandled promise rejections when Lua doesn't await the call,
              // but still log so errors aren't silently lost.
              result
                .catch((err) => log.warn({ err }, 'QuickReply async API call failed'))
                .finally(() => pendingPromises.delete(result));
            }
            return result;
          };
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          wrapped[key] = wrapApi(value as Record<string, unknown>);
        } else {
          wrapped[key] = value;
        }
      }
      return wrapped;
    };

    let cleanup: (() => void) | undefined;

    try {
      const { lua, cleanup: c } = await this.luaRuntime.createState();
      cleanup = c;
      const api = createStApi(ctx, {
        generationService: this.deps.generationService,
        chats: this.deps.chats,
        characters: this.deps.characters,
        personas: this.deps.personas,
        settings: this.deps.settings,
        backendConfigs: this.deps.backendConfigs,
        worldInfo: this.deps.worldInfo,
        chatMembers: this.deps.chatMembers,
        extensionData: this.deps.extensionData,
        bus: this.deps.bus,
        clientId,
        chatBroadcast: this.deps.chatBroadcast,
        chatMetaBroadcast: this.deps.chatMetaBroadcast,
      });
      lua.global.set('st', wrapApi(api));

      // Inject a Lua-side await helper so scripts can resolve Promises returned
      // by async st.* APIs such as st.generate(). Also wrap async APIs that
      // should pause the script so users don't have to manually await them.
      await lua.doString(`
        local rawSt = st
        st = {}
        setmetatable(st, { __index = rawSt })

        st.await = function(promise)
          return promise:await()
        end

        st.sleep = function(seconds)
          return st.await(rawSt.sleep(seconds))
        end

        st.generate = function(prompt, opts)
          return st.await(rawSt.generate(prompt, opts))
        end

        _G.st = st
      `);

      const { error } = await this.luaRuntime.run(lua, qr.script, ctx.signal);
      if (error) {
        this.deps.bus.sendTo(clientId, { type: 'script.error', message: error, source: 'quickreply' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ message }, 'script execution failed');
      this.deps.bus.sendTo(clientId, { type: 'script.error', message, source: 'quickreply' });
    } finally {
      // Wait for pending async side-effects before tearing down the Lua state.
      // Cap at 10s so a hung promise doesn't lock the chat forever.
      await Promise.race([
        Promise.allSettled(Array.from(pendingPromises)),
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);
      cleanup?.();
      this.unregisterScript(chatId, ctx);
      ctx.releaseLock();
    }
  }

  abortChat(chatId: string): void {
    const contexts = this.activeScripts.get(chatId);
    if (!contexts) return;
    for (const ctx of contexts) {
      ctx.abort();
    }
  }

  private registerScript(chatId: string, ctx: ScriptContext): void {
    const list = this.activeScripts.get(chatId) ?? [];
    list.push(ctx);
    this.activeScripts.set(chatId, list);
  }

  private unregisterScript(chatId: string, ctx: ScriptContext): void {
    const list = this.activeScripts.get(chatId);
    if (!list) return;
    const filtered = list.filter((c) => c.id !== ctx.id);
    if (filtered.length === 0) {
      this.activeScripts.delete(chatId);
    } else {
      this.activeScripts.set(chatId, filtered);
    }
  }
}
