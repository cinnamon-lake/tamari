import { describe, it, expect } from 'vitest';
import { TextCompletionRenderer } from './TextCompletionRenderer.js';
import { PromptManager } from '../PromptManager.js';
import { MacroResolver } from '../MacroResolver.js';
import { getInstructTemplate } from './InstructTemplate.js';
import { extractReasoning } from '../../services/ReasoningEngine.js';
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

describe('TextCompletionRenderer', () => {
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

  it('renders plain text with none template', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('none'));
    const macroResolver = MacroResolver.createPromptResolver();

    const result = renderer.render(makeCollection({ charDescription: 'A friendly bot.', scenario: 'A chat room.' }), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello'), makeMsg(2, 'assistant', 'Hi there')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    expect(result.type).toBe('text');
    expect(result.text).toContain('A friendly bot.');
    expect(result.text).toContain('A chat room.');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('Hi there');
  });

  it('wraps content with alpaca template', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('alpaca'));
    const macroResolver = MacroResolver.createPromptResolver();

    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    expect(result.text).toContain('### Instruction:');
    expect(result.text).toContain('### Response:');
  });

  it('wraps content with chatml template', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('chatml'));
    const macroResolver = MacroResolver.createPromptResolver();

    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    expect(result.text).toContain('<|im_start|>');
    expect(result.text).toContain('<|im_end|>');
  });

  it('adds BOS/EOS with llama3 template', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('llama3'));
    const macroResolver = MacroResolver.createPromptResolver();

    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    expect(result.text.startsWith('<|begin_of_text|>')).toBe(true);
  });

  it('wraps content with kimi-k3 XTML format', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('kimi-k3'));
    const macroResolver = MacroResolver.createPromptResolver();

    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    // Each message is an XTML block; the response prefix opens the <response>
    // channel (no <think> channel in non-thinking mode).
    expect(result.text).toContain('<|open|>message role="user"<|sep|>Hello<|close|>message<|sep|><|end_of_msg|>');
    expect(result.text).toContain('<|open|>message role="assistant"<|sep|><|open|>response<|sep|>');
    // No separator between messages: the assistant block directly follows the user's end_of_msg.
    expect(result.text).toContain('<|end_of_msg|><|open|>message role="assistant"<|sep|>');
  });

  it('opens the think channel for kimi-k3-thinking', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('kimi-k3-thinking'));
    const macroResolver = MacroResolver.createPromptResolver();

    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    expect(result.text.endsWith('<|open|>message role="assistant"<|sep|><|open|>think<|sep|>')).toBe(true);
  });

  it('emits an empty think channel for kimi-k3-thinking assistant turns', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('kimi-k3-thinking'));
    const macroResolver = MacroResolver.createPromptResolver();

    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello'), makeMsg(2, 'assistant', 'Hi there'), makeMsg(3, 'user', 'Bye')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    // The structural <think> channel is present (empty) even with no stored reasoning.
    expect(result.text).toContain(
      '<|open|>message role="assistant"<|sep|><|open|>think<|sep|><|close|>think<|sep|><|open|>response<|sep|>Hi there<|close|>response<|sep|><|close|>message<|sep|><|end_of_msg|>',
    );
  });

  it('extracts kimi-k3-thinking reasoning from model output', () => {
    const template = getInstructTemplate('kimi-k3-thinking');
    const r = template.reasoning!;
    const parsed = extractReasoning(
      'Let me consider.<|close|>think<|sep|><|open|>response<|sep|>Final answer.',
      r.pattern,
      r.prefix,
      r.suffix,
    );
    expect(parsed.reasoning).toBe('Let me consider.');
    expect(parsed.content).toBe('Final answer.');
  });

  it('respects token budget', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('none'));
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
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('skips empty prompts', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('none'));
    const macroResolver = MacroResolver.createPromptResolver();

    const result = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [],
      maxContext: 4096,
      maxResponseTokens: 512,
    });

    // Should only have the main prompt text
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain('Bot');
  });

  it('wraps dialogue examples with instruct template roles', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('alpaca'));
    const macroResolver = MacroResolver.createPromptResolver();
    const collection = makeCollection();
    collection.dialogueExamples = [
      { role: 'system', content: 'Example chat' },
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

    expect(result.text).toContain('### Instruction:\nHello Bob');
    expect(result.text).toContain('### Response:\nHi Alice');
  });

  it('prefills assistant content when last message is assistant (continue/regenerate)', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('alpaca'));
    const macroResolver = MacroResolver.createPromptResolver();

    // Normal case: last message is user → response prefix appended
    const resultUserLast = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [makeMsg(1, 'user', 'Hello')],
      maxContext: 4096,
      maxResponseTokens: 512,
    });
    expect(resultUserLast.text).toContain('### Response:');

    // Continue case: last message is assistant → prefill raw content, no wrapping
    const resultAssistantLast = renderer.render(makeCollection(), {
      macroResolver,
      macroCtx: { userName: 'User', charName: 'Bot' },
      tokenCounter,
      chatHistory: [
        makeMsg(1, 'user', 'Hello'),
        makeMsg(2, 'assistant', 'Hi there'),
      ],
      maxContext: 4096,
      maxResponseTokens: 512,
    });
    // The assistant message content is appended raw (unwrapped) at the end
    expect(resultAssistantLast.text.endsWith('Hi there')).toBe(true);
    // The earlier user message is still wrapped normally
    expect(resultAssistantLast.text).toContain('### Instruction:\nHello');
    // The prefill assistant message should NOT have assistantPrefix/assistantSuffix
    expect(resultAssistantLast.text).not.toContain('### Response:\nHi there');
  });
});

