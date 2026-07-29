import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryService, parseCitations } from './MemoryService.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { BackendAdapterFactory } from '../backends/factory.js';
import type { BackendAdapter, GenerationResult } from '../backends/BackendAdapter.js';
import type { MemorySettings, Message } from '@tamari/types';
import { textToParts } from '@tamari/types';

function makeMessage(id: number, role: Message['role'], text: string, parentId: number | null = null, extra?: Record<string, unknown>): Message {
  return {
    id,
    role,
    parentId,
    extra: { parts: textToParts(text), ...extra },
    createdAt: id,
    updatedAt: id,
  };
}

function makeMockDeps(overrides: {
  settings?: Partial<MemorySettings>;
  backendText?: string;
  backendError?: string;
} = {}) {
  const settings: Partial<MemorySettings> = {
    enabled: true,
    updateInterval: 2,
    depth: 2,
    backendConfigId: '',
    systemPrompt: 'Summarize.',
    maxSummaryTokens: 512,
    ...overrides.settings,
  };

  const messages: Message[] = [];

  const settingsRepo = {
    get: vi.fn(async (key: string) => (key === 'memory' ? settings : undefined)),
    getTyped: vi.fn(async () => ({ memory: settings })),
    list: vi.fn(async () => ({ memory: settings })),
  } as unknown as ISettingsRepository;

  const backendConfigs = {
    getById: vi.fn(async () => undefined),
  } as unknown as IBackendConfigRepository;

  const backend = {
    id: 'mock',
    supportsStreaming: true,
    supportsTools: true,
    stream: vi.fn(async function* () {
      if (overrides.backendText) {
        yield { type: 'text', token: overrides.backendText };
      }
      const result: GenerationResult = {
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        error: overrides.backendError,
      };
      return result;
    }),
    listModels: vi.fn(async () => []),
  } as unknown as BackendAdapter;

  const backendFactory = {
    create: vi.fn(() => backend),
  } as unknown as BackendAdapterFactory;

  const chats = {
    getMessageChain: vi.fn(async () => messages),
    getMessageById: vi.fn(async (id: number) => messages.find((m) => m.id === id)),
    updateMessage: vi.fn(async (id: number, patch) => {
      const msg = messages.find((m) => m.id === id);
      if (msg && patch.extra) {
        msg.extra = { ...msg.extra, ...patch.extra };
      }
      return msg!;
    }),
  } as unknown as IChatRepository;

  return { settingsRepo, backendConfigs, backendFactory, backend, chats, messages };
}

describe('parseCitations', () => {
  it('extracts single and multi-message citations', () => {
    const text = 'Alice left [msg:1]. Bob followed [msg:2, msg:3].';
    const citations = parseCitations(text);
    expect(citations).toHaveLength(2);
    expect(citations[0]).toEqual({ event: 'Alice left .', messageIds: [1] });
    expect(citations[1]).toEqual({ event: 'Bob followed .', messageIds: [2, 3] });
  });

  it('returns empty array when no citations present', () => {
    expect(parseCitations('No citations here.')).toHaveLength(0);
  });

  it('deduplicates repeated citations', () => {
    const text = 'Alice left [msg:1]. Again [msg:1].';
    expect(parseCitations(text)).toHaveLength(1);
  });
});

describe('MemoryService', () => {
  let service: MemoryService;
  let deps: ReturnType<typeof makeMockDeps>;

  beforeEach(() => {
    deps = makeMockDeps({ backendText: 'Summary [msg:1].' });
    service = new MemoryService({
      chats: deps.chats,
      settings: deps.settingsRepo,
      backendConfigs: deps.backendConfigs,
      backendFactory: deps.backendFactory,
    });
  });

  it('returns null when memory is disabled', async () => {
    deps = makeMockDeps({ settings: { enabled: false }, backendText: 'Summary [msg:1].' });
    service = new MemoryService({
      chats: deps.chats,
      settings: deps.settingsRepo,
      backendConfigs: deps.backendConfigs,
      backendFactory: deps.backendFactory,
    });
    const result = await service.ensureSummaryUpdated('chat1');
    expect(result).toBeNull();
    expect(deps.backend.stream).not.toHaveBeenCalled();
  });

  it('does not summarize when there are fewer user messages than updateInterval', async () => {
    deps.messages.push(makeMessage(1, 'user', 'Hello', null));
    deps.messages.push(makeMessage(2, 'assistant', 'Hi', 1));
    const result = await service.ensureSummaryUpdated('chat1');
    expect(result).toBeNull();
    expect(deps.backend.stream).not.toHaveBeenCalled();
  });

  it('summarizes when updateInterval is reached', async () => {
    deps.messages.push(makeMessage(1, 'user', 'Hello', null));
    deps.messages.push(makeMessage(2, 'assistant', 'Hi', 1));
    deps.messages.push(makeMessage(3, 'user', 'How are you?', 2));
    deps.messages.push(makeMessage(4, 'assistant', 'Good', 3));
    deps.messages.push(makeMessage(5, 'user', 'Tell me more', 4));

    const result = await service.ensureSummaryUpdated('chat1');

    expect(result).not.toBeNull();
    expect(result?.summaryText).toBe('Summary [msg:1].');
    expect(result?.anchoredMessageId).toBe(3);
    expect(deps.backend.stream).toHaveBeenCalledTimes(1);

    // Should persist to anchor message.
    const anchor = deps.messages.find((m) => m.id === 3);
    expect(anchor?.extra.memory).toEqual({
      summaryText: 'Summary [msg:1].',
      citations: [{ event: 'Summary .', messageIds: [1] }],
      anchoredAt: 3,
    });
  });

  it('returns existing summary without calling backend when not enough new messages', async () => {
    deps.messages.push(makeMessage(1, 'user', 'Hello', null, { memory: { summaryText: 'Existing [msg:1].', citations: [{ event: 'Existing', messageIds: [1] }], anchoredAt: 1 } }));
    deps.messages.push(makeMessage(2, 'assistant', 'Hi', 1));
    deps.messages.push(makeMessage(3, 'user', 'How are you?', 2));

    const result = await service.ensureSummaryUpdated('chat1');

    expect(result).not.toBeNull();
    expect(result?.summaryText).toBe('Existing [msg:1].');
    expect(deps.backend.stream).not.toHaveBeenCalled();
  });

  it('getRawMessages returns message texts by ID', async () => {
    deps.messages.push(makeMessage(1, 'user', 'Hello', null));
    deps.messages.push(makeMessage(2, 'assistant', 'Hi there', 1));

    const result = await service.getRawMessages('chat1', { messageIds: [1, 2, 99] });
    expect(result).toContain('[msg:1] You: Hello');
    expect(result).toContain('[msg:2] assistant: Hi there');
    expect(result).toContain('[msg:99] not found');
  });
});
