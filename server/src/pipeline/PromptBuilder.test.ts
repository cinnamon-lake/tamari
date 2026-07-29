import { describe, it, expect } from 'vitest';
import { PromptBuilder } from './PromptBuilder.js';
import type { Message } from '@tamari/types';

const makeMsg = (role: Message['role'], content: string, extra?: Record<string, unknown>): Message => ({
  id: 1,
  role,
  extra: { parts: [{ type: 'text', text: content }], ...extra },
  createdAt: 0,
  updatedAt: 0,
  parentId: null,
});

describe('PromptBuilder reasoning reconstruction', () => {
  const builder = new PromptBuilder();

  it('includes reasoning in assistant messages as ordered parts', async () => {
    const chatHistory: Message[] = [
      makeMsg('user', 'Hello'),
      makeMsg('assistant', 'Hi there', { parts: [{ type: 'reasoning', text: 'The user said hello' }, { type: 'text', text: 'Hi there' }] }),
    ];

    const prompt = await builder.build({
      chatHistory,
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      reasoningAddToPrompts: true,
    });

    const assistantMsg = prompt.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(Array.isArray(assistantMsg?.content)).toBe(true);
    const parts = assistantMsg?.content as Array<{ type: string; text?: string }>;
    expect(parts).toBeDefined();
    expect(parts.some((p) => p.type === 'reasoning' && p.text === 'The user said hello')).toBe(true);
    expect(parts.some((p) => p.type === 'text' && p.text === 'Hi there')).toBe(true);
  });

  it('always includes reasoning for chat-completion mode regardless of addToPrompts', async () => {
    const chatHistory: Message[] = [
      makeMsg('user', 'Hello'),
      makeMsg('assistant', 'Hi there', { parts: [{ type: 'reasoning', text: 'The user said hello' }, { type: 'text', text: 'Hi there' }] }),
    ];

    const prompt = await builder.build({
      chatHistory,
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      reasoningAddToPrompts: false,
    });

    const assistantMsg = prompt.messages.find((m) => m.role === 'assistant');
    expect(Array.isArray(assistantMsg?.content)).toBe(true);
    const parts = assistantMsg?.content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === 'reasoning' && p.text === 'The user said hello')).toBe(true);
  });

  it('leaves user messages unchanged', async () => {
    const chatHistory: Message[] = [makeMsg('user', 'Hello', { parts: [{ type: 'reasoning', text: 'Some reasoning' }, { type: 'text', text: 'Hello' }] })];

    const prompt = await builder.build({
      chatHistory,
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      reasoningAddToPrompts: true,
    });

    const userMsg = prompt.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('Hello');
  });

  it('skips assistant messages without reasoning', async () => {
    const chatHistory: Message[] = [makeMsg('assistant', 'No reasoning here')];

    const prompt = await builder.build({
      chatHistory,
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      reasoningAddToPrompts: true,
    });

    const assistantMsg = prompt.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('No reasoning here');
  });

  it('computes auto cache depth from authors note depth + safety margin', async () => {
    const chatHistory: Message[] = [
      makeMsg('user', 'Hello'),
      makeMsg('assistant', 'Hi'),
      makeMsg('user', 'How are you?'),
    ];

    const prompt = await builder.build({
      chatHistory,
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      caching: { mode: 'auto' },
      prompts: {
        authorsNote: {
          content: 'AN content',
          position: 'in_chat',
          depth: 4,
          role: 'system',
          interval: 1,
        },
      },
    });

    // depth 4 + safety margin 2 = 6
    expect(prompt.cacheDepth).toBe(6);
  });

  it('uses manual cache depth when cacheMode is manual', async () => {
    const prompt = await builder.build({
      chatHistory: [],
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      caching: { mode: 'manual', manualDepth: 3 },
    });

    expect(prompt.cacheDepth).toBe(3);
  });

  it('disables caching when non-deterministic macros are detected', async () => {
    const prompt = await builder.build({
      chatHistory: [],
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      caching: { mode: 'auto' },
      character: {
        id: 'c1',
        name: 'Test',
        description: 'Desc with {{random::1::10}}',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creator: '',
        characterVersion: '',
        tags: [],
        avatarPath: null,
        avatarThumbnailPath: null,
        creatorNotes: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        alternateGreetings: [],
        extensions: {},
        createDate: '',
        worldInfoId: null,
        createdAt: 0,
        updatedAt: 0,
      } as unknown as import('@tamari/types').Character,
    });

    expect(prompt.cacheDepth).toBeUndefined();
  });

  it('returns undefined cacheDepth when cacheMode is off', async () => {
    const prompt = await builder.build({
      chatHistory: [],
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      caching: { mode: 'off' },
    });

    expect(prompt.cacheDepth).toBeUndefined();
  });

  it('includes atDepth world info in cache depth calculation', async () => {
    const prompt = await builder.build({
      chatHistory: [makeMsg('user', 'Hello')],
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      caching: { mode: 'auto' },
      worldInfo: { entries: [
        {
          id: 'wi-1',
          keys: ['test'],
          content: 'Dynamic info',
          comment: '',
          order: 0,
          position: 'atDepth',
          depth: 4,
          role: 'system',
          probability: 100,
          constant: false,
          selective: false,
          secondaryKeys: [],
          addMemo: false,
          disable: false,
          regex: false,
          recursive: false,
        },
      ] },
    });

    // depth 4 + safety margin 2 = 6
    expect(prompt.cacheDepth).toBe(6);
  });

  it('disables caching when non-constant world info is in a static position', async () => {
    const prompt = await builder.build({
      chatHistory: [makeMsg('user', 'Hello')],
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      caching: { mode: 'auto' },
      worldInfo: { entries: [
        {
          id: 'wi-1',
          keys: ['test'],
          content: 'Dynamic info',
          comment: '',
          order: 0,
          position: 'before_char',
          probability: 100,
          constant: false,
          selective: false,
          secondaryKeys: [],
          addMemo: false,
          disable: false,
          regex: false,
          recursive: false,
        },
      ] },
    });

    expect(prompt.cacheDepth).toBeUndefined();
  });

  it('allows caching when all static world info entries are constant', async () => {
    const prompt = await builder.build({
      chatHistory: [makeMsg('user', 'Hello')],
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      caching: { mode: 'auto' },
      worldInfo: { entries: [
        {
          id: 'wi-1',
          keys: ['test'],
          content: 'Constant info',
          comment: '',
          order: 0,
          position: 'before_char',
          probability: 100,
          constant: true,
          selective: false,
          secondaryKeys: [],
          addMemo: false,
          disable: false,
          regex: false,
          recursive: false,
        },
      ] },
    });

    expect(prompt.cacheDepth).toBe(2);
  });

  it('passes macroVars through to the resolver for character fields', async () => {
    const builder = new PromptBuilder();
    const chatHistory: Message[] = [makeMsg('user', 'Hello')];

    const prompt = await builder.build({
      chatHistory,
      character: {
        id: 'char-1',
        name: 'Alice',
        description: '{{getvar::mood}}',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creator: '',
        characterVersion: '',
        tags: [],
        avatarPath: null,
        avatarThumbnailPath: null,
        creatorNotes: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        alternateGreetings: [],
        groupOnlyGreetings: [],
        nickname: '',
        creatorNotesMultilingual: {},
        source: [],
        extensions: {},
        createDate: '',
        worldInfoId: null,
        createdAt: 0,
        updatedAt: 0,
      },
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      macro: { vars: { mood: 'cheerful' } },
    });

    const systemMsg = prompt.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain('cheerful');
  });
});

