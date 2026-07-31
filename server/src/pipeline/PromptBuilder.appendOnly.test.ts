/**
 * Append-only prompt layout (docs/design/append-only-caching.md).
 *
 * The load-bearing property: given an append-only message log and unchanged
 * inputs, turn N's serialized request is a byte-prefix of turn N+1's. The
 * mode gets there by suppressing everything that rewrites, re-resolves, or
 * repositions already-sent bytes — each suppression has its own test below.
 */
import { describe, it, expect, vi } from 'vitest';
import { PromptBuilder, type BuildOptions } from './PromptBuilder.js';
import { WorldInfoInjector } from './WorldInfoInjector.js';
import type { Message, WorldInfoEntry, RegexRule } from '@tamari/types';

let nextId = 1;
const makeMsg = (role: Message['role'], content: string, extra?: Record<string, unknown>): Message => ({
  id: nextId++,
  role,
  extra: { parts: [{ type: 'text', text: content }], ...extra },
  createdAt: 0,
  updatedAt: 0,
  parentId: null,
});

function makeEntry(overrides: Partial<WorldInfoEntry>): WorldInfoEntry {
  return {
    id: overrides.id ?? `entry-${nextId++}`,
    keys: [],
    content: '',
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
    ...overrides,
  };
}

function makeRule(overrides: Partial<RegexRule>): RegexRule {
  return {
    id: `rule-${nextId++}`,
    name: 'rule',
    findRegex: 'hello',
    replaceString: 'REPLACED',
    disabled: false,
    userInput: false,
    aiOutput: false,
    prompt: true,
    display: false,
    ...overrides,
  };
}

const APPEND_ONLY = { caching: { appendOnly: true } } as const;

function makeOpts(overrides?: Partial<BuildOptions>): BuildOptions {
  return {
    chatHistory: [],
    userName: 'User',
    maxContext: 8192,
    maxResponseTokens: 100,
    ...overrides,
  };
}

