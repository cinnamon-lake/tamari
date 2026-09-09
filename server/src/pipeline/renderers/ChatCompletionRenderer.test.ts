import { describe, it, expect } from 'vitest';
import { ChatCompletionRenderer } from './ChatCompletionRenderer.js';
import { PromptManager } from '../PromptManager.js';
import { MacroResolver } from '../MacroResolver.js';
import { getMessageText, type Message } from '@tamari/types';
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
        charDescription: [opts?.charDescription ?? ''],
        charPersonality: [opts?.charPersonality ?? ''],
        scenario: [opts?.scenario ?? ''],
        personaDescription: [''],
        worldInfoBefore: [''],
        worldInfoAfter: [''],
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
    const systemText = result.messages
      .filter((m) => m.role === 'system')
      .map((m) => getMessageText(m.content))
      .join('\n');
    expect(systemText).toContain('A friendly bot.');
    expect(result.messages[result.messages.length - 2]!.role).toBe('user');
    expect(result.messages[result.messages.length - 1]!.role).toBe('assistant');
  });

  it('renders the full chat history — there is no token budget', () => {
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

    // Way over the old 900-token budget — tokens are reported, never enforced.
    expect(result.tokenUsage.prompt).toBeGreaterThan(900);
    const historyMessages = result.messages.filter((m) => m.role !== 'system');
    expect(historyMessages.length).toBe(100);
  });

  it('never drops system prompts, no matter their size', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const huge = `Huge persona. ${'A'.repeat(4000)}`;
    const result = renderer.render(makeCollection({ charDescription: huge }), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello')],
      maxContext: 1000,
      maxResponseTokens: 100,
    });

    const systemText = result.messages
      .filter((m) => m.role === 'system')
      .map((m) => getMessageText(m.content))
      .join('');
    expect(systemText).toContain(huge);
  });

  it('keeps each system prompt as its own message (no squashing)', () => {
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

    // main + charDescription + charPersonality + scenario — one message each.
    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages.length).toBe(4);
    const texts = systemMessages.map((m) => getMessageText(m.content));
    expect(texts.filter((t) => t.includes('Desc')).length).toBe(1);
    expect(texts.filter((t) => t.includes('Personality')).length).toBe(1);
    expect(texts.filter((t) => t.includes('Scenario')).length).toBe(1);
    // Nothing is joined: the Desc message carries none of the other entries.
    expect(texts.find((t) => t.includes('Desc'))).not.toContain('Personality');
    expect(texts.find((t) => t.includes('Desc'))).not.toContain('Scenario');
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
    expect(getMessageText(systemMsg!.content)).toContain('Bob');
    expect(getMessageText(systemMsg!.content)).toContain('Alice');
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

    const exampleMessages = result.messages.filter(
      (m) => getMessageText(m.content) === 'Hello Bob' || getMessageText(m.content) === 'Hi Alice',
    );
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
    // The empty <START> system message should be skipped; only the main prompt
    // remains as a system message.
    expect(result.messages.filter((m) => m.role === 'system').length).toBe(1);
    expect(result.messages.some((m) => getMessageText(m.content) === 'Hello' && m.role === 'user')).toBe(true);
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
    const injected = result.messages.find((m) => getMessageText(m.content) === 'Injected at depth 2');
    expect(injected).toBeDefined();
    expect(injected!.role).toBe('system');
    // Depth 2 = 2 messages back from the newest (assistant(4) = 0, user(3) = 1, injected = 2)
    const injectedIndex = result.messages.findIndex((m) => getMessageText(m.content) === 'Injected at depth 2');
    expect(result.messages[injectedIndex - 1]!.role).toBe('assistant');
    expect(getMessageText(result.messages[injectedIndex - 1]!.content)).toBe('Hi');
    expect(result.messages[injectedIndex + 1]!.role).toBe('user');
    expect(getMessageText(result.messages[injectedIndex + 1]!.content)).toBe('How are you?');
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
    const userIndex = result.messages.findIndex((m) => getMessageText(m.content) === 'Hello');
    expect(getMessageText(result.messages[userIndex + 1]!.content)).toBe('First');
    expect(getMessageText(result.messages[userIndex + 2]!.content)).toBe('Second');
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
    expect(getMessageText(lastMsg.content)).toBe('After latest');
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
    expect(systemMessages.some((m) => getMessageText(m.content) === 'Way back')).toBe(true);
    const historyIndex = result.messages.findIndex((m) => getMessageText(m.content) === 'Hello');
    expect(getMessageText(result.messages[historyIndex - 1]!.content)).toBe('Way back');
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
    expect(getMessageText(historyMessages[0]!.content)).toBe('Hello');
    expect(getMessageText(historyMessages[1]!.content)).toBe('Hi');
    expect(getMessageText(historyMessages[2]!.content)).toBe('');
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
    expect(getMessageText(historyMessages[0]!.content)).toBe('Hello');
    expect(getMessageText(historyMessages[1]!.content)).toBe('Hi');
  });

  it('keeps reasoning in all assistant messages (the renderer never strips)', () => {
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
    expect(getMessageText(assistantMsgs[2]!.content)).toBe('');
  });

  // Stripping reasoning/tool blocks from old assistant messages moved to the
  // strip-reasoning request transformer (server/src/transformers); the
  // renderer always keeps them now.

  it('keeps legacy extra.toolCalls on old assistant messages', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [
        makeMsg(1, 'user', 'What is the weather?'),
        {
          ...makeMsg(2, 'assistant', 'Let me check'),
          // Legacy shape: tool calls in extra.toolCalls, no parts array.
          extra: {
            toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }],
          },
        },
        makeMsg(3, 'user', 'Thanks'),
        makeMsg(4, 'assistant', 'You are welcome'),
      ],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    const assistantMsgs = result.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(2);

    // Old message: legacy toolCalls render as tool_use parts (the legacy
    // shape has no text parts, so the tool call stands alone).
    const oldParts = assistantMsgs[0]!.content as Array<{ type: string }>;
    expect(oldParts.some((p) => p.type === 'tool_use')).toBe(true);

    // Latest message: a single plain-text part
    const latestMsg = assistantMsgs[1]!;
    expect(getMessageText(latestMsg.content)).toBe('You are welcome');
  });

  it('preserves tool_call_id in tool messages via tool_result parts', () => {
    const macroResolver = MacroResolver.createPromptResolver();
    const toolMsg: Message = {
      id: 1,
      parentId: null,
      role: 'tool',
      extra: {
        parts: [{ type: 'text', text: 'Sunny' }],
        toolCallId: 'call_1',
        toolName: 'get_weather',
        isError: false,
      },
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
    expect(getMessageText(userMsg!.content)).toBe('Look at this');
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

  const makeToolResultMediaMsg = (): Message => ({
    id: 1,
    parentId: null,
    role: 'assistant',
    extra: {
      parts: [
        { type: 'tool_use', id: 'call_1', name: 'make_image', input: {} },
        {
          type: 'tool_result',
          toolUseId: 'call_1',
          name: 'make_image',
          content: [
            { type: 'text', text: 'Generated:' },
            { type: 'image', source: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
          ],
        },
      ],
    },
    createdAt: 1,
    updatedAt: 1,
  });

  const findToolResult = (result: ReturnType<ChatCompletionRenderer['render']>) => {
    const assistantMsg = result.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(Array.isArray(assistantMsg!.content)).toBe(true);
    const parts = assistantMsg!.content as Array<{ type: string; content?: unknown }>;
    const toolResult = parts.find((p) => p.type === 'tool_result');
    expect(toolResult).toBeDefined();
    return toolResult!;
  };

  it('keeps media in tool_result content when the backend supports it', () => {
    const result = renderer.render(makeCollection(), {
      macroResolver: MacroResolver.createPromptResolver(),
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeToolResultMediaMsg()],
      maxContext: 4096,
      maxResponseTokens: 512,
      supportsImages: true,
    });

    const content = findToolResult(result).content as Array<{ type: string }>;
    expect(content.some((p) => p.type === 'image')).toBe(true);
  });

  it('replaces unsupported media in tool_result content with a placeholder when verbose mode is on', () => {
    const result = renderer.render(makeCollection(), {
      macroResolver: MacroResolver.createPromptResolver(),
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeToolResultMediaMsg()],
      maxContext: 4096,
      maxResponseTokens: 512,
      supportsImages: false,
      mediaVerboseMode: true,
    });

    const content = findToolResult(result).content as Array<{ type: string; text?: string }>;
    expect(content.some((p) => p.type === 'image')).toBe(false);
    expect(content.some((p) => p.type === 'text' && p.text === 'Generated:')).toBe(true);
    expect(content.some((p) => p.type === 'text' && p.text === '[Attached image]')).toBe(true);
  });

  it('omits unsupported media in tool_result content entirely when verbose mode is off', () => {
    const result = renderer.render(makeCollection(), {
      macroResolver: MacroResolver.createPromptResolver(),
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeToolResultMediaMsg()],
      maxContext: 4096,
      maxResponseTokens: 512,
      supportsImages: false,
      mediaVerboseMode: false,
    });

    const content = findToolResult(result).content as Array<{ type: string }>;
    expect(content).toEqual([{ type: 'text', text: 'Generated:' }]);
  });

  it('renders an empty string when all tool_result content is filtered out', () => {
    const msg = makeToolResultMediaMsg();
    const parts = msg.extra.parts as Array<{ type: string; content?: unknown }>;
    parts[1]!.content = [{ type: 'image', source: 'data:image/png;base64,AAAA', mimeType: 'image/png' }];

    const result = renderer.render(makeCollection(), {
      macroResolver: MacroResolver.createPromptResolver(),
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [msg],
      maxContext: 4096,
      maxResponseTokens: 512,
      supportsImages: false,
    });

    expect(findToolResult(result).content).toBe('');
  });
});

