import { describe, it, expect, vi } from 'vitest';
import { AssistantMessageTarget, type AssistantMessageTargetDeps } from '../generation/AssistantMessageTarget.js';
import type { ChatPromptAssembly } from '../generation/ChatPromptAssembly.js';
import type { Chat, Message, PromptList } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IPromptListRepository } from '../repos/PromptListRepository.js';
import type { GenerationResult } from '../backends/BackendAdapter.js';
import type { GenerationRunner, GenerationOutcome } from '../generation/GenerationRunner.js';
import { GenerationService, type GenerationServiceDeps } from './GenerationService.js';
import { DEFAULT_IMPERSONATION_PROMPT } from '../pipeline/PromptManager.js';
import type { DraftTarget } from '../generation/DraftTarget.js';

/**
 * macroVars storage-macro resolution through a generation round — the legacy
 * GenerationService.runGeneration tests, re-pointed at AssistantMessageTarget
 * (the code's new home after the generation-runner migration). Intent
 * unchanged: setvar in generated text lands in message.extra.macroVars,
 * continue merges with the existing snapshot, and fresh messages inherit the
 * parent's snapshot.
 */
describe('AssistantMessageTarget macroVars', () => {
  function makeDeps(): {
    deps: AssistantMessageTargetDeps;
    store: Map<number, Message>;
    updatedMessages: Message[];
    appendedMessages: Message[];
  } {
    const store = new Map<number, Message>();
    const updatedMessages: Message[] = [];
    const appendedMessages: Message[] = [];

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
      getMessageById: vi.fn(async (id: number) => store.get(id)),
      appendMessage: vi.fn(async (_chatId: string, msg) => {
        const created: Message = {
          id: 1,
          parentId: (msg.parentId ?? null) as number | null,
          role: msg.role ?? 'assistant',
          extra: msg.extra ?? {},
          createdAt: 0,
          updatedAt: 0,
        } as Message;
        store.set(created.id, created);
        appendedMessages.push(created);
        return created;
      }),
      updateMessage: vi.fn(async (id: number, patch) => {
        const msg = store.get(id)!;
        const updated = { ...msg, ...patch, extra: { ...msg.extra, ...patch.extra } };
        store.set(id, updated);
        updatedMessages.push(updated);
        return updated;
      }),
      getBulkOfMessages: vi.fn(async () => []),
      getActiveBranch: vi.fn(async () => []),
    } as unknown as IChatRepository;

    const settings: ISettingsRepository = {
      list: vi.fn(async () => ({})),
      get: vi.fn(async () => undefined),
    } as unknown as ISettingsRepository;

    const deps: AssistantMessageTargetDeps = {
      chats,
      characters: {} as AssistantMessageTargetDeps['characters'],
      chatMembers: {} as AssistantMessageTargetDeps['chatMembers'],
      personas: {} as AssistantMessageTargetDeps['personas'],
      settings,
      backendConfigs: {} as AssistantMessageTargetDeps['backendConfigs'],
      chatBroadcast: {
        broadcastSnapshot: vi.fn(),
        broadcastMessageAppended: vi.fn(),
        broadcastMessageSnapshot: vi.fn(),
      } as unknown as AssistantMessageTargetDeps['chatBroadcast'],
      generationBroadcast: {
        broadcastGenerationToken: vi.fn(),
        broadcastGenerationReasoningToken: vi.fn(),
      } as unknown as AssistantMessageTargetDeps['generationBroadcast'],
      assembly: {} as ChatPromptAssembly,
    };

    return { deps, store, updatedMessages, appendedMessages };
  }

  const RESULT: GenerationResult = {
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5 },
  };

  async function streamText(target: AssistantMessageTarget, text: string): Promise<void> {
    for (const char of text) {
      target.write({ type: 'text', token: char });
    }
    await target.finalize(RESULT);
  }

  it('stores macroVars from generated text in the assistant message', async () => {
    const { deps, updatedMessages } = makeDeps();
    const target = AssistantMessageTarget.forNewMessage({ chatId: 'chat-1', character: null }, deps);
    await target.prepare();

    await streamText(target, 'Hello! {{setvar::mood::cheerful}}');

    const last = updatedMessages.at(-1)!;
    expect(last.extra.parts).toEqual([{ type: 'text', text: 'Hello! ' }]);
    expect(last.extra.macroVars).toEqual({ mood: 'cheerful' });
  });

  it('merges new macroVars with existing snapshot on continue', async () => {
    const { deps, store, updatedMessages } = makeDeps();
    store.set(1, {
      id: 1,
      parentId: null,
      role: 'assistant',
      extra: { parts: [{ type: 'text', text: 'Hello! ' }], macroVars: { mood: 'happy', topic: 'weather' } },
      createdAt: 0,
      updatedAt: 0,
    });

    const target = AssistantMessageTarget.continueFrom({ chatId: 'chat-1', character: null, messageId: 1 }, deps);
    await target.prepare();

    await streamText(target, 'It is sunny. {{setvar::detail::warm}}');

    const last = updatedMessages.at(-1)!;
    expect(last.extra.parts).toEqual([{ type: 'text', text: 'Hello! It is sunny. ' }]);
    expect(last.extra.macroVars).toEqual({
      mood: 'happy',
      topic: 'weather',
      detail: 'warm',
    });
  });

  it('carries forward parent macroVars for fresh assistant messages', async () => {
    // The parent message holds the variable snapshot the fresh assistant
    // message inherits at creation.
    const { deps, store, updatedMessages, appendedMessages } = makeDeps();
    store.set(2, {
      id: 2,
      parentId: null,
      role: 'user',
      extra: { macroVars: { greeting_type: 'casual' }, parts: [{ type: 'text', text: 'hi' }] },
      createdAt: 0,
      updatedAt: 0,
    });

    const target = AssistantMessageTarget.forNewMessage({ chatId: 'chat-1', character: null, parentId: 2 }, deps);
    await target.prepare();
    // prepare() inherited the parent's snapshot into the fresh message.
    expect(appendedMessages[0]!.extra.macroVars).toEqual({ greeting_type: 'casual' });

    await streamText(target, 'Yo! {{setvar::tone::relaxed}}');

    const last = updatedMessages.at(-1)!;
    expect(getMessageText(last.extra.parts)).toBe('Yo! ');
    expect(last.extra.macroVars).toEqual({
      greeting_type: 'casual',
      tone: 'relaxed',
    });
  });
});

