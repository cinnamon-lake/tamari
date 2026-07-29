import { describe, it, expect } from 'vitest';
import { ChatCompletionRenderer } from './ChatCompletionRenderer.js';
import { PromptManager } from '../PromptManager.js';
import { MacroResolver } from '../MacroResolver.js';
import type { Message } from '@tamari/types';
import type { PromptCollection } from './Renderer.js';

const tokenCounter = {
  count(text: string) {
    return Math.ceil(text.length / 4);
  },
  countMessages(messages: Array<{ role: string; content: string }>) {
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 4, 0);
  },
};

const makeMsg = (id: number, role: Message['role'], content: string): Message => ({
  id,
  parentId: null,
  role,
  extra: { parts: [{ type: 'text', text: content }] },
  createdAt: id,
  updatedAt: id,
});

describe('ChatCompletionRenderer', () => {
  const renderer = new ChatCompletionRenderer();

  function makeCollection(opts?: {
    charDescription?: string;
    charPersonality?: string;
    scenario?: string;
  }): PromptCollection {
    const pm = new PromptManager();
    return {
      prompts: pm.getOrderedPrompts(),
      markers: {
        charDescription: opts?.charDescription ?? '',
        charPersonality: opts?.charPersonality ?? '',
        scenario: opts?.scenario ?? '',
        personaDescription: '',
        worldInfoBefore: '',
        worldInfoAfter: '',
      },
    };
  }

  it('assembles basic prompt with character info', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(
      makeCollection({ charDescription: 'A friendly bot.', charPersonality: 'Cheerful.', scenario: 'A chat room.' }),
      {
        macroResolver,
        macroCtx: { userName: 'User', charName: 'Bot' },
        tokenCounter,
        chatHistory: [makeMsg(1, 'user', 'Hello'), makeMsg(2, 'assistant', 'Hi there')],
        maxContext: 4096,
        maxResponseTokens: 512,
      },
    );

    expect(result.type).toBe('chat');
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[0]!.content).toContain('A friendly bot.');
    expect(result.messages[result.messages.length - 2]!.role).toBe('user');
    expect(result.messages[result.messages.length - 1]!.role).toBe('assistant');
  });

  it('respects token budget', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const chatHistory: Message[] = [];
    for (let i = 0; i < 100; i++) {
      chatHistory.push(makeMsg(i, i % 2 === 0 ? 'user' : 'assistant', 'A'.repeat(400)));
    }

    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory,
      maxContext: 1000,
      maxResponseTokens: 100,
    });

    expect(result.tokenUsage.prompt).toBeLessThanOrEqual(900);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('squashes consecutive system messages', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(
      makeCollection({ charDescription: 'Desc', charPersonality: 'Personality', scenario: 'Scenario' }),
      {
        macroResolver,
        macroCtx: { userName: 'User', charName: 'Bot' },
        tokenCounter,
        chatHistory: [],
        maxContext: 4096,
        maxResponseTokens: 512,
      },
    );

    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages.length).toBe(1);
    expect(systemMessages[0]!.content).toContain('Desc');
    expect(systemMessages[0]!.content).toContain('Personality');
    expect(systemMessages[0]!.content).toContain('Scenario');
  });

  it('resolves macros in prompt content', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'Alice', charName: 'Bob' },
      tokenCounter,
      chatHistory: [],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    const systemMsg = result.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('Bob');
    expect(systemMsg!.content).toContain('Alice');
  });

  it('skips empty prompts', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    expect(result.messages.length).toBe(1);
  });

  it('inserts dialogue examples with correct roles', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const collection = makeCollection();
    collection.dialogueExamples = [
      { role: 'system', content: '' },
      { role: 'user', content: 'Hello {{char}}' },
      { role: 'assistant', content: 'Hi {{user}}' },
    ];

    const result = renderer.render(collection, {
      macroResolver,
      macroCtx: { userName: 'Alice', charName: 'Bob' },
      tokenCounter,
      chatHistory: [],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    const exampleMessages = result.messages.filter((m) => m.content === 'Hello Bob' || m.content === 'Hi Alice');
    expect(exampleMessages.length).toBe(2);
    expect(exampleMessages[0]!.role).toBe('user');
    expect(exampleMessages[1]!.role).toBe('assistant');
  });

  it('skips empty dialogue example messages', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const collection = makeCollection();
    collection.dialogueExamples = [
      { role: 'system', content: '' },
      { role: 'user', content: 'Hello' },
    ];

    const result = renderer.render(collection, {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    const systemMsg = result.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    // The empty <START> system message should be skipped, and the remaining
    // system prompts squashed into one.
    expect(result.messages.filter((m) => m.role === 'system').length).toBe(1);
    expect(result.messages.some((m) => m.content === 'Hello' && m.role === 'user')).toBe(true);
  });

  it('injects absolute prompts into chat history at the specified depth', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const collection = makeCollection();
    collection.prompts = [
      ...collection.prompts,
      {
        identifier: 'abs1',
        name: 'Absolute 1',
        content: 'Injected at depth 2',
        role: 'system',
        enabled: true,
        injectionPosition: 'absolute',
        injectionDepth: 2,
      },
    ];

    const result = renderer.render(collection, {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [
        makeMsg(1, 'user', 'Hello'),
        makeMsg(2, 'assistant', 'Hi'),
        makeMsg(3, 'user', 'How are you?'),
        makeMsg(4, 'assistant', 'Good'),
      ],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    // Messages should be: system, user(1), assistant(2), [injected], user(3), assistant(4)
    const injected = result.messages.find((m) => m.content === 'Injected at depth 2');
    expect(injected).toBeDefined();
    expect(injected!.role).toBe('system');
    // Depth 2 = 2 messages back from the newest (assistant(4) = 0, user(3) = 1, injected = 2)
    const injectedIndex = result.messages.findIndex((m) => m.content === 'Injected at depth 2');
    expect(result.messages[injectedIndex - 1]!.role).toBe('assistant');
    expect(result.messages[injectedIndex - 1]!.content).toBe('Hi');
    expect(result.messages[injectedIndex + 1]!.role).toBe('user');
    expect(result.messages[injectedIndex + 1]!.content).toBe('How are you?');
  });

  it('orders multiple absolute prompts at the same depth by injectionOrder', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const collection = makeCollection();
    collection.prompts = [
      ...collection.prompts,
      {
        identifier: 'absB',
        name: 'Absolute B',
        content: 'Second',
        role: 'system',
        enabled: true,
        injectionPosition: 'absolute',
        injectionDepth: 0,
        injectionOrder: 1,
      },
      {
        identifier: 'absA',
        name: 'Absolute A',
        content: 'First',
        role: 'system',
        enabled: true,
        injectionPosition: 'absolute',
        injectionDepth: 0,
        injectionOrder: 0,
      },
    ];

    const result = renderer.render(collection, {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    // Both at depth 0: inserted after the last message (user 'Hello')
    // Chronological order should be: system, user(1), First, Second
    const userIndex = result.messages.findIndex((m) => m.content === 'Hello');
    expect(result.messages[userIndex + 1]!.content).toBe('First');
    expect(result.messages[userIndex + 2]!.content).toBe('Second');
  });

  it('inserts absolute prompts at depth 0 after the newest message', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const collection = makeCollection();
    collection.prompts = [
      ...collection.prompts,
      {
        identifier: 'abs0',
        name: 'Absolute 0',
        content: 'After latest',
        role: 'system',
        enabled: true,
        injectionPosition: 'absolute',
        injectionDepth: 0,
      },
    ];

    const result = renderer.render(collection, {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello'), makeMsg(2, 'assistant', 'Hi')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    const lastMsg = result.messages[result.messages.length - 1]!;
    expect(lastMsg.content).toBe('After latest');
    expect(lastMsg.role).toBe('system');
  });

  it('inserts absolute prompts at the beginning when depth exceeds history length', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const collection = makeCollection();
    collection.prompts = [
      ...collection.prompts,
      {
        identifier: 'absDeep',
        name: 'Deep',
        content: 'Way back',
        role: 'system',
        enabled: true,
        injectionPosition: 'absolute',
        injectionDepth: 10,
      },
    ];

    const result = renderer.render(collection, {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    // Way back should be inserted before the only history message
    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages.some((m) => m.content === 'Way back')).toBe(true);
    const historyIndex = result.messages.findIndex((m) => m.content === 'Hello');
    expect(result.messages[historyIndex - 1]!.content).toBe('Way back');
  });

  it('includes the trailing empty assistant message (adapter strips it)', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [
        makeMsg(1, 'user', 'Hello'),
        makeMsg(2, 'assistant', 'Hi'),
        makeMsg(3, 'assistant', ''), // empty target message
      ],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    const historyMessages = result.messages.filter((m) => m.role !== 'system');
    expect(historyMessages.length).toBe(3);
    expect(historyMessages[0]!.content).toBe('Hello');
    expect(historyMessages[1]!.content).toBe('Hi');
    expect(historyMessages[2]!.content).toBe('');
  });

  it('keeps a non-empty trailing assistant message', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello'), makeMsg(2, 'assistant', 'Hi')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    const historyMessages = result.messages.filter((m) => m.role !== 'system');
    expect(historyMessages.length).toBe(2);
    expect(historyMessages[0]!.content).toBe('Hello');
    expect(historyMessages[1]!.content).toBe('Hi');
  });

  it('keeps reasoning in all assistant messages when reasoningAddToPrompts is true', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [
        makeMsg(1, 'user', 'Hello'),
        {
          ...makeMsg(2, 'assistant', 'Hi there'),
          extra: {
            parts: [
              { type: 'reasoning', text: 'Thinking about greeting' },
              { type: 'text', text: 'Hi there' },
            ],
          },
        },
        makeMsg(3, 'user', 'How are you?'),
        {
          ...makeMsg(4, 'assistant', 'Doing great'),
          extra: {
            parts: [
              { type: 'reasoning', text: 'Checking mood' },
              { type: 'text', text: 'Doing great' },
            ],
          },
        },
        makeMsg(5, 'assistant', ''), // empty stream target
      ],
      maxContext: 4096,
      maxResponseTokens: 512,
      reasoningAddToPrompts: true,
    });

    const assistantMsgs = result.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(3);

    // msg 2 (old) should keep reasoning
    const msg2 = assistantMsgs[0]!;
    expect(Array.isArray(msg2.content)).toBe(true);
    const parts2 = msg2.content as Array<{ type: string }>;
    expect(parts2.some((p) => p.type === 'reasoning')).toBe(true);

    // msg 4 (latest non-empty) should keep reasoning
    const msg4 = assistantMsgs[1]!;
    expect(Array.isArray(msg4.content)).toBe(true);
    const parts4 = msg4.content as Array<{ type: string }>;
    expect(parts4.some((p) => p.type === 'reasoning')).toBe(true);

    // empty stream target
    expect(assistantMsgs[2]!.content).toBe('');
  });

  it('strips reasoning from old assistant messages when reasoningAddToPrompts is false', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [
        makeMsg(1, 'user', 'Hello'),
        {
          ...makeMsg(2, 'assistant', 'Hi there'),
          extra: {
            parts: [
              { type: 'reasoning', text: 'Thinking about greeting' },
              { type: 'text', text: 'Hi there' },
            ],
          },
        },
        makeMsg(3, 'user', 'How are you?'),
        {
          ...makeMsg(4, 'assistant', 'Doing great'),
          extra: {
            parts: [
              { type: 'reasoning', text: 'Checking mood' },
              { type: 'text', text: 'Doing great' },
            ],
          },
        },
        makeMsg(5, 'assistant', ''), // empty stream target
      ],
      maxContext: 4096,
      maxResponseTokens: 512,
      reasoningAddToPrompts: false,
    });

    const assistantMsgs = result.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(3);

    // msg 2 (old) should have reasoning stripped → collapses to plain text
    const msg2 = assistantMsgs[0]!;
    expect(typeof msg2.content).toBe('string');
    expect(msg2.content).toBe('Hi there');

    // msg 4 (previous assistant before stream target) should also be stripped
    const msg4 = assistantMsgs[1]!;
    expect(typeof msg4.content).toBe('string');
    expect(msg4.content).toBe('Doing great');

    // empty stream target — protected as the latest assistant, but has no parts
    expect(assistantMsgs[2]!.content).toBe('');
  });

  it('strips reasoning and tool_use from old assistant messages', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [
        makeMsg(1, 'user', 'What is the weather?'),
        {
          ...makeMsg(2, 'assistant', 'Let me check'),
          extra: {
            parts: [
              { type: 'reasoning', text: 'Need weather data' },
              { type: 'text', text: 'Let me check' },
              { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} },
            ],
          },
        },
        makeMsg(3, 'user', 'Thanks'),
        {
          ...makeMsg(4, 'assistant', 'You are welcome'),
          extra: {
            parts: [
              { type: 'reasoning', text: 'Being polite' },
              { type: 'text', text: 'You are welcome' },
            ],
          },
        },
      ],
      maxContext: 4096,
      maxResponseTokens: 512,
      reasoningAddToPrompts: false,
    });

    const assistantMsgs = result.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(2);

    // Old message: reasoning and tool_use stripped → collapses to plain text
    const oldMsg = assistantMsgs[0]!;
    expect(typeof oldMsg.content).toBe('string');
    expect(oldMsg.content).toBe('Let me check');

    // Latest message: reasoning kept
    const latestMsg = assistantMsgs[1]!;
    expect(Array.isArray(latestMsg.content)).toBe(true);
    const latestParts = latestMsg.content as Array<{ type: string }>;
    expect(latestParts.some((p) => p.type === 'reasoning')).toBe(true);
    expect(latestParts.some((p) => p.type === 'text')).toBe(true);
  });

  it('strips legacy extra.toolCalls from old assistant messages', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [
        makeMsg(1, 'user', 'What is the weather?'),
        {
          ...makeMsg(2, 'assistant', 'Let me check'),
          extra: {
            parts: [{ type: 'text', text: 'Let me check' }],
            toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }],
          },
        },
        makeMsg(3, 'user', 'Thanks'),
        makeMsg(4, 'assistant', 'You are welcome'),
      ],
      maxContext: 4096,
      maxResponseTokens: 512,
      reasoningAddToPrompts: false,
    });

    const assistantMsgs = result.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(2);

    // Old message: legacy toolCalls stripped → plain text
    const oldMsg = assistantMsgs[0]!;
    expect(typeof oldMsg.content).toBe('string');
    expect(oldMsg.content).toBe('Let me check');

    // Latest message: plain text (no parts)
    const latestMsg = assistantMsgs[1]!;
    expect(typeof latestMsg.content).toBe('string');
    expect(latestMsg.content).toBe('You are welcome');
  });

  it('preserves tool_call_id in tool messages via tool_result parts', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const toolMsg: Message = {
      id: 1,
      parentId: null,
      role: 'tool',
      extra: { parts: [{ type: 'text', text: 'Sunny' }], toolCallId: 'call_1', toolName: 'get_weather', isError: false },
      createdAt: 1,
      updatedAt: 1,
    };
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [toolMsg],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(typeof toolMessage!.content).toBe('object');
    const parts = toolMessage!.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'tool_result')).toBe(true);
    const toolResult = parts.find((p) => p.type === 'tool_result') as unknown as {
      toolUseId: string;
      name?: string;
      content: string;
      isError?: boolean;
    };
    expect(toolResult.toolUseId).toBe('call_1');
    expect(toolResult.name).toBe('get_weather');
    expect(toolResult.content).toBe('Sunny');
    expect(toolResult.isError).toBe(false);
  });

  it('sends actual image parts when supported even with verbose mode on', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const msg: Message = {
      id: 1,
      parentId: null,
      role: 'user',
      extra: {
        parts: [{ type: 'text', text: 'Look at this' }],
        attachments: [{ id: 'img1', mimeType: 'image/png', meta: {}, url: '/api/attachments/img1' }],
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [msg],
      maxContext: 4096,
      maxResponseTokens: 512,
      supportsImages: true,
      mediaVerboseMode: true,
    });

    const userMsg = result.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);
    const parts = userMsg!.content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === 'image')).toBe(true);
    expect(parts.some((p) => p.type === 'text' && p.text === '[Attached image]')).toBe(false);
  });

  it('replaces unsupported images with text placeholder when verbose mode is on', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const msg: Message = {
      id: 1,
      parentId: null,
      role: 'user',
      extra: {
        parts: [{ type: 'text', text: 'Look at this' }],
        attachments: [{ id: 'img1', mimeType: 'image/png', meta: {}, url: '/api/attachments/img1' }],
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [msg],
      maxContext: 4096,
      maxResponseTokens: 512,
      supportsImages: false,
      mediaVerboseMode: true,
    });

    const userMsg = result.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);
    const parts = userMsg!.content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === 'image')).toBe(false);
    expect(parts.some((p) => p.type === 'text' && p.text === '[Attached image]')).toBe(true);
  });

  it('omits unsupported images entirely when verbose mode is off', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const msg: Message = {
      id: 1,
      parentId: null,
      role: 'user',
      extra: {
        parts: [{ type: 'text', text: 'Look at this' }],
        attachments: [{ id: 'img1', mimeType: 'image/png', meta: {}, url: '/api/attachments/img1' }],
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [msg],
      maxContext: 4096,
      maxResponseTokens: 512,
      supportsImages: false,
      mediaVerboseMode: false,
    });

    const userMsg = result.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(typeof userMsg!.content).toBe('string');
    expect(userMsg!.content).toBe('Look at this');
  });

  it('replaces unsupported audio with text placeholder when verbose mode is on', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const msg: Message = {
      id: 1,
      parentId: null,
      role: 'user',
      extra: {
        parts: [{ type: 'text', text: 'Listen to this' }],
        attachments: [{ id: 'aud1', mimeType: 'audio/mp3', meta: {}, url: '/api/attachments/aud1' }],
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [msg],
      maxContext: 4096,
      maxResponseTokens: 512,
      supportsAudio: false,
      mediaVerboseMode: true,
    });

    const userMsg = result.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);
    const parts = userMsg!.content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === 'audio')).toBe(false);
    expect(parts.some((p) => p.type === 'text' && p.text === '[Attached audio]')).toBe(true);
  });

  it('replaces unsupported video with text placeholder when verbose mode is on', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const msg: Message = {
      id: 1,
      parentId: null,
      role: 'user',
      extra: {
        parts: [{ type: 'text', text: 'Watch this' }],
        attachments: [{ id: 'vid1', mimeType: 'video/mp4', meta: {}, url: '/api/attachments/vid1' }],
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [msg],
      maxContext: 4096,
      maxResponseTokens: 512,
      supportsVideo: false,
      mediaVerboseMode: true,
    });

    const userMsg = result.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);
    const parts = userMsg!.content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === 'video')).toBe(false);
    expect(parts.some((p) => p.type === 'text' && p.text === '[Attached video]')).toBe(true);
  });
});
