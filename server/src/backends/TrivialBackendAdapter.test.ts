import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { TrivialBackendAdapter } from './TrivialBackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';
import { ToolRegistry } from '../services/ToolRegistry.js';
import { getMessageText } from '@tamari/types';

describe('TrivialBackendAdapter', () => {
  it('emits predefined content blocks as streaming tokens', async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'Hello!' }],
    ]);

    const prompt = {
      messages: [{ role: 'user' as const, content: 'Hi' }],
      tokenUsage: { prompt: 2, completion: 6 },
    };

    const { items, result } = await consumeStream(backend.stream(
      prompt,
      new AbortController().signal,
    ));
    const tokens = items.filter((i) => i.type === 'text').map((i) => i.token);

    expect(tokens.join('')).toBe('Hello!');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();
  });

  it('emits thinking blocks via emitReasoning', async () => {
    const backend = new TrivialBackendAdapter([
      [
        { type: 'thinking', content: 'Let me think...' },
        { type: 'content', content: 'Done.' },
      ],
    ]);

    const { items, result } = await consumeStream(backend.stream(
      { messages: [], tokenUsage: { prompt: 1, completion: 20 } },
      new AbortController().signal,
    ));
    const tokens = items.filter((i) => i.type === 'text').map((i) => i.token);
    const reasoning = items.filter((i) => i.type === 'reasoning').map((i) => i.token);

    expect(reasoning.join('')).toBe('Let me think...');
    expect(tokens.join('')).toBe('Done.');
    expect(result.reasoningText).toBe('Let me think...');
  });

  it('returns toolCalls for tool_use blocks', async () => {
    const backend = new TrivialBackendAdapter([
      [
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
      ],
    ]);

    const { result } = await consumeStream(backend.stream(
      { messages: [], tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({
      id: 'call_1',
      name: 'get_weather',
      arguments: { city: 'Paris' },
    });
  });

  it('cycles through multiple responses on successive stream calls', async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'First' }],
      [{ type: 'content', content: 'Second' }],
      [{ type: 'content', content: 'Third' }],
    ]);

    for (const expected of ['First', 'Second', 'Third']) {
      const { items } = await consumeStream(backend.stream(
        { messages: [], tokenUsage: { prompt: 1, completion: 10 } },
        new AbortController().signal,
      ));
      const tokens = items.filter((i) => i.type === 'text').map((i) => i.token);
      expect(tokens.join('')).toBe(expected);
    }
  });

  it('returns empty result when responses are exhausted', async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'Only' }],
    ]);

    // First call
    const { items: items1 } = await consumeStream(backend.stream(
      { messages: [], tokenUsage: { prompt: 1, completion: 4 } },
      new AbortController().signal,
    ));
    const tokens1 = items1.filter((i) => i.type === 'text').map((i) => i.token);
    expect(tokens1.join('')).toBe('Only');

    // Second call — no more responses
    const { items: items2, result } = await consumeStream(backend.stream(
      { messages: [], tokenUsage: { prompt: 1, completion: 0 } },
      new AbortController().signal,
    ));
    const tokens2 = items2.filter((i) => i.type === 'text').map((i) => i.token);
    expect(tokens2).toHaveLength(0);
    expect(result.finishReason).toBe('stop');
  });
});