function serialized(messages: Array<{ role: string; content: unknown }>): string[] {
  return messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`);
}

describe('append-only prompt layout', () => {
  const builder = new PromptBuilder(new WorldInfoInjector());

  it('PROPERTY: turn N is a strict prefix of turn N+1 (append-only log, no target)', async () => {
    const character = {
      id: 'char-1',
      name: 'Goldie',
      description: 'A scholar named {{char}}.',
      mesExample: '{{user}}: Hi\n{{char}}: Woof.',
    };
    const base = makeOpts({
      chatHistory: [makeMsg('user', 'one'), makeMsg('assistant', 'two {{char}}')],
      character: character as BuildOptions['character'],
      prompts: {
        authorsNote: { content: 'NOTE {{char}}', position: 'in_chat', depth: 1, role: 'system', interval: 1 },
      },
      worldInfo: {
        entries: [
          makeEntry({ id: 'kw', keys: ['one'], content: 'KEYWORD-ENTRY', constant: false }),
          makeEntry({ id: 'const-head', content: 'CONSTANT-HEAD', constant: true }),
          makeEntry({ id: 'const-depth', content: 'CONSTANT-DEPTH', constant: true, position: 'atDepth', depth: 1 }),
        ],
      },
      regexRules: [makeRule({ findRegex: 'one' })],
      ...APPEND_ONLY,
    });

    const turnN = await builder.build(base);
    const turnN1 = await builder.build({
      ...base,
      chatHistory: [...base.chatHistory, makeMsg('user', 'three')],
    });

    const serN = serialized(turnN.messages);
    const serN1 = serialized(turnN1.messages);
    expect(serN1.slice(0, serN.length)).toEqual(serN);
    expect(serN1.length).toBe(serN.length + 1);
  });

  it('PROPERTY (chat flow): everything before the stream target is byte-identical; the reply re-sends verbatim', async () => {
    const opts = makeOpts({
      chatHistory: [makeMsg('user', 'first'), makeMsg('assistant', ''),],
      prompts: {
        authorsNote: { content: 'NOTE', position: 'in_chat', depth: 0, role: 'system', interval: 1 },
      },
      ...APPEND_ONLY,
    });
    const turnN = await builder.build(opts);

    // Next turn: the target's parts are filled with the streamed reply, a new
    // user message lands, and a fresh empty target is appended.
    const replyMsg = makeMsg('assistant', 'reply text {{char}}');
    const turnN1 = await builder.build({
      ...opts,
      chatHistory: [opts.chatHistory[0]!, replyMsg, makeMsg('user', 'second'), makeMsg('assistant', '')],
    });

    const serN = serialized(turnN.messages);
    const serN1 = serialized(turnN1.messages);
    // Prefix up to (not including) turn N's trailing empty target is identical…
    expect(serN1.slice(0, serN.length - 1)).toEqual(serN.slice(0, serN.length - 1));
    // …the reply re-sends verbatim (macro literal) in the target's old slot…
    expect(serN1[serN.length - 1]).toBe('assistant:reply text {{char}}');
    // …and the new turns append after it.
    expect(serN1.slice(serN.length)).toEqual(['user:second', 'assistant:']);
  });

  it('macros render literally everywhere (history AND card fields)', async () => {
    const prompt = await builder.build(
      makeOpts({
        chatHistory: [makeMsg('assistant', 'was {{char}}')],
        character: { id: 'c', name: 'Goldie', description: 'desc {{char}}' } as BuildOptions['character'],
        ...APPEND_ONLY,
      }),
    );
    const json = JSON.stringify(prompt.messages);
    expect(json).toContain('was {{char}}');
    expect(json).toContain('desc {{char}}');
    expect(json).not.toContain('was Goldie');
    expect(json).not.toContain('desc Goldie');
  });

  it('non-constant WI entries vanish; constant head keeps its position; constant atDepth hoists', async () => {
    const prompt = await builder.build(
      makeOpts({
        chatHistory: [makeMsg('user', 'first'), makeMsg('user', 'second'), makeMsg('user', 'third')],
        worldInfo: {
          entries: [
            makeEntry({ id: 'kw', keys: ['first'], content: 'KEYWORD-ENTRY', constant: false }),
            makeEntry({ id: 'const-head', content: 'CONSTANT-HEAD', constant: true }),
            makeEntry({ id: 'const-depth', content: 'CONSTANT-DEPTH', constant: true, position: 'atDepth', depth: 1 }),
          ],
        },
        ...APPEND_ONLY,
      }),
    );
    const json = JSON.stringify(prompt.messages);
    expect(json).not.toContain('KEYWORD-ENTRY');
    expect(json).toContain('CONSTANT-HEAD');
    expect(json).toContain('CONSTANT-DEPTH');

    // The atDepth content sits in the pinned block above message 1, not at depth.
    const roles = prompt.messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : ''}`);
    const depthIdx = roles.findIndex((r) => r.includes('CONSTANT-DEPTH'));
    const firstHistoryIdx = roles.findIndex((r) => r.startsWith('user:first'));
    expect(depthIdx).toBeGreaterThanOrEqual(0);
    expect(firstHistoryIdx).toBeGreaterThan(depthIdx);
    // And NOT between second/third (its old depth-1 position).
    const secondIdx = roles.findIndex((r) => r === 'user:second');
    const thirdIdx = roles.findIndex((r) => r === 'user:third');
    expect(roles.slice(secondIdx, thirdIdx + 1)).toEqual(['user:second', 'user:third']);
  });

  it('prompt-side and aiOutput regex rules are not applied', async () => {
    const prompt = await builder.build(
      makeOpts({
        chatHistory: [makeMsg('user', 'hello'), makeMsg('assistant', 'hello')],
        regexRules: [
          makeRule({ id: 'p1', userInput: true }),
          makeRule({ id: 'p2', aiOutput: true }),
        ],
        ...APPEND_ONLY,
      }),
    );
    const json = JSON.stringify(prompt.messages);
    expect(json).not.toContain('REPLACED');
  });

  it("author's note, constant atDepth WI, and absolute preset prompts hoist in deterministic order", async () => {
    const prompt = await builder.build(
      makeOpts({
        chatHistory: [makeMsg('user', 'first'), makeMsg('user', 'second')],
        prompts: {
          authorsNote: { content: 'NOTE-TEXT', position: 'in_chat', depth: 1, role: 'system', interval: 1 },
          presetPrompts: [
            { identifier: 'main', name: 'Main', role: 'system', content: 'MAIN', enabled: true, systemPrompt: true, marker: false },
            { identifier: 'chatHistory', name: 'History', role: 'system', content: '', enabled: true, systemPrompt: true, marker: true },
            { identifier: 'abs1', name: 'Abs', role: 'system', content: 'ABS-PROMPT', enabled: true, systemPrompt: false, marker: false, injectionPosition: 'absolute', injectionDepth: 1, injectionOrder: 0 },
          ],
          presetPromptOrder: [
            { identifier: 'main', enabled: true },
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'abs1', enabled: true },
          ],
        },
        worldInfo: {
          entries: [makeEntry({ id: 'const-depth', content: 'CONSTANT-DEPTH', constant: true, position: 'atDepth', depth: 1 })],
        },
        ...APPEND_ONLY,
      }),
    );

    const json = JSON.stringify(prompt.messages);
    const noteIdx = json.indexOf('NOTE-TEXT');
    const depthIdx = json.indexOf('CONSTANT-DEPTH');
    const absIdx = json.indexOf('ABS-PROMPT');
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(depthIdx).toBeGreaterThan(noteIdx);
    expect(absIdx).toBeGreaterThan(depthIdx);
    // One pinned block: all three inside the same system message above history.
    const blockMsg = prompt.messages.find(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('NOTE-TEXT'),
    );
    expect(blockMsg).toBeDefined();
    expect(String(blockMsg!.content)).toContain('CONSTANT-DEPTH');
    expect(String(blockMsg!.content)).toContain('ABS-PROMPT');
    // The note is NOT spliced at depth between the two user messages.
    const roles = prompt.messages.map((m) => m.role);
    const lastUserIdx = roles.lastIndexOf('user');
    expect(prompt.messages[lastUserIdx]!.content).toBe('second');
  });

  it('reasoning is always re-sent verbatim (forced on, even when the setting is off)', async () => {
    const old = makeMsg('assistant', 'answer', {
      parts: [
        { type: 'reasoning', text: 'thinking out loud' },
        { type: 'text', text: 'answer' },
      ],
    });
    const prompt = await builder.build(
      makeOpts({
        chatHistory: [old, makeMsg('assistant', 'latest answer')],
        reasoningAddToPrompts: false,
        ...APPEND_ONLY,
      }),
    );
    const json = JSON.stringify(prompt.messages);
    expect(json).toContain('thinking out loud');
  });

  it('records suppressions and hoists in the append-only trace', async () => {
    const prompt = await builder.build(
      makeOpts({
        chatHistory: [makeMsg('user', 'one')],
        prompts: {
          authorsNote: { content: 'NOTE', position: 'in_chat', depth: 1, role: 'system', interval: 1 },
        },
        worldInfo: { entries: [makeEntry({ id: 'kw', keys: ['one'], content: 'X', constant: false })] },
        regexRules: [makeRule({})],
        ...APPEND_ONLY,
      }),
    );
    expect(prompt.appendOnlyTrace).toBeDefined();
    expect(prompt.appendOnlyTrace!.suppressed).toEqual(['nonConstantWorldInfo', 'promptRegex', 'macros', 'outputPostProcessing']);
    expect(prompt.appendOnlyTrace!.hoisted).toContain('authorsNote');
  });

  it('mode off leaves existing behavior untouched (control)', async () => {
    const opts = makeOpts({
      chatHistory: [makeMsg('assistant', 'was {{char}}')],
      character: { id: 'c', name: 'Goldie' } as BuildOptions['character'],
    });
    const prompt = await builder.build(opts);
    const json = JSON.stringify(prompt.messages);
    expect(json).toContain('was Goldie');
    expect(prompt.appendOnlyTrace).toBeUndefined();
  });
});