/**
 * handleImpersonate — the impersonation instruction is no longer a global
 * setting: it comes from the active prompt list's builtin `impersonation`
 * utility prompt, falling back to DEFAULT_IMPERSONATION_PROMPT.
 */
describe('GenerationService.handleImpersonate', () => {
  function makeService(promptList: PromptList | undefined): {
    service: GenerationService;
    captured: { target?: DraftTarget };
  } {
    const captured: { target?: DraftTarget } = {};

    const chat: Chat = {
      id: 'chat-1',
      name: 'Test Chat',
      characterId: 'char-1',
      personaId: null,
      headMessageId: 1,
      activeChildId: 1,
      materialized: false,
      metadata: {},
      createdAt: 0,
      updatedAt: 0,
      forkedFromChatId: null,
      forkedAtMessageId: null,
    };

    const chats = {
      getChatById: vi.fn(async () => chat),
      getMessageById: vi.fn(async () => undefined),
    } as unknown as IChatRepository;

    const settings = {
      list: vi.fn(async () => ({ activePromptListId: 'list-1' })),
    } as unknown as ISettingsRepository;

    const promptLists = {
      getById: vi.fn(async () => promptList),
    } as unknown as IPromptListRepository;

    const runner = {
      acquireChat: vi.fn(async () => ({ chatId: 'chat-1' })),
      unlockChat: vi.fn(),
      run: vi.fn(async (target: DraftTarget) => {
        captured.target = target;
        return {} as GenerationOutcome;
      }),
    } as unknown as GenerationRunner;

    const deps = {
      bus: {},
      chats,
      characters: { getById: vi.fn(async () => null) },
      settings,
      personas: {},
      backendConfigs: {},
      promptLists,
      chatMembers: {},
      attachments: {},
      groupChatService: {},
      chatBroadcast: {},
      generationBroadcast: {},
      assembly: {},
      runner,
    } as unknown as GenerationServiceDeps;

    return { service: new GenerationService(deps), captured };
  }

  function promptListWith(content: string): PromptList {
    return {
      id: 'list-1',
      name: 'Test List',
      description: '',
      prompts: [
        { identifier: 'impersonation', name: 'Impersonation Prompt', content, role: 'system', enabled: true },
      ],
      promptOrder: [],
      createdAt: 0,
      updatedAt: 0,
    };
  }

  /** DraftTarget stores the resolved text in a private constructor field. */
  function impersonationTextOf(target: DraftTarget): string {
    return (target as unknown as { impersonationPrompt: string }).impersonationPrompt;
  }

  it('resolves the impersonation prompt from the active prompt list', async () => {
    const { service, captured } = makeService(promptListWith('Write as the user, custom.'));
    await service.handleImpersonate('chat-1');

    expect(captured.target).toBeDefined();
    expect(impersonationTextOf(captured.target!)).toBe('Write as the user, custom.');
  });

  it('falls back to the default when the prompt list is missing', async () => {
    const { service, captured } = makeService(undefined);
    await service.handleImpersonate('chat-1');

    expect(impersonationTextOf(captured.target!)).toBe(DEFAULT_IMPERSONATION_PROMPT);
  });

  it('falls back to the default when the utility prompt content is empty', async () => {
    const { service, captured } = makeService(promptListWith(''));
    await service.handleImpersonate('chat-1');

    expect(impersonationTextOf(captured.target!)).toBe(DEFAULT_IMPERSONATION_PROMPT);
  });
});