describe('TrivialBackendAdapter through bus mock', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      [
        { type: 'thinking', content: 'Hmm' },
        { type: 'content', content: 'Hello!' },
      ],
    ]);

    h = new TestHarness({
      backendFactory: {
        create: async () => backend,
      },
    });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('streams tokens through the bus', async () => {
    // Create a character with a greeting so materialize does something
    await h.send(client, {
      type: 'character.create',
      data: { name: 'TestBot', description: 'A test bot.', firstMes: 'Hello there!' },
    });

    const created = h.expectBroadcast('character.created');
    const charId = created.character.id;

    // Configure settings directly (no preset needed for test)
    await h.deps.settings.setValue('model', 'trivial-model');
    await h.deps.settings.setValue('apiKey', 'fake-key');
    await h.deps.settings.setValue('backendProvider', 'openai');
    await h.deps.settings.setValue('maxResponseTokens', 100);

    // Create a chat
    await h.send(client, {
      type: 'chat.create',
      data: { characterId: charId, name: 'Test Chat' },
    });

    const chatCreated = h.expectBroadcast('chat.created');
    const chatId = chatCreated.chat.id;

    // Materialize greetings
    await h.send(client, {
      type: 'chat.materialize',
      chatId,
    });

    h.expectBroadcast('chat.snapshot');

    // Send a user message
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hi there!',
    });

    h.expectBroadcast('chat.snapshot');

    // Trigger generation
    await h.send(client, {
      type: 'action.generate',
      chatId,
    });

    // Should see generation.started
    const started = h.expectBroadcast('generation.started');
    expect(started.chatId).toBe(chatId);

    // Should see reasoning tokens
    const reasoningTokens = client.messages.filter((m) => m.type === 'generation.reasoningToken');
    expect(reasoningTokens.length).toBeGreaterThan(0);
    expect(reasoningTokens.map((m: any) => m.token).join('')).toBe('Hmm');

    // Should see content tokens
    const contentTokens = client.messages.filter((m) => m.type === 'generation.token');
    expect(contentTokens.length).toBeGreaterThan(0);
    expect(contentTokens.map((m: any) => m.token).join('')).toBe('Hello!');

    // Should see message.snapshot with final content
    const patched = h.expectBroadcast('message.snapshot');
    expect(patched.chatId).toBe(chatId);

    // Should see generation.done
    const done = h.expectBroadcast('generation.done');
    expect(done.finishReason).toBe('stop');
  });
});