describe('PromptBuilder tools', () => {
  const builder = new PromptBuilder();

  it('includes tool definitions when provided', async () => {
    const chatHistory: Message[] = [makeMsg('user', 'Hello')];

    const prompt = await builder.build({
      chatHistory,
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      toolDefinitions: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: {} } },
        },
      ],
    });

    expect(prompt.tools).toHaveLength(1);
    expect(prompt.tools![0]!.function.name).toBe('get_weather');
  });

  it('omits tools when definitions are empty', async () => {
    const chatHistory: Message[] = [makeMsg('user', 'Hello')];

    const prompt = await builder.build({
      chatHistory,
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      toolDefinitions: [],
    });

    expect(prompt.tools).toBeUndefined();
  });

  it('omits tools when definitions are undefined', async () => {
    const chatHistory: Message[] = [makeMsg('user', 'Hello')];

    const prompt = await builder.build({
      chatHistory,
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
    });

    expect(prompt.tools).toBeUndefined();
  });
});

describe('PromptBuilder memory summary injection', () => {
  const builder = new PromptBuilder();

  it('injects memory summary as the first system message before chat history', async () => {
    const chatHistory: Message[] = [
      makeMsg('user', 'Hello'),
      makeMsg('assistant', 'Hi'),
    ];

    const prompt = await builder.build({
      chatHistory,
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      memorySummary: {
        summaryText: 'Alice greeted Bob [msg:1].',
        citations: [{ event: 'Alice greeted Bob', messageIds: [1] }],
        anchoredMessageId: 1,
      },
    });

    const userIndex = prompt.messages.findIndex((m) => m.role === 'user' && m.content === 'Hello');
    expect(userIndex).toBeGreaterThan(0);
    const memoryIndex = prompt.messages.findIndex((m) => m.role === 'system' && m.content === 'Alice greeted Bob [msg:1].');
    expect(memoryIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeLessThan(userIndex);
  });

  it('does not inject memory when summary text is empty', async () => {
    const chatHistory: Message[] = [makeMsg('user', 'Hello')];

    const prompt = await builder.build({
      chatHistory,
      userName: 'User',
      maxContext: 4096,
      maxResponseTokens: 100,
      memorySummary: {
        summaryText: '',
        citations: [],
        anchoredMessageId: 1,
      },
    });

    expect(prompt.messages.some((m) => m.role === 'system' && m.content === '')).toBe(false);
  });
});
