import { describe, it, expect, vi } from 'vitest';
import { AssistantMessageTarget, type AssistantMessageTargetDeps } from '../generation/AssistantMessageTarget.js';
import type { ChatPromptAssembly } from '../generation/ChatPromptAssembly.js';
import type { Message } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { GenerationResult } from '../backends/BackendAdapter.js';

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