describe('TrivialBackendAdapter tool-use through bus mock', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }],
      [{ type: 'content', content: 'The weather in Paris is sunny.' }],
    ]);

    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTemplate({
      id: 'weather',
      name: 'Weather',
      source: 'builtin',
      getDefinition: () => ({
        stateKey: 'weather',
        configSchema: {},
        tools: [
          {
            name: 'get_weather',
            description: 'Get the weather for a city.',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      }),
      execute: (_toolName, args) =>
        Promise.resolve({ content: `Weather for ${(args as { city: string }).city}: sunny, 25°C` }),
      serialize: () => '',
      deserialize: () => {},
    });

    h = new TestHarness({
      backendFactory: {
        create: async () => backend,
      },
      toolRegistry,
    });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('executes tool calls and runs a follow-up generation', async () => {
    // Create character
    await h.send(client, {
      type: 'character.create',
      data: { name: 'TestBot', description: 'A test bot.', firstMes: 'Hello there!' },
    });

    const created = h.expectBroadcast('character.created');
    const charId = created.character.id;

    // Configure settings
    await h.deps.settings.setValue('model', 'trivial-model');
    await h.deps.settings.setValue('apiKey', 'fake-key');
    await h.deps.settings.setValue('backendProvider', 'openai');
    await h.deps.settings.setValue('maxResponseTokens', 100);
    // Create a toolset for the weather template
    await h.send(client, {
      type: 'toolset.create',
      data: { templateId: 'weather', name: 'Weather Toolset', config: {}, toolOverrides: {}, enabled: true },
    });
    h.expectBroadcast('toolset.created');

    // Create chat
    await h.send(client, {
      type: 'chat.create',
      data: { characterId: charId, name: 'Test Chat' },
    });

    const chatCreated = h.expectBroadcast('chat.created');
    const chatId = chatCreated.chat.id;

    // Materialize greetings
    await h.send(client, {
      type: 'chat.materialize',
      chatId,
    });
    h.expectBroadcast('chat.snapshot');

    // Send user message
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'What is the weather in Paris?',
    });
    h.expectBroadcast('chat.snapshot');

    // Trigger generation
    await h.send(client, {
      type: 'action.generate',
      chatId,
    });

    // Collect generation lifecycle broadcasts
    const allStarted = client.messages.filter((m: any) => m.type === 'generation.started') as Array<{ type: 'generation.started'; generationId: string; chatId: string; messageId: number }>;
    const allDone = client.messages.filter((m: any) => m.type === 'generation.done') as Array<{ type: 'generation.done'; generationId: string; finishReason: string }>;
    const allPatched = client.messages.filter((m: any) => m.type === 'message.snapshot') as Array<{ type: 'message.snapshot'; chatId: string; message: any }>;

    expect(allStarted).toHaveLength(2);
    expect(allDone).toHaveLength(1);
    // The streaming flusher may emit extra snapshots while/after rendering, so
    // we locate the canonical lifecycle snapshots by their part counts rather
    // than assuming fixed indices.
    expect(allPatched.length).toBeGreaterThanOrEqual(3);

    const targetMsgId = allStarted[0]!.messageId;
    expect(allStarted[0]!.chatId).toBe(chatId);
    expect(allStarted[1]!.chatId).toBe(chatId);
    expect(allStarted[1]!.messageId).toBe(targetMsgId);

    // Single generation.done after entire tool-calling sequence finishes
    expect(allDone[0]!.finishReason).toBe('stop');

    const targetSnapshots = allPatched.filter((p) => p.message.id === targetMsgId);

    // First canonical snapshot: after first runGeneration, tool_use only
    const toolUseSnapshot = targetSnapshots.find((p) => p.message.extra!.parts.length === 1);
    expect(toolUseSnapshot).toBeDefined();
    expect(toolUseSnapshot!.message.extra!.parts).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
    ]);

    // Second canonical snapshot: after tool execution in while-loop, tool_use + tool_result
    const toolResultSnapshot = targetSnapshots.find((p) => p.message.extra!.parts.length === 2);
    expect(toolResultSnapshot).toBeDefined();
    const toolParts = toolResultSnapshot!.message.extra!.parts as Array<Record<string, unknown>>;
    expect(toolParts).toHaveLength(2);
    expect(toolParts[0]).toEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } });
    expect(toolParts[1]!.type).toBe('tool_result');
    expect(toolParts[1]!.toolUseId).toBe('call_1');
    expect(toolParts[1]!.name).toBe('get_weather');
    expect(toolParts[1]!.content).toBe('Weather for Paris: sunny, 25°C');
    expect(toolParts[1]!.isError).toBeFalsy();

    // Final canonical snapshot: after follow-up generation, tool_use + tool_result + text
    const finalSnapshots = targetSnapshots.filter((p) => p.message.extra!.parts.length === 3);
    expect(finalSnapshots.length).toBeGreaterThanOrEqual(1);
    const finalSnapshot = finalSnapshots[finalSnapshots.length - 1]!;
    expect(finalSnapshot.message.id).toBe(targetMsgId);
    expect(getMessageText(finalSnapshot.message.extra!.parts)).toBe('The weather in Paris is sunny.');
    const finalParts = finalSnapshot.message.extra!.parts as Array<Record<string, unknown>>;
    expect(finalParts).toHaveLength(3);
    expect(finalParts[0]!.type).toBe('tool_use');
    expect(finalParts[1]!.type).toBe('tool_result');
    expect(finalParts[2]!.type).toBe('text');
    expect(finalParts[2]!.text).toBe('The weather in Paris is sunny.');

    // Content tokens from follow-up
    const contentTokens = client.messages.filter((m: any) => m.type === 'generation.token');
    expect(contentTokens.length).toBeGreaterThan(0);
    expect(contentTokens.map((m: any) => m.token).join('')).toBe('The weather in Paris is sunny.');

    // Verify final message state in DB
    const finalMsg = await h.deps.chats.getMessageById(targetMsgId);
    expect(finalMsg).toBeDefined();
    expect(getMessageText(finalMsg!.extra.parts)).toBe('The weather in Paris is sunny.');
    const dbParts = finalMsg!.extra.parts ?? [];
    expect(dbParts).toHaveLength(3);
    expect(dbParts.map((p) => p.type)).toEqual(['tool_use', 'tool_result', 'text']);
    const lastDbPart = dbParts[2]!;
    if (lastDbPart.type !== 'text') throw new Error('expected text part');
    expect(lastDbPart.text).toBe('The weather in Paris is sunny.');
  });
});

