/**
 * Regression test: `pendingInjections` must be keyed by chat.
 *
 * A Lua `st.inject` queued while chat A is active used to land in a
 * service-global slot on the shared GenerationService singleton with no
 * chatId, so the next prompt build — for ANY chat — consumed and wiped it.
 * The slot is now a `Map<chatId, string[]>` (`GenerationService.ts`), and a
 * generation only consumes entries for its own chat.
 *
 * (audit: docs/quality/audits/interface-audit-2026-07-20.md, bug #5).
 */

import { describe, it, expect, vi } from 'vitest';
import { GenerationService, type GenerationServiceDeps } from './GenerationService.js';
import { EventBus } from '../bus/EventBus.js';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import type { BackendAdapter, Prompt } from '../backends/BackendAdapter.js';
import type { Message } from '@tamari/types';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { IGenerationRepository } from '../repos/GenerationRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';

describe('GenerationService pendingInjections chat isolation', () => {
  function makeService() {
    const bus = new EventBus();

    const targetMessage: Message = {
      id: 1,
      parentId: null,
      role: 'assistant',
      extra: {},
      createdAt: 0,
      updatedAt: 0,
    };

    const chats: IChatRepository = {
      getChatById: vi.fn(async (id: string) => ({
        id,
        name: `Chat ${id}`,
        characterId: 'char-1',
        personaId: null,
        headMessageId: null,
        activeChildId: null,
        materialized: true,
        metadata: {},
        createdAt: 0,
        updatedAt: 0,
      })),
      getMessageById: vi.fn(async () => targetMessage),
      updateMessage: vi.fn(async (_id: number, patch) => ({ ...targetMessage, ...patch })),
      appendMessage: vi.fn(async () => targetMessage),
      getActiveBranch: vi.fn(async () => []),
      getBulkOfMessages: vi.fn(async () => []),
    } as unknown as IChatRepository;

    const generations: IGenerationRepository = {
      create: vi.fn(),
      update: vi.fn(),
    } as unknown as IGenerationRepository;

    const settings: ISettingsRepository = {
      list: vi.fn(async () => ({})),
      get: vi.fn(async () => undefined),
    } as unknown as ISettingsRepository;

    const backend: BackendAdapter = {
      id: 'mock',
      supportsStreaming: true,
      supportsTools: false,
      async *stream(_prompt: Prompt, _signal: AbortSignal) {
        yield { type: 'text' as const, token: 'Hi' };
        return {
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
      async listModels() {
        return [];
      },
    };

    const promptBuilder = {
      build: vi.fn(async (_opts: Record<string, unknown>) => ({
        messages: [] as Prompt['messages'],
        tokenUsage: { prompt: 1, completion: 1 },
      })),
    };

    const deps: GenerationServiceDeps = {
      bus,
      chats,
      generations,
      characters: {} as GenerationServiceDeps['characters'],
      settings,
      personas: {} as GenerationServiceDeps['personas'],
      backendConfigs: { getById: vi.fn(async () => null) } as unknown as GenerationServiceDeps['backendConfigs'],
      promptLists: { getById: vi.fn(async () => null) } as unknown as GenerationServiceDeps['promptLists'],
      chatMembers: {} as GenerationServiceDeps['chatMembers'],
      attachments: {} as GenerationServiceDeps['attachments'],
      storage: {} as GenerationServiceDeps['storage'],
      groupChatService: {} as GenerationServiceDeps['groupChatService'],
      promptBuilder: promptBuilder as unknown as GenerationServiceDeps['promptBuilder'],
      backendFactory: { create: vi.fn(async () => backend) },
      luaRuntime: new LuaRuntime(),
      customBackends: {} as GenerationServiceDeps['customBackends'],
      worldInfo: {} as GenerationServiceDeps['worldInfo'],
      characterAssets: {} as GenerationServiceDeps['characterAssets'],
      chatBroadcast: {
        broadcastSnapshot: vi.fn(),
        broadcastMessagePatched: vi.fn(),
        broadcastMessageAppended: vi.fn(),
        broadcastMessageSnapshot: vi.fn(),
      } as unknown as GenerationServiceDeps['chatBroadcast'],
      generationBroadcast: {
        broadcastGenerationStarted: vi.fn(),
        broadcastGenerationToken: vi.fn(),
        broadcastGenerationReasoningToken: vi.fn(),
        broadcastPromptAnnounced: vi.fn(),
        broadcastGenerationDone: vi.fn(),
        broadcastGenerationAborted: vi.fn(),
        broadcastGenerationError: vi.fn(),
        broadcastImpersonationComplete: vi.fn(),
      } as unknown as GenerationServiceDeps['generationBroadcast'],
    };

    const service = new GenerationService(deps);
    return { service, promptBuilder };
  }

  it("an injection queued for chat A is not consumed by chat B's generation", async () => {
    const { service, promptBuilder } = makeService();

    // Lua st.inject while chat A is active — keyed by chat A's chatId.
    service.setPendingInjection('chat-A', 'INJECTION-FOR-CHAT-A');

    // An unrelated generation runs in chat B (e.g. regenerate/continue, which
    // never reset the injection slot). executeGeneration is what every public
    // entry point funnels into; the lockHolder arg skips mutex acquisition.
    await (service as any).executeGeneration(
      'chat-B',
      null,
      undefined,
      undefined,
      'test-lock',
      undefined,
      0,
      false,
      'send',
    );

    const buildArgs = (promptBuilder.build.mock.calls[0] as [Record<string, unknown>])[0];
    const promptsB = buildArgs['prompts'] as Record<string, unknown> | undefined;

    // Chat B's prompt must NOT contain chat A's queued injection…
    expect(promptsB?.['injections']).toBeUndefined();

    // …and the injection must still be pending for chat A afterwards.
    expect((service as any).pendingInjections.get('chat-A')).toEqual(['INJECTION-FOR-CHAT-A']);

    // A subsequent generation for chat A DOES receive the injection…
    await (service as any).executeGeneration(
      'chat-A',
      null,
      undefined,
      undefined,
      'test-lock',
      undefined,
      0,
      false,
      'send',
    );

    const buildArgsA = (promptBuilder.build.mock.calls[1] as [Record<string, unknown>])[0];
    const promptsA = buildArgsA['prompts'] as Record<string, unknown> | undefined;
    expect(promptsA?.['injections']).toEqual(['INJECTION-FOR-CHAT-A']);

    // …and consumes it (one-shot).
    expect((service as any).pendingInjections.get('chat-A')).toBeUndefined();
  });
});