describe('chatHistory marker position', () => {
  function splitCollection(order: Array<{ id: string; enabled?: boolean }>): PromptCollection {
    const pm = new PromptManager(
      order.map(({ id }) => ({
        identifier: id,
        name: id,
        content: id === 'chatHistory' ? '' : `CONTENT:${id}`,
        role: 'system' as const,
        enabled: true,
        systemPrompt: true,
        marker: id === 'chatHistory',
      })),
      order.map(({ id, enabled }) => ({ identifier: id, enabled: enabled ?? true })),
    );
    return {
      prompts: pm.getOrderedPrompts(),
      markers: {
        charDescription: '',
        charPersonality: '',
        scenario: '',
        personaDescription: '',
        worldInfoBefore: '',
        worldInfoAfter: '',
      },
    };
  }

  const history = () => [makeMsg(1, 'user', 'HIST_USER_TEXT'), makeMsg(2, 'assistant', 'HIST_ASSISTANT_TEXT')];

  const renderOpts = (msgs: Message[]) => ({
    macroResolver: MacroResolver.createPromptResolver(),
    macroCtx: { userName: 'User', charName: 'Bot' } as Parameters<TextCompletionRenderer['render']>[1]['macroCtx'],
    tokenCounter,
    chatHistory: msgs,
    maxContext: 8192,
    maxResponseTokens: 512,
  });

  it('renders prompts ordered after the marker after the history, before the prefill', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('none'));
    const result = renderer.render(
      splitCollection([{ id: 'main' }, { id: 'chatHistory' }, { id: 'jailbreak' }]),
      renderOpts(history()),
    );

    // Text mode pops the trailing non-empty assistant as a raw prefill at the
    // very end — so the expected order is main < user < jailbreak < prefill.
    const text = result.text;
    expect(text.indexOf('CONTENT:main')).toBeLessThan(text.indexOf('HIST_USER_TEXT'));
    expect(text.indexOf('HIST_USER_TEXT')).toBeLessThan(text.indexOf('CONTENT:jailbreak'));
    expect(text.indexOf('CONTENT:jailbreak')).toBeLessThan(text.indexOf('HIST_ASSISTANT_TEXT'));
  });

  it('falls back to the legacy layout when no marker is present', () => {
    const renderer = new TextCompletionRenderer(getInstructTemplate('none'));
    const result = renderer.render(
      splitCollection([{ id: 'main' }, { id: 'jailbreak' }]),
      renderOpts(history()),
    );
    expect(result.text.indexOf('CONTENT:jailbreak')).toBeLessThan(result.text.indexOf('HIST_USER_TEXT'));
  });
});
