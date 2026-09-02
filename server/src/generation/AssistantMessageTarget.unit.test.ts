/**
 * DIRECT unit tests for AssistantMessageTarget's trickiest pure logic:
 * streaming part accumulation in write(), the throttled flush, and the
 * end-of-round settleRound() post-processing (whitespace / XML stripping /
 * single-line / sentence trimming / markdown autofix / reasoning extraction).
 *
 * The existing AssistantMessageTarget.test.ts covers the broadcast-invariant
 * end-to-end via TestHarness; the GenerationService.*.test.ts suites cover
 * golden flows. These tests instead drive the target directly against fake
 * repos/broadcasters so each behavior is pinned in isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AssistantMessageTarget, type AssistantMessageTargetDeps } from './AssistantMessageTarget.js';
import type { Chat, Character, Message, MessageExtra, MessageUpdate, SettingsMap } from '@tamari/types';
import type { GenerationResult, ToolCall } from '../backends/BackendAdapter.js';
import type { ResolvedGenerationBackend } from './GenerationTarget.js';
import type { ChatPromptBuildResult } from './ChatPromptAssembly.js';

// ── Fakes ────────────────────────────────────────────────────────────────

const CHAT: Chat = {
  id: 'chat-1',
  characterId: null,
  personaId: null,
  name: 'Chat',
  headMessageId: null,
  activeChildId: null,
  materialized: true,
  createdAt: 0,
  updatedAt: 0,
  metadata: {},
  forkedFromChatId: null,
  forkedAtMessageId: null,
};

function makeDeps(settingsMap: Record<string, unknown> = {}) {
  const messages = new Map<number, Message>();
  let nextMessageId = 1;

  const chats = {
    getChatById: vi.fn(async () => CHAT),
    getMessageById: vi.fn(async (id: number) => messages.get(id)),
    appendMessage: vi.fn(
      async (_chatId: string, msg: { role: Message['role']; extra: MessageExtra; parentId?: number | null }) => {
        const m: Message = {
          id: nextMessageId++,
          parentId: msg.parentId ?? null,
          role: msg.role,
          extra: msg.extra,
          createdAt: 0,
          updatedAt: 0,
        };
        messages.set(m.id, m);
        return m;
      },
    ),
    updateMessage: vi.fn(async (id: number, patch: MessageUpdate) => {
      const m = messages.get(id);
      if (!m) throw new Error(`no message ${id}`);
      if (patch.extra) m.extra = patch.extra;
      return m;
    }),
    getBulkOfMessages: vi.fn(async () => []),
    getSiblings: vi.fn(async () => []),
    getActiveBranch: vi.fn(async () => []),
  };

  const chatBroadcast = {
    broadcastMessageAppended: vi.fn(async () => {}),
    broadcastSnapshot: vi.fn(async () => {}),
    broadcastMessageSnapshot: vi.fn(async () => {}),
    broadcastPartSnapshot: vi.fn(async () => {}),
  };

  const generationBroadcast = {
    broadcastGenerationToken: vi.fn(),
    broadcastGenerationReasoningToken: vi.fn(),
    broadcastGenerationDebugToken: vi.fn(),
  };

  const assembly = {
    build: vi.fn(async (): Promise<ChatPromptBuildResult> => ({
      prompt: { messages: [], tokenUsage: { prompt: 0, completion: 0 } },
      chatHistory: [],
      promptHistoryLimit: 100,
    })),
  };

  const deps = {
    chats,
    characters: { getById: vi.fn(async () => undefined), getByIds: vi.fn(async () => []) },
    chatMembers: { getMembers: vi.fn(async () => []) },
    personas: { getById: vi.fn(async () => undefined) },
    settings: { list: vi.fn(async () => settingsMap) },
    backendConfigs: { getById: vi.fn(async () => null) },
    chatBroadcast,
    generationBroadcast,
    assembly,
  } as unknown as AssistantMessageTargetDeps;

  return { deps, messages, chats, chatBroadcast, generationBroadcast, assembly };
}

function makeResolved(
  settings: Record<string, unknown>,
  outputReasoning?: ResolvedGenerationBackend['backend']['outputReasoning'],
): ResolvedGenerationBackend {
  return {
    allSettings: settings as SettingsMap,
    backendConfig: null,
    promptList: null,
    backendSettings: { model: 'test-model' },
    backend: { id: 'fake-backend', outputReasoning },
  } as unknown as ResolvedGenerationBackend;
}

const RESULT: GenerationResult = { finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } };

const CHARACTER = { id: 'char-1', name: 'Bot' } as unknown as Character;

/** Fresh-send target that has prepared its message slot. */
async function freshTarget(settings: Record<string, unknown> = {}) {
  const fakes = makeDeps(settings);
  const target = AssistantMessageTarget.forNewMessage({ chatId: CHAT.id, character: CHARACTER }, fakes.deps);
  target.bindGeneration('gen-1');
  await target.prepare();
  return { target, ...fakes };
}