describe('chatHistory marker position', () => {
  const renderer = new ChatCompletionRenderer();

  function splitCollection(
    order: Array<{ id: string; enabled?: boolean }>,
    extras?: { dialogueExamples?: PromptCollection['dialogueExamples'] },
  ): PromptCollection {
    const pm = new PromptManager(
      order.map(({ id }) => ({
        identifier: id,
        name: id,
        content: id === 'chatHistory' ? '' : `CONTENT:${id}`,
        role: 'system' as const,
        enabled: true,
        systemPrompt: true,
        marker: id === 'chatHistory' || id === 'dialogueExamples',
      })),
      order.map(({ id, enabled }) => ({ identifier: id, enabled: enabled ?? true })),
    );
    return {
      prompts: pm.getOrderedPrompts(),
      markers: {
        charDescription: [''],
        charPersonality: [''],
        scenario: [''],
        personaDescription: [''],
        worldInfoBefore: [''],
        worldInfoAfter: [''],
      },
      dialogueExamples: extras?.dialogueExamples,
    };
  }

  const history = () => [makeMsg(1, 'user', 'HIST_USER'), makeMsg(2, 'assistant', 'HIST_ASSISTANT')];

  const renderOpts = (msgs: Message[]) => ({
    macroResolver: MacroResolver.createPromptResolver(),
    macroCtx: { userName: 'User', charName: 'Bot' } as Parameters<ChatCompletionRenderer['render']>[1]['macroCtx'],
    tokenCounter,
    chatHistory: msgs,
    maxContext: 8192,
    maxResponseTokens: 512,
  });

  /** Index of the first message whose text content contains `needle`. */
  function indexOfText(result: ReturnType<ChatCompletionRenderer['render']>, needle: string): number {
    return result.messages.findIndex((m) => getMessageText(m.content).includes(needle));
  }

  it('renders prompts ordered after the marker after the history (jailbreak case)', () => {
    const result = renderer.render(
      splitCollection([{ id: 'main' }, { id: 'chatHistory' }, { id: 'jailbreak' }]),
      renderOpts(history()),
    );

    const mainIdx = indexOfText(result, 'CONTENT:main');
    const histIdx = indexOfText(result, 'HIST_USER');
    const jbIdx = indexOfText(result, 'CONTENT:jailbreak');
    expect(mainIdx).toBeGreaterThanOrEqual(0);
    expect(histIdx).toBeGreaterThan(mainIdx);
    expect(jbIdx).toBeGreaterThan(histIdx);

    // No squashing anywhere: the after-marker system prompt renders as its own
    // message, never merged into the before-marker one.
    const mainMsg = result.messages[mainIdx]!;
    expect(getMessageText(mainMsg.content)).not.toContain('CONTENT:jailbreak');
  });

  it('renders prompts ordered before the marker before the history', () => {
    const result = renderer.render(splitCollection([{ id: 'main' }, { id: 'chatHistory' }]), renderOpts(history()));
    expect(indexOfText(result, 'CONTENT:main')).toBeLessThan(indexOfText(result, 'HIST_USER'));
  });

  it('falls back to the legacy layout when no marker is present', () => {
    const result = renderer.render(splitCollection([{ id: 'main' }, { id: 'jailbreak' }]), renderOpts(history()));
    const jbIdx = indexOfText(result, 'CONTENT:jailbreak');
    expect(jbIdx).toBeGreaterThanOrEqual(0);
    expect(jbIdx).toBeLessThan(indexOfText(result, 'HIST_USER'));
  });

  it('falls back to the legacy layout when the marker is disabled', () => {
    const result = renderer.render(
      splitCollection([{ id: 'main' }, { id: 'chatHistory', enabled: false }, { id: 'jailbreak' }]),
      renderOpts(history()),
    );
    const jbIdx = indexOfText(result, 'CONTENT:jailbreak');
    expect(jbIdx).toBeGreaterThanOrEqual(0);
    expect(jbIdx).toBeLessThan(indexOfText(result, 'HIST_USER'));
  });

  it('expands dialogueExamples after the history when ordered after the marker', () => {
    const result = renderer.render(
      splitCollection([{ id: 'chatHistory' }, { id: 'dialogueExamples' }], {
        dialogueExamples: [
          { role: 'user', content: 'EXAMPLE_Q' },
          { role: 'assistant', content: 'EXAMPLE_A' },
        ],
      }),
      renderOpts(history()),
    );
    expect(indexOfText(result, 'EXAMPLE_Q')).toBeGreaterThan(indexOfText(result, 'HIST_ASSISTANT'));
  });
});