describe('endsTurn tool through bus mock', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    // Round 1 calls the turn-ending tool; round 2 exists to prove the
    // follow-up is never requested when the tool ends the turn.
    const backend = new TrivialBackendAdapter([
      [{ type: 'tool_use', id: 'call_1', name: 'present_choices', input: { options: ['A', 'B'] } }],
      [{ type: 'content', content: 'This follow-up must never run.' }],
    ]);

    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTemplate({
      id: 'choices',
      name: 'Choices',
      source: 'builtin',
      getDefinition: () => ({
        stateKey: 'choices',
        configSchema: {},
        tools: [
          {
            name: 'present_choices',
            description: 'Present choices, then end the turn.',
            endsTurn: true,
            parameters: {
              type: 'object',
              properties: { options: { type: 'array', items: { type: 'string' } } },
              required: ['options'],
            },
          },
        ],
      }),
      execute: (_toolName, args) =>
        Promise.resolve({ content: `Presented choices: ${(args as { options: string[] }).options.join(', ')}` }),
      serialize: () => '',
      deserialize: () => {},
    });

    h = new TestHarness({
      backendFactory: {
        create: async () => backend,
      },
      toolRegistry,
    });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('ends the turn after the tool executes — no follow-up generation', async () => {
    await h.send(client, {
      type: 'character.create',
      data: { name: 'TestBot', description: 'A test bot.', firstMes: 'Hello there!' },
    });
    const charId = h.expectBroadcast('character.created').character.id;

    await h.deps.settings.setValue('model', 'trivial-model');
    await h.deps.settings.setValue('apiKey', 'fake-key');
    await h.deps.settings.setValue('backendProvider', 'openai');
    await h.deps.settings.setValue('maxResponseTokens', 100);

    await h.send(client, {
      type: 'toolset.create',
      data: { templateId: 'choices', name: 'Choices Toolset', config: {}, toolOverrides: {}, enabled: true },
    });
    h.expectBroadcast('toolset.created');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: charId, name: 'Test Chat' },
    });
    const chatId = h.expectBroadcast('chat.created').chat.id;

    await h.send(client, { type: 'chat.materialize', chatId });
    h.expectBroadcast('chat.snapshot');

    await h.send(client, { type: 'action.send', chatId, content: 'Give me a decision point.' });
    h.expectBroadcast('chat.snapshot');

    await h.send(client, { type: 'action.generate', chatId });

    // Exactly one backend generation: the tool round ended the turn, so the
    // follow-up round (and its generation record) never happened. The control
    // case — a normal tool still triggering a second generation.started — is
    // covered by 'executes tool calls and runs a follow-up generation' above.
    const allStarted = client.messages.filter((m: any) => m.type === 'generation.started') as Array<{ generationId: string; messageId: number }>;
    const allDone = client.messages.filter((m: any) => m.type === 'generation.done');
    expect(allStarted).toHaveLength(1);
    expect(allDone).toHaveLength(1);

    // No visible text was streamed — only the tool-call round ran.
    const contentTokens = client.messages.filter((m: any) => m.type === 'generation.token');
    expect(contentTokens).toHaveLength(0);

    // The generation record completed normally (not pending/error).
    const generationId = allStarted[0]!.generationId;
    const rows = await h.db.execute({ sql: 'SELECT status FROM generations WHERE id = ?', args: [generationId] });
    expect(rows.rows[0]?.['status']).toBe('complete');

    // The tool_result part is persisted on the assistant message.
    const targetMsgId = allStarted[0]!.messageId;
    const finalMsg = await h.deps.chats.getMessageById(targetMsgId);
    expect(finalMsg).toBeDefined();
    const dbParts = finalMsg!.extra.parts ?? [];
    expect(dbParts).toHaveLength(2);
    expect(dbParts[0]).toEqual({ type: 'tool_use', id: 'call_1', name: 'present_choices', input: { options: ['A', 'B'] } });
    const resultPart = dbParts[1]!;
    if (resultPart.type !== 'tool_result') throw new Error('expected tool_result part');
    expect(resultPart.toolUseId).toBe('call_1');
    expect(resultPart.name).toBe('present_choices');
    expect(resultPart.content).toBe('Presented choices: A, B');
    expect(resultPart.isError).toBeFalsy();
  });
});