function textPartsOf(message: Message | undefined): string[] {
  return (message?.extra.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text);
}

// ── write(): streaming part accumulation ─────────────────────────────────

describe('AssistantMessageTarget.write part accumulation', () => {
  it('consecutive text tokens merge into a single text part and broadcast per token', async () => {
    const { target, generationBroadcast, messages } = await freshTarget();

    target.write({ type: 'text', token: 'Hello' });
    target.write({ type: 'text', token: ' world' });

    expect(target.read()).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(generationBroadcast.broadcastGenerationToken).toHaveBeenCalledTimes(2);
    expect(generationBroadcast.broadcastGenerationToken).toHaveBeenNthCalledWith(1, CHAT.id, 'gen-1', 'Hello');

    // Nothing persisted yet — persistence is throttled/final, not per-token.
    const message = messages.get(target.messageId!);
    expect(message?.extra.parts).toBeUndefined();
  });

  it('reasoning tokens accumulate into their own part; text after reasoning starts a new part', async () => {
    const { target, generationBroadcast } = await freshTarget();

    target.write({ type: 'reasoning', token: 'think' });
    target.write({ type: 'reasoning', token: 'ing' });
    target.write({ type: 'text', token: 'answer' });

    expect(target.read()).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
    ]);
    expect(generationBroadcast.broadcastGenerationReasoningToken).toHaveBeenCalledTimes(2);
  });

  it('backendDebug tokens accumulate into a backend_debug part, separate from text', async () => {
    const { target } = await freshTarget();

    target.write({ type: 'text', token: 'a' });
    target.write({ type: 'backendDebug', token: 'print1' });
    target.write({ type: 'backendDebug', token: 'print2' });

    expect(target.read()).toEqual([
      { type: 'text', text: 'a' },
      { type: 'backend_debug', text: 'print1print2' },
    ]);
  });

  it('toolCall items are deduped by id (streamed AND final-result delivery lands once)', async () => {
    const { target } = await freshTarget();
    const call = { type: 'toolCall' as const, id: 'tc-1', name: 'roll', arguments: { sides: 6 } };

    target.write(call);
    target.write(call);

    expect(target.read().filter((p) => p.type === 'tool_use')).toHaveLength(1);
  });

  it('pendingToolCalls lists tool_use parts lacking a tool_result; writeToolOutcome resolves them', async () => {
    const { target, messages } = await freshTarget();

    target.write({ type: 'toolCall', id: 'tc-1', name: 'roll', arguments: {} });
    target.write({ type: 'toolCall', id: 'tc-2', name: 'look', arguments: {} });

    const pending: ToolCall[] = target.pendingToolCalls();
    expect(pending.map((c) => c.id)).toEqual(['tc-1', 'tc-2']);

    await target.writeToolOutcome(
      { id: 'tc-1', name: 'roll', arguments: {} },
      { id: 'tc-1', name: 'roll', content: [{ type: 'text', text: '4' }], isError: false },
    );

    expect(target.pendingToolCalls().map((c) => c.id)).toEqual(['tc-2']);
    const last = target.read().at(-1);
    expect(last).toMatchObject({ type: 'tool_result', toolUseId: 'tc-1', name: 'roll' });

    // The outcome was persisted through the serialized chain.
    const persisted = messages.get(target.messageId!);
    expect(persisted?.extra.parts?.some((p) => p.type === 'tool_result' && p.toolUseId === 'tc-1')).toBe(true);
  });

  it('writeToolOutcome links a tool-generated attachment to the message', async () => {
    const fakes = makeDeps({});
    const linkToMessage = vi.fn(async () => ({}));
    fakes.deps.attachments = { linkToMessage } as unknown as AssistantMessageTargetDeps['attachments'];
    const target = AssistantMessageTarget.forNewMessage({ chatId: CHAT.id, character: CHARACTER }, fakes.deps);
    target.bindGeneration('gen-1');
    await target.prepare();

    target.write({ type: 'toolCall', id: 'tc-1', name: 'generate_image', arguments: {} });
    await target.writeToolOutcome(
      { id: 'tc-1', name: 'generate_image', arguments: {} },
      {
        id: 'tc-1',
        name: 'generate_image',
        content: [{ type: 'text', text: 'done' }],
        isError: false,
        extra: { attachmentId: 'att-1', attachmentUrl: '/api/attachments/att-1', attachmentMimeType: 'image/png' },
      },
    );

    expect(linkToMessage).toHaveBeenCalledWith('att-1', target.messageId);
  });

  it('writeToolOutcome does not touch attachments when the outcome has none', async () => {
    const fakes = makeDeps({});
    const linkToMessage = vi.fn(async () => ({}));
    fakes.deps.attachments = { linkToMessage } as unknown as AssistantMessageTargetDeps['attachments'];
    const target = AssistantMessageTarget.forNewMessage({ chatId: CHAT.id, character: CHARACTER }, fakes.deps);
    target.bindGeneration('gen-1');
    await target.prepare();

    target.write({ type: 'toolCall', id: 'tc-1', name: 'roll', arguments: {} });
    await target.writeToolOutcome(
      { id: 'tc-1', name: 'roll', arguments: {} },
      { id: 'tc-1', name: 'roll', content: [{ type: 'text', text: '4' }], isError: false },
    );

    expect(linkToMessage).not.toHaveBeenCalled();
  });
});