describe('generation tail', () => {
  const renderer = new ChatCompletionRenderer();

  function makeCollectionWithJailbreak(): PromptCollection {
    const pm = new PromptManager(
      [
        {
          identifier: 'main',
          name: 'main',
          content: 'MAIN',
          role: 'system',
          enabled: true,
          systemPrompt: true,
          marker: false,
        },
        {
          identifier: 'chatHistory',
          name: 'chatHistory',
          content: '',
          role: 'system',
          enabled: true,
          systemPrompt: true,
          marker: true,
        },
        {
          identifier: 'jailbreak',
          name: 'jailbreak',
          content: 'JAILBREAK',
          role: 'system',
          enabled: true,
          systemPrompt: true,
          marker: false,
        },
      ],
      [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
      ],
    );
    return {
      prompts: pm.getOrderedPrompts(),
      markers: {
        charDescription: [''],
        charPersonality: [''],
        scenario: [''],
        personaDescription: [''],
        worldInfoBefore: [''],
        worldInfoAfter: [''],
      },
    };
  }

  const renderOpts = (msgs: Message[], tail?: Message[]) => ({
    macroResolver: MacroResolver.createPromptResolver(),
    macroCtx: { userName: 'Alice', charName: 'Bob' } as Parameters<ChatCompletionRenderer['render']>[1]['macroCtx'],
    tokenCounter,
    chatHistory: msgs,
    tailMessages: tail,
    maxContext: 8192,
    maxResponseTokens: 512,
  });

  it('returns an empty tail when tailMessages is absent', () => {
    const result = renderer.render(makeCollectionWithJailbreak(), renderOpts([makeMsg(1, 'user', 'Hello')]));
    expect(result.tail).toEqual([]);
  });

  it('renders tailMessages as result.tail, kept out of result.messages', () => {
    const result = renderer.render(
      makeCollectionWithJailbreak(),
      renderOpts([makeMsg(1, 'user', 'Hello')], [makeMsg(2, 'assistant', '')]),
    );
    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]!.role).toBe('assistant');
    expect(getMessageText(result.tail[0]!.content)).toBe('');
    // The tail is not in messages — the only assistant content there is none.
    expect(result.messages.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('renders the tail after after-history prompts when re-appended (truly last)', () => {
    const result = renderer.render(
      makeCollectionWithJailbreak(),
      renderOpts([makeMsg(1, 'user', 'HIST')], [makeMsg(2, 'assistant', 'TAIL')]),
    );
    // messages end with the jailbreak; the tail rides separately and a later
    // stage appends it — the final prompt is [..., JAILBREAK, TAIL].
    expect(getMessageText(result.messages[result.messages.length - 1]!.content)).toBe('JAILBREAK');
    const finalMessages = [...result.messages, ...result.tail];
    expect(getMessageText(finalMessages[finalMessages.length - 1]!.content)).toBe('TAIL');
    const jbIdx = finalMessages.findIndex((m) => getMessageText(m.content) === 'JAILBREAK');
    const tailIdx = finalMessages.findIndex((m) => getMessageText(m.content) === 'TAIL');
    expect(tailIdx).toBeGreaterThan(jbIdx);
  });

  it('attaches depth-0 absolute prompts after the last REAL history message, before the tail', () => {
    const collection = makeCollectionWithJailbreak();
    collection.prompts = [
      ...collection.prompts,
      {
        identifier: 'abs0',
        name: 'Absolute 0',
        content: 'DEPTH-ZERO',
        role: 'system',
        enabled: true,
        injectionPosition: 'absolute',
        injectionDepth: 0,
      },
    ];

    const result = renderer.render(
      collection,
      renderOpts([makeMsg(1, 'user', 'Hello')], [makeMsg(2, 'assistant', '')]),
    );

    // Depth 0 = after the newest chatHistory element ('Hello') — the tail is
    // NOT the newest anything: the injection lands inside `messages`, and the
    // tail still comes after it once appended.
    const helloIdx = result.messages.findIndex((m) => getMessageText(m.content) === 'Hello');
    expect(getMessageText(result.messages[helloIdx + 1]!.content)).toBe('DEPTH-ZERO');
    expect(result.messages.some((m) => m.role === 'assistant')).toBe(false);
    expect(getMessageText(result.tail[0]!.content)).toBe('');
  });

  it('excludes the tail from depth counting', () => {
    const collection = makeCollectionWithJailbreak();
    collection.prompts = [
      ...collection.prompts,
      {
        identifier: 'abs1',
        name: 'Absolute 1',
        content: 'DEPTH-ONE',
        role: 'system',
        enabled: true,
        injectionPosition: 'absolute',
        injectionDepth: 1,
      },
    ];

    const result = renderer.render(
      collection,
      renderOpts([makeMsg(1, 'user', 'ONE'), makeMsg(2, 'assistant', 'TWO')], [makeMsg(3, 'assistant', '')]),
    );

    // Depth 1 counts REAL history only: ONE(1) TWO(0) → injected between them.
    // If the tail counted, it would land after TWO instead.
    const oneIdx = result.messages.findIndex((m) => getMessageText(m.content) === 'ONE');
    expect(getMessageText(result.messages[oneIdx + 1]!.content)).toBe('DEPTH-ONE');
    expect(getMessageText(result.messages[oneIdx + 2]!.content)).toBe('TWO');
  });

  it('resolves macros in tail messages', () => {
    const result = renderer.render(
      makeCollectionWithJailbreak(),
      renderOpts([makeMsg(1, 'user', 'Hello')], [makeMsg(2, 'user', '{{user}} says hi to {{char}}')]),
    );
    expect(getMessageText(result.tail[0]!.content)).toBe('Alice says hi to Bob');
  });

  it('includes the tail in the prompt token count', () => {
    const withTail = renderer.render(
      makeCollectionWithJailbreak(),
      renderOpts([makeMsg(1, 'user', 'Hello')], [makeMsg(2, 'assistant', 'TAIL-TOKENS')]),
    );
    const withoutTail = renderer.render(makeCollectionWithJailbreak(), renderOpts([makeMsg(1, 'user', 'Hello')]));
    expect(withTail.tokenUsage.prompt).toBeGreaterThan(withoutTail.tokenUsage.prompt);
  });
});