describe('append-only output side (AssistantMessageTarget)', () => {
  it('skips trimSentences/removeXML and macro resolution on persisted text', async () => {
    const { AssistantMessageTarget } = await import('../generation/AssistantMessageTarget.js');
    const store = new Map<number, Message>();
    const updatedMessages: Message[] = [];
    const chats = {
      getChatById: vi.fn(async () => ({ id: 'chat-1', characterId: null, personaId: null, headMessageId: null, activeChildId: null, materialized: false, metadata: {}, createdAt: 0, updatedAt: 0 })),
      getMessageById: vi.fn(async (id: number) => store.get(id)),
      appendMessage: vi.fn(async (_chatId: string, msg: Partial<Message>) => {
        const created: Message = {
          id: 1,
          parentId: (msg.parentId ?? null) as number | null,
          role: msg.role ?? 'assistant',
          extra: msg.extra ?? {},
          createdAt: 0,
          updatedAt: 0,
        } as Message;
        store.set(created.id, created);
        return created;
      }),
      updateMessage: vi.fn(async (id: number, patch: { extra?: Message['extra'] }) => {
        const msg = store.get(id)!;
        const updated = { ...msg, ...patch, extra: { ...msg.extra, ...patch.extra } };
        store.set(id, updated);
        updatedMessages.push(updated);
        return updated;
      }),
      getBulkOfMessages: vi.fn(async () => []),
      getActiveBranch: vi.fn(async () => []),
    };

    const settings = {
      list: vi.fn(async () => ({ appendOnlyPromptLayout: true, trimSentences: true, removeXML: true, whitespaceMode: 'full' })),
      get: vi.fn(async () => undefined),
    };

    const deps = {
      chats,
      characters: {},
      chatMembers: {},
      personas: {},
      settings,
      backendConfigs: {},
      chatBroadcast: { broadcastSnapshot: vi.fn(), broadcastMessageAppended: vi.fn(), broadcastMessageSnapshot: vi.fn() },
      generationBroadcast: { broadcastGenerationToken: vi.fn(), broadcastGenerationReasoningToken: vi.fn() },
      assembly: {},
    };

    const target = AssistantMessageTarget.forNewMessage(
      { chatId: 'chat-1', character: null },
      deps as never,
    );
    await target.prepare();

    for (const char of '<b>bold</b> incomplete sentence {{setvar::x::1}}') {
      target.write({ type: 'text', token: char });
    }
    await target.finalize({ finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } });

    const last = updatedMessages.at(-1)!;
    // Raw provider bytes: XML kept, no sentence trim, macros NOT resolved.
    expect(last.extra.parts).toEqual([{ type: 'text', text: '<b>bold</b> incomplete sentence {{setvar::x::1}}' }]);
    expect(last.extra.macroVars).toEqual({});
  });
});