// ── Throttled flush / abort ──────────────────────────────────────────────

describe('AssistantMessageTarget throttled flush', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('persists ~1s after the first token and broadcasts part.snapshot for the single dirty part', async () => {
    const { target, chats, chatBroadcast, messages } = await freshTarget();

    target.write({ type: 'text', token: 'chunk' });
    expect(chats.updateMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(chats.updateMessage).toHaveBeenCalledTimes(1);
    expect(messages.get(target.messageId!)?.extra.parts).toEqual([{ type: 'text', text: 'chunk' }]);
    // One dirty part → a part.snapshot for index 0, not a full message.snapshot.
    expect(chatBroadcast.broadcastPartSnapshot).toHaveBeenCalledWith(CHAT.id, target.messageId, 0);
    expect(chatBroadcast.broadcastMessageSnapshot).not.toHaveBeenCalled();
  });

  it('does not re-flush on later tokens inside the same throttle window', async () => {
    const { target, chats } = await freshTarget();

    target.write({ type: 'text', token: 'a' });
    await vi.advanceTimersByTimeAsync(500);
    target.write({ type: 'text', token: 'b' });
    await vi.advanceTimersByTimeAsync(499);
    expect(chats.updateMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(chats.updateMessage).toHaveBeenCalledTimes(1);
  });

  it('abort persists the partial stream so content survives', async () => {
    const { target, messages } = await freshTarget();

    target.write({ type: 'text', token: 'partial' });
    await target.abort(RESULT);

    expect(messages.get(target.messageId!)?.extra.parts).toEqual([{ type: 'text', text: 'partial' }]);
  });
});

// ── settleRound post-processing (driven through finalize) ────────────────

describe('AssistantMessageTarget settleRound post-processing', () => {
  async function finalizeText(settings: Record<string, unknown>, ...tokens: string[]): Promise<Message | undefined> {
    const { target, messages } = await freshTarget(settings);
    for (const token of tokens) target.write({ type: 'text', token });
    await target.finalize(RESULT);
    return messages.get(target.messageId!);
  }

  it('leaves the raw provider bytes untouched by default', async () => {
    const message = await finalizeText({}, 'Hello  world.\nNext');
    expect(textPartsOf(message)).toEqual(['Hello  world.\nNext']);
  });

  it('removeXML strips markup tags from the last text part', async () => {
    const message = await finalizeText({ removeXML: true }, 'a <b>bold</b> <i>x</i> c');
    expect(textPartsOf(message)).toEqual(['a bold x c']);
  });

  it('singleLine truncates at the first newline', async () => {
    const message = await finalizeText({ singleLine: true }, 'line one\nline two\nline three');
    expect(textPartsOf(message)).toEqual(['line one']);
  });

  it('trimSentences drops a trailing partial sentence', async () => {
    const message = await finalizeText({ trimSentences: true }, 'First sentence. Second one too! Dangling frag');
    expect(textPartsOf(message)).toEqual(['First sentence. Second one too!']);
  });

  it('autoFixGeneratedMarkdown closes an unclosed inline code span', async () => {
    const message = await finalizeText({ autoFixGeneratedMarkdown: true }, 'run `npm test now');
    expect(textPartsOf(message)).toEqual(['run `npm test now`']);
  });

  it('autoFixGeneratedMarkdown balances an odd asterisk count', async () => {
    const message = await finalizeText({ autoFixGeneratedMarkdown: true }, 'text *italic');
    expect(textPartsOf(message)).toEqual(['text *italic*']);
  });

  it('autoFixGeneratedMarkdown is naive about fences: the fence line itself gets a backtick', async () => {
    // Pinned current behavior (the source comments call this "very naive"):
    // the inline-span fixer sees 3 backticks on the fence line (odd) and
    // appends one before the fence-closing pass runs.
    const message = await finalizeText({ autoFixGeneratedMarkdown: true }, '```\ncode');
    expect(textPartsOf(message)).toEqual(['````\ncode\n```']);
  });

  it('splits text-delimited reasoning out of a flat stream when no native reasoning arrived', async () => {
    const { target, messages } = await freshTarget();
    await target.prompt(
      makeResolved(
        {},
        { pattern: '^(<think>.*?</think>)(.*)$', prefix: '<think>', suffix: '</think>', separator: '\n' },
      ),
    );

    target.write({ type: 'text', token: '<think>deep thoughts</think>The answer' });
    await target.finalize(RESULT);

    expect(target.read()).toEqual([
      { type: 'reasoning', text: 'deep thoughts' },
      { type: 'text', text: 'The answer' },
    ]);
    expect(textPartsOf(messages.get(target.messageId!))).toEqual(['The answer']);
  });

  it('native reasoning suppresses text-based extraction; the signature attaches to the last reasoning part', async () => {
    const { target } = await freshTarget();
    await target.prompt(
      makeResolved(
        {},
        { pattern: '^(<think>.*?</think>)(.*)$', prefix: '<think>', suffix: '</think>', separator: '\n' },
      ),
    );

    target.write({ type: 'reasoning', token: 'native thinking' });
    target.write({ type: 'reasoningSignature', signature: 'sig-abc' });
    target.write({ type: 'text', token: '<think>not parsed</think> text' });
    await target.finalize(RESULT);

    const parts = target.read();
    expect(parts[0]).toMatchObject({ type: 'reasoning', text: 'native thinking', signature: 'sig-abc' });
    // The literal <think> markup stays in the text part — extraction only runs
    // when the round streamed NO native reasoning.
    expect(parts[1]).toEqual({ type: 'text', text: '<think>not parsed</think> text' });
  });

  it('post-processing applies only to the LAST text part — earlier parts keep their bytes', async () => {
    const { target } = await freshTarget({ removeXML: true });

    // Round 1: text + tool call, settled by the round-2 prompt() call.
    target.write({ type: 'text', token: '<b>first</b>' });
    target.write({ type: 'toolCall', id: 'tc-1', name: 't', arguments: {} });
    await target.writeToolOutcome(
      { id: 'tc-1', name: 't', arguments: {} },
      { id: 'tc-1', name: 't', content: [], isError: false },
    );

    // Round 2 with removeXML now OFF: the already-settled first part must not
    // be re-touched, and the new part must stay raw.
    await target.prompt(makeResolved({}));
    target.write({ type: 'text', token: '<i>second</i>' });
    await target.finalize(RESULT);

    const texts = target
      .read()
      .filter((p) => p.type === 'text')
      .map((p) => p.text);
    expect(texts).toEqual(['first', '<i>second</i>']);
  });
});

// ── Continue semantics ───────────────────────────────────────────────────

describe('AssistantMessageTarget continue', () => {
  it('recomputes the last text part as original text + streamed text', async () => {
    const fakes = makeDeps();
    const existing: Message = {
      id: 42,
      parentId: null,
      role: 'assistant',
      extra: { parts: [{ type: 'text', text: 'Hello' }] },
      createdAt: 0,
      updatedAt: 0,
    };
    fakes.messages.set(42, existing);

    const target = AssistantMessageTarget.continueFrom(
      { chatId: CHAT.id, character: CHARACTER, messageId: 42 },
      fakes.deps,
    );
    await target.prepare();

    target.write({ type: 'text', token: ' world' });
    await target.finalize(RESULT);

    expect(textPartsOf(fakes.messages.get(42))).toEqual(['Hello world']);
  });

  it('messageId is known before prepare() for continue targets', () => {
    const fakes = makeDeps();
    const target = AssistantMessageTarget.continueFrom(
      { chatId: CHAT.id, character: CHARACTER, messageId: 42 },
      fakes.deps,
    );
    expect(target.messageId).toBe(42);
  });

  it('messageId is null before prepare() for fresh sends', () => {
    const fakes = makeDeps();
    const target = AssistantMessageTarget.forNewMessage({ chatId: CHAT.id, character: CHARACTER }, fakes.deps);
    expect(target.messageId).toBeNull();
  });
});

// ── Round boundaries (prompt() as the settle hook) ───────────────────────

describe('AssistantMessageTarget round boundaries', () => {
  it('prompt() settles the completed round before the next one streams', async () => {
    const { target } = await freshTarget();

    // Round 1: text + a tool call.
    target.write({ type: 'text', token: 'Round one.' });
    target.write({ type: 'toolCall', id: 'tc-1', name: 't', arguments: {} });
    await target.writeToolOutcome(
      { id: 'tc-1', name: 't', arguments: {} },
      { id: 'tc-1', name: 't', content: [], isError: false },
    );

    // Round 2 begins: prompt() runs round 1's end-of-stream processing.
    await target.prompt(makeResolved({}));
    target.write({ type: 'text', token: 'Round two.' });
    await target.finalize(RESULT);

    // Round 1's text was settled at the round boundary; round 2's text lives
    // in its own part and was settled at finalize.
    const texts = target
      .read()
      .filter((p) => p.type === 'text')
      .map((p) => p.text);
    expect(texts).toEqual(['Round one.', 'Round two.']);
  });

  it('accumulates World Info activations across rounds, deduped', async () => {
    const fakes = await freshTarget();
    fakes.assembly.build
      .mockResolvedValueOnce({
        prompt: { messages: [], tokenUsage: { prompt: 0, completion: 0 }, wiActivations: ['wi-a', 'wi-b'] },
        chatHistory: [],
        promptHistoryLimit: 100,
      })
      .mockResolvedValueOnce({
        prompt: { messages: [], tokenUsage: { prompt: 0, completion: 0 }, wiActivations: ['wi-b', 'wi-c'] },
        chatHistory: [],
        promptHistoryLimit: 100,
      });

    await fakes.target.prompt(makeResolved({}));
    await fakes.target.prompt(makeResolved({}));
    await fakes.target.finalize(RESULT);

    expect(fakes.messages.get(fakes.target.messageId!)?.extra._wiActivations).toEqual(['wi-a', 'wi-b', 'wi-c']);
  });
});

// ── finalize persistence ─────────────────────────────────────────────────

describe('AssistantMessageTarget finalize persistence', () => {
  it('persists parts with characterId, model, tokenCount and generationTime, then broadcasts a snapshot', async () => {
    const { target, messages, chatBroadcast } = await freshTarget();
    await target.prompt(makeResolved({}));

    target.write({ type: 'text', token: 'final answer' });
    await target.finalize(RESULT);

    const extra = messages.get(target.messageId!)?.extra;
    expect(extra?.parts).toEqual([{ type: 'text', text: 'final answer' }]);
    expect(extra?.characterId).toBe('char-1');
    expect(extra?.model).toBe('test-model');
    expect(extra?.tokenCount).toBeGreaterThan(0);
    expect(typeof extra?.generationTime).toBe('number');
    expect(chatBroadcast.broadcastMessageSnapshot).toHaveBeenCalledWith(CHAT.id, target.messageId);
  });

  it('stores a backend-keyed scriptState snapshot without clobbering other tools', async () => {
    const fakes = await freshTarget();
    const message = fakes.messages.get(fakes.target.messageId!)!;
    message.extra._toolState = { 'other-tool': 'keep-me' };

    await fakes.target.prompt(makeResolved({}));
    await fakes.target.finalize({ ...RESULT, scriptState: '{"k":1}' });

    expect(fakes.messages.get(fakes.target.messageId!)?.extra._toolState).toEqual({
      'other-tool': 'keep-me',
      'fake-backend': '{"k":1}',
    });
  });
});
