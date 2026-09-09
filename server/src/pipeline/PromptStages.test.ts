/**
 * PromptStages — the stage list is data: the default ids run in the
 * documented order, and a caller-supplied stage list can insert, reorder, or
 * drop stages. Build-level behavior of the DEFAULT list is pinned elsewhere
 * (PromptBuilder.test.ts + the golden-prompt suite); these tests pin the
 * mechanism itself.
 */
import { describe, it, expect } from 'vitest';
import { PromptBuilder, type BuildOptions } from './PromptBuilder.js';
import { createDefaultStages, type PromptStage } from './PromptStages.js';
import { getMessageText, type Message } from '@tamari/types';

function userMessage(id: number, text: string): Message {
  return {
    id,
    parentId: null,
    role: 'user',
    extra: { parts: [{ type: 'text', text }] },
    createdAt: id,
    updatedAt: id,
  };
}

function makeOpts(overrides?: Partial<BuildOptions>): BuildOptions {
  return {
    chatHistory: [userMessage(1, 'hello there')],
    userName: 'Tester',
    maxContext: 4096,
    maxResponseTokens: 100,
    ...overrides,
  };
}

const EXPECTED_DEFAULT_IDS = [
  'hiddenMessageFilter',
  'macroContext',
  'tokenCounter',
  'worldInfo',
  'promptSlots',
  'historyRegex',
  'authorsNoteSplice',
  'worldInfoAtDepth',
  'memorySummary',
  'authorsNoteSlot',
  'dialogueExamples',
  'collection',
  'cacheDepth',
  'render',
  'requestTransformers',
  'appendTail',
];

describe('PromptStages', () => {
  it('default stages run in the documented order', () => {
    const builder = new PromptBuilder();
    const ids = createDefaultStages(builder).map((s) => s.id);
    expect(ids).toEqual(EXPECTED_DEFAULT_IDS);
  });

  it('a custom stage inserted before render mutates the built prompt', async () => {
    const base = new PromptBuilder();
    const stages = createDefaultStages(base);
    const renderIndex = stages.findIndex((s) => s.id === 'render');
    const marker: PromptStage = {
      id: 'marker',
      run(ctx) {
        ctx.chatHistory = [...ctx.chatHistory, userMessage(-99, 'INSERTED-STAGE-MARKER')];
      },
    };
    stages.splice(renderIndex, 0, marker);

    const custom = new PromptBuilder(undefined, stages);
    const prompt = await custom.build(makeOpts());
    expect(JSON.stringify(prompt.messages)).toContain('INSERTED-STAGE-MARKER');
    expect(JSON.stringify(prompt.messages)).toContain('hello there');
  });

  it('dropping the memorySummary stage removes memory from the output', async () => {
    const opts = makeOpts({
      memorySummary: { summaryText: 'MEMORY-TOKEN-XYZ', citations: [], anchoredMessageId: 1 },
    });

    // Default list: the summary is prepended to the history.
    const withMemory = await new PromptBuilder().build(opts);
    expect(JSON.stringify(withMemory.messages)).toContain('MEMORY-TOKEN-XYZ');

    // Same list minus memorySummary: everything else identical, memory gone.
    const base = new PromptBuilder();
    const stages = createDefaultStages(base).filter((s) => s.id !== 'memorySummary');
    const withoutMemory = await new PromptBuilder(undefined, stages).build(opts);
    expect(JSON.stringify(withoutMemory.messages)).not.toContain('MEMORY-TOKEN-XYZ');
    expect(JSON.stringify(withoutMemory.messages)).toContain('hello there');
  });

  it('a stage list without render fails loudly instead of returning garbage', async () => {
    const base = new PromptBuilder();
    const stages = createDefaultStages(base).filter((s) => s.id !== 'render');
    await expect(new PromptBuilder(undefined, stages).build(makeOpts())).rejects.toThrow('render stage');
  });

  it('appends the generation tail truly last when no transformer chain is configured', async () => {
    const prompt = await new PromptBuilder().build(makeOpts({ tailMessages: [userMessage(2, 'TAIL-MESSAGE')] }));
    const last = prompt.messages[prompt.messages.length - 1]!;
    expect(getMessageText(last.content)).toBe('TAIL-MESSAGE');
    // Exactly one copy — the tail is not also part of the rendered history.
    expect(prompt.messages.filter((m) => getMessageText(m.content) === 'TAIL-MESSAGE')).toHaveLength(1);
  });

  it('the transformer chain never sees the generation tail', async () => {
    const prompt = await new PromptBuilder().build(
      makeOpts({
        chatHistory: [userMessage(1, '  padded history  ')],
        tailMessages: [userMessage(2, '  padded tail  ')],
        transformers: {
          steps: [{ kind: 'builtin', id: 'whitespace', enabled: true, params: { mode: 'trim' } }],
          luaSources: new Map(),
        },
      }),
    );
    const texts = prompt.messages.map((m) => getMessageText(m.content));
    // The chain ran: the history message was trimmed.
    expect(texts).toContain('padded history');
    expect(texts).not.toContain('  padded history  ');
    // The tail was appended AFTER the chain: still untrimmed, and last.
    expect(texts[texts.length - 1]).toBe('  padded tail  ');
  });
});
