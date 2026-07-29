import { describe, it, expect, vi } from 'vitest';
import { GenerationService, type GenerationServiceDeps } from './GenerationService.js';
import { EventBus } from '../bus/EventBus.js';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import type { BackendAdapter, Prompt } from '../backends/BackendAdapter.js';
import type { Message } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { IGenerationRepository } from '../repos/GenerationRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';

describe('GenerationService.runGeneration macroVars', () => {
  function makeService(overrides?: {
    chats?: Partial<IChatRepository>;
    settings?: Partial<ISettingsRepository>;
  }): { service: GenerationService; updatedMessages: Message[]; bus: EventBus } {
    const bus = new EventBus();
    const updatedMessages: Message[] = [];

    const chats: IChatRepository = {
      getChatById: vi.fn(async () => ({
        id: 'chat-1',
        name: 'Test Chat',
        characterId: null,
        personaId: null,
        headMessageId: null,
        activeChildId: null,
        materialized: false,
        metadata: {},
        createdAt: 0,
        updatedAt: 0,
      })),
      getMessageById: vi.fn(async (id: number) => {
        return updatedMessages.find((m) => m.id === id) ?? {
          id,
          parentId: null,
          role: 'assistant',
          extra: {},
          createdAt: 0,
          updatedAt: 0,
        };
      }),
      updateMessage: vi.fn(async (id: number, patch) => {
        const msg = await chats.getMessageById(id);
        const updated = { ...msg!, ...patch, extra: { ...msg!.extra, ...patch.extra } };
        updatedMessages.push(updated);
        return updated;
      }),
      getBulkOfMessages: vi.fn(async () => []),
      ...overrides?.chats,
    } as unknown as IChatRepository;

    const generations: IGenerationRepository = {
      update: vi.fn(),
    } as unknown as IGenerationRepository;

    const settings: ISettingsRepository = {
      list: vi.fn(async () => ({})),
      get: vi.fn(async () => undefined),
      ...overrides?.settings,
    } as unknown as ISettingsRepository;

    const deps: GenerationServiceDeps = {
      bus,
      chats,
      generations,
      characters: {} as GenerationServiceDeps['characters'],
      settings,
      personas: {} as GenerationServiceDeps['personas'],
      backendConfigs: {} as GenerationServiceDeps['backendConfigs'],
      promptLists: {} as GenerationServiceDeps['promptLists'],
      chatMembers: {} as GenerationServiceDeps['chatMembers'],
      attachments: {} as GenerationServiceDeps['attachments'],
      storage: {} as GenerationServiceDeps['storage'],
      groupChatService: {} as GenerationServiceDeps['groupChatService'],
      promptBuilder: {} as GenerationServiceDeps['promptBuilder'],
      backendFactory: {} as GenerationServiceDeps['backendFactory'],
      luaRuntime: new LuaRuntime(),
      customBackends: {} as GenerationServiceDeps['customBackends'],
      worldInfo: {} as GenerationServiceDeps['worldInfo'],
      characterAssets: {} as GenerationServiceDeps['characterAssets'],
      chatBroadcast: { broadcastSnapshot: vi.fn(), broadcastMessagePatched: vi.fn(), broadcastMessageAppended: vi.fn() } as unknown as GenerationServiceDeps['chatBroadcast'],
      generationBroadcast: { broadcastGenerationStarted: vi.fn(), broadcastGenerationToken: vi.fn(), broadcastGenerationReasoningToken: vi.fn(), broadcastPromptAnnounced: vi.fn(), broadcastGenerationDone: vi.fn(), broadcastGenerationAborted: vi.fn(), broadcastGenerationError: vi.fn(), broadcastImpersonationComplete: vi.fn() } as unknown as GenerationServiceDeps['generationBroadcast'],
    };

    const service = new GenerationService(deps);
    return { service, updatedMessages, bus };
  }

  function makeMockBackend(streamingText: string): BackendAdapter {
    return {
      id: 'mock',
      supportsStreaming: true,
      supportsTools: false,
      async *stream(_prompt: Prompt, _signal: AbortSignal) {
        for (const char of streamingText) {
          yield { type: 'text' as const, token: char };
        }
        return {
          finishReason: 'stop' as const,
          usage: { promptTokens: 10, completionTokens: streamingText.length },
        };
      },
      async listModels() {
        return [];
      },
    };
  }

  it('stores macroVars from generated text in the assistant message', async () => {
    const { service, updatedMessages } = makeService();
    const backend = makeMockBackend('Hello! {{setvar::mood::cheerful}}');
    const prompt: Prompt = {
      messages: [{ role: 'user', content: 'Hi' }],
      tokenUsage: { prompt: 10, completion: 5 },
    };

    await (service as any).runGeneration('gen-1', 'chat-1', prompt, backend, 1);

    const last = updatedMessages.at(-1)!;
    expect(last.extra.parts).toEqual([{ type: 'text', text: 'Hello! ' }]);
    expect(last.extra.macroVars).toEqual({ mood: 'cheerful' });
  });

  it('merges new macroVars with existing snapshot on continue', async () => {
    const existingMessage: Message = {
      id: 1,
      parentId: null,
      role: 'assistant',
      extra: { parts: [{ type: 'text', text: 'Hello! ' }], macroVars: { mood: 'happy', topic: 'weather' } },
      createdAt: 0,
      updatedAt: 0,
    };

    const { service, updatedMessages } = makeService({
      chats: {
        getMessageById: vi.fn(async () => existingMessage),
      },
    });

    const backend = makeMockBackend('It is sunny. {{setvar::detail::warm}}');
    const prompt: Prompt = {
      messages: [{ role: 'user', content: 'Hi' }],
      tokenUsage: { prompt: 10, completion: 5 },
    };

    await (service as any).runGeneration('gen-1', 'chat-1', prompt, backend, 1);

    const last = updatedMessages.at(-1)!;
    expect(last.extra.parts).toEqual([{ type: 'text', text: 'Hello! It is sunny. ' }]);
    expect(last.extra.macroVars).toEqual({
      mood: 'happy',
      topic: 'weather',
      detail: 'warm',
    });
  });

  it('carries forward parent macroVars for fresh assistant messages', async () => {
    // Simulate a fresh generation where the target message was created with the parent's snapshot
    const targetMessage: Message = {
      id: 1,
      parentId: 2,
      role: 'assistant',
      extra: { macroVars: { greeting_type: 'casual' }, parts: [{ type: 'text', text: '' }] },
      createdAt: 0,
      updatedAt: 0,
    };

    const { service, updatedMessages } = makeService({
      chats: {
        getMessageById: vi.fn(async () => targetMessage),
      },
    });

    const backend = makeMockBackend('Yo! {{setvar::tone::relaxed}}');
    const prompt: Prompt = {
      messages: [{ role: 'user', content: 'Hi' }],
      tokenUsage: { prompt: 10, completion: 5 },
    };

    await (service as any).runGeneration('gen-1', 'chat-1', prompt, backend, 1);

    const last = updatedMessages.at(-1)!;
    expect(getMessageText(last.extra.parts)).toBe('Yo! ');
    expect(last.extra.macroVars).toEqual({
      greeting_type: 'casual',
      tone: 'relaxed',
    });
  });
});
