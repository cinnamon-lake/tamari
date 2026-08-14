/**
 * Runner-level backend-resolution failures: an unknown provider id must
 * surface as the directed NO_BACKEND error (the registry's loud throw is
 * caught in resolveBackend), not crash the run. Plus trace-error nodes on
 * the runner's own error paths (docs/design/debug-traces.md).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { createBackendAdapter, buildAdapterFactoryInput } from '../backends/factory.js';
import { TranscriptTarget } from './TranscriptTarget.js';
import type { BackendAdapter, BackendStreamItem, GenerationResult } from '../backends/BackendAdapter.js';
import { TrivialBackendAdapter } from '../backends/TrivialBackendAdapter.js';
import { ToolRegistry } from '../services/ToolRegistry.js';
import { GenerationRepository } from '../repos/GenerationRepository.js';
import { AssistantMessageTarget } from './AssistantMessageTarget.js';

describe('GenerationRunner backend resolution', () => {
  let h: TestHarness | undefined;

  afterEach(async () => {
    await h?.teardown();
    h = undefined;
  });

  it('unknown provider id produces a directed NO_BACKEND error, not a crash', async () => {
    // Wire the REAL provider factory (the harness default returns null).
    h = new TestHarness({
      backendFactory: { create: async (s) => createBackendAdapter(buildAdapterFactoryInput(s)) },
    });
    await h.initSchema();
    const client = h.connectClient();

    await h.deps.settings.setValue('backendProvider', 'definitely-not-a-provider');
    await h.deps.settings.setValue('apiKey', 'fake-key');
    await h.deps.settings.setValue('model', 'some-model');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Bot', description: 'd', firstMes: 'hi' },
    });
    const charId = h.expectBroadcast('character.created').character.id;
    await h.send(client, { type: 'chat.create', data: { characterId: charId, name: 'Chat' } });
    const chatId = h.expectBroadcast('chat.created').chat.id;
    await h.send(client, { type: 'chat.materialize', chatId });

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'hello' });

    // The run must not hang or throw: the directed NO_BACKEND error is the
    // terminal signal (no generation record, no generation.done — the same
    // terminal shape as the legacy no-backend path).
    const error = client.messages.find((m) => m.type === 'error');
    expect(error).toBeDefined();
    expect(error!.type === 'error' && error!.code).toBe('NO_BACKEND');
    expect(client.messages.filter((m) => m.type === 'generation.done')).toHaveLength(0);
  });
});

describe('GenerationRunner trace errors', () => {
  let h: TestHarness | undefined;

  afterEach(async () => {
    await h?.teardown();
    h = undefined;
  });

  function transcriptTarget(chatId: string): TranscriptTarget {
    return new TranscriptTarget(
      { chats: h!.deps.chats, generationBroadcast: h!.generationBroadcast, assembly: h!.chatPromptAssembly },
      { chatId, character: null, kind: 'genraw', seed: 'hi', assembly: 'seed' },
    );
  }

  it('NO_BACKEND outcome carries a NO_BACKEND trace node', async () => {
    h = new TestHarness(); // default factory resolves no backend
    await h.initSchema();
    const client = h.connectClient();
    await h.send(client, { type: 'chat.create', data: { characterId: null, name: 'T' } });
    const chatId = h.expectBroadcast('chat.created').chat.id;

    const outcome = await h.generationRunner.run(transcriptTarget(chatId));
    expect(outcome.error).toBe('NO_BACKEND');
    expect(outcome.traceError).toEqual({
      code: 'NO_BACKEND',
      layer: 'runner',
      message: 'No backend configured. Set API key and model in settings.',
    });
  });

  it('a backend stream exception carries an UNKNOWN node at the backend layer', async () => {
    const failing: BackendAdapter = {
      id: 'failing',
      supportsStreaming: true,
      supportsTools: false,
      // Error-only stub: no chunks to yield.
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<BackendStreamItem, GenerationResult> {
        throw new Error('Stream exploded');
      },
      listModels: async () => [],
    };
    h = new TestHarness({ backendFactory: { create: async () => failing } });
    await h.initSchema();
    const client = h.connectClient();
    await h.send(client, { type: 'chat.create', data: { characterId: null, name: 'T' } });
    const chatId = h.expectBroadcast('chat.created').chat.id;

    const outcome = await h.generationRunner.run(transcriptTarget(chatId));
    expect(outcome.traceError).toEqual({ code: 'UNKNOWN', layer: 'failing', message: 'Stream exploded' });
  });

  it('handleStop mid-stream carries an ABORTED node', async () => {
    const hanging: BackendAdapter = {
      id: 'hanging',
      supportsStreaming: true,
      supportsTools: false,
      // Hangs until aborted; only the abort path runs.
      // eslint-disable-next-line require-yield
      async *stream(_prompt: unknown, signal: AbortSignal): AsyncGenerator<BackendStreamItem, GenerationResult> {
        while (!signal.aborted) {
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error('Aborted');
      },
      listModels: async () => [],
    };
    h = new TestHarness({ backendFactory: { create: async () => hanging } });
    await h.initSchema();
    const client = h.connectClient();
    await h.send(client, { type: 'chat.create', data: { characterId: null, name: 'T' } });
    const chatId = h.expectBroadcast('chat.created').chat.id;

    const runPromise = h.generationRunner.run(transcriptTarget(chatId));
    // Wait for the run to be streaming, then stop it.
    await expect
      .poll(() => h!.generationRunner.getActiveGeneration()?.id, { timeout: 5000 })
      .not.toBeUndefined();
    const active = h.generationRunner.getActiveGeneration()!;
    h.generationRunner.handleStop(active.id);

    const outcome = await runPromise;
    expect(outcome.traceError?.code).toBe('ABORTED');
    expect(outcome.traceError?.layer).toBe('hanging');
  });
});

describe('GenerationRunner backend resolution', () => {
  let h: TestHarness | undefined;

  afterEach(async () => {
    await h?.teardown();
    h = undefined;
  });

  it('unknown provider id produces a directed NO_BACKEND error, not a crash', async () => {
    // Wire the REAL provider factory (the harness default returns null).
    h = new TestHarness({
      backendFactory: { create: async (s) => createBackendAdapter(buildAdapterFactoryInput(s)) },
    });
    await h.initSchema();
    const client = h.connectClient();

    await h.deps.settings.setValue('backendProvider', 'definitely-not-a-provider');
    await h.deps.settings.setValue('apiKey', 'fake-key');
    await h.deps.settings.setValue('model', 'some-model');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Bot', description: 'd', firstMes: 'hi' },
    });
    const charId = h.expectBroadcast('character.created').character.id;
    await h.send(client, { type: 'chat.create', data: { characterId: charId, name: 'Chat' } });
    const chatId = h.expectBroadcast('chat.created').chat.id;
    await h.send(client, { type: 'chat.materialize', chatId });

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'hello' });

    // The run must not hang or throw: the directed NO_BACKEND error is the
    // terminal signal (no generation record, no generation.done — the same
    // terminal shape as the legacy no-backend path).
    const error = client.messages.find((m) => m.type === 'error');
    expect(error).toBeDefined();
    expect(error!.type === 'error' && error!.code).toBe('NO_BACKEND');
    expect(client.messages.filter((m) => m.type === 'generation.done')).toHaveLength(0);
  });
});

describe('generation meta (debug traces)', () => {
  let h: TestHarness | undefined;
  let client: ReturnType<TestHarness['connectClient']>;

  afterEach(async () => {
    await h?.teardown();
    h = undefined;
  });

  function echoTool(toolRegistry: ToolRegistry): void {
    toolRegistry.registerTemplate({
      id: 'echo',
      name: 'Echo',
      source: 'builtin',
      getDefinition: () => ({
        stateKey: 'echo',
        configSchema: {},
        tools: [
          {
            name: 'echo_marker',
            description: 'Echo a value back.',
            parameters: { type: 'object', properties: { value: { type: 'string' } } },
          },
        ],
      }),
      execute: (_toolName, args) => Promise.resolve({ content: `ECHO:${(args as { value: string }).value}` }),
      serialize: () => '',
      deserialize: () => {},
    });
  }

  async function setupChat(backend: TrivialBackendAdapter | BackendAdapter, toolRegistry?: ToolRegistry) {
    h = new TestHarness({ backendFactory: { create: async () => backend }, toolRegistry });
    await h.initSchema();
    client = h.connectClient();
    await h.deps.settings.setValue('model', 'trivial-model');
    await h.deps.settings.setValue('apiKey', 'fake-key');
    await h.deps.settings.setValue('backendProvider', 'openai');
    await h.deps.settings.setValue('maxResponseTokens', 100);

    await h.send(client, {
      type: 'character.create',
      data: { name: 'MetaBot', description: 'd', firstMes: 'hi' },
    });
    const charId = h.expectBroadcast('character.created').character.id;
    await h.send(client, { type: 'chat.create', data: { characterId: charId, name: 'Meta Chat' } });
    const chatId = h.expectBroadcast('chat.created').chat.id;
    await h.send(client, { type: 'chat.materialize', chatId });
    return chatId;
  }

  async function latestRecord(chatId: string) {
    const records = await new GenerationRepository(h!.db).listByChat(chatId);
    return records.sort((a, b) => b.createdAt - a.createdAt)[0]!;
  }

  it('a successful run writes layer/depth/rounds, no traceError, no prompt by default', async () => {
    const chatId = await setupChat(new TrivialBackendAdapter([[{ type: 'content', content: 'ok' }]]));
    await h!.send(client, { type: 'action.sendAndGenerate', chatId, content: 'go' });
    h!.expectBroadcast('generation.done');

    const record = await latestRecord(chatId);
    expect(record.status).toBe('complete');
    expect(record.meta).toMatchObject({ layer: 'trivial', depth: 0, rounds: 1 });
    expect(record.meta?.traceError).toBeUndefined();
    expect(record.meta?.prompt).toBeUndefined();
    expect(record.meta?.prompts).toBeUndefined();
  });

  it('tool rounds accumulate rounds and toolCalls into meta', async () => {
    const toolRegistry = new ToolRegistry();
    echoTool(toolRegistry);
    const chatId = await setupChat(
      new TrivialBackendAdapter([
        [{ type: 'tool_use', id: 'c1', name: 'echo_marker', input: { value: 'x' } }],
        [{ type: 'content', content: 'done' }],
      ]),
      toolRegistry,
    );
    await h!.send(client, {
      type: 'toolset.create',
      data: { templateId: 'echo', name: 'Echo', config: {}, toolOverrides: {}, enabled: true },
    });
    h!.expectBroadcast('toolset.created');

    await h!.send(client, { type: 'action.sendAndGenerate', chatId, content: 'go' });
    h!.expectBroadcast('generation.done');

    const record = await latestRecord(chatId);
    expect(record.meta).toMatchObject({
      layer: 'trivial',
      depth: 0,
      rounds: 2,
      toolCalls: [{ name: 'echo_marker' }],
    });
    expect(record.meta?.toolCalls?.[0]?.isError).toBeFalsy();
  });

  it('debugPrompts on captures the round-1 prompt in meta', async () => {
    const chatId = await setupChat(new TrivialBackendAdapter([[{ type: 'content', content: 'ok' }]]));
    await h!.deps.settings.setValue('debugPrompts', true);

    await h!.send(client, { type: 'action.sendAndGenerate', chatId, content: 'go UNIQUE_MARKER' });
    h!.expectBroadcast('generation.done');

    const record = await latestRecord(chatId);
    expect(record.meta?.prompt).toBeDefined();
    expect(JSON.stringify(record.meta?.prompt?.messages)).toContain('UNIQUE_MARKER');
  });

  it('debugPrompts on captures every round prompt in meta.prompts', async () => {
    const toolRegistry = new ToolRegistry();
    echoTool(toolRegistry);
    const chatId = await setupChat(
      new TrivialBackendAdapter([
        [{ type: 'tool_use', id: 'c1', name: 'echo_marker', input: { value: 'x' } }],
        [{ type: 'content', content: 'done' }],
      ]),
      toolRegistry,
    );
    await h!.send(client, {
      type: 'toolset.create',
      data: { templateId: 'echo', name: 'Echo', config: {}, toolOverrides: {}, enabled: true },
    });
    h!.expectBroadcast('toolset.created');
    await h!.deps.settings.setValue('debugPrompts', true);

    await h!.send(client, { type: 'action.sendAndGenerate', chatId, content: 'go UNIQUE_MARKER' });
    h!.expectBroadcast('generation.done');

    const record = await latestRecord(chatId);
    expect(record.meta?.rounds).toBe(2);
    expect(record.meta?.prompts).toHaveLength(2);
    // prompts[0] is the round-1 prompt — the same object the back-compat
    // prompt field carries.
    expect(record.meta?.prompts?.[0]).toEqual(record.meta?.prompt);
    expect(JSON.stringify(record.meta?.prompts?.[0]?.messages)).toContain('UNIQUE_MARKER');
    // The round-2 prompt carries round 1's tool result.
    expect(JSON.stringify(record.meta?.prompts?.[1]?.messages)).toContain('ECHO:x');
  });

  it('target.capturePrompts captures prompts with the global debugPrompts setting off', async () => {
    const chatId = await setupChat(new TrivialBackendAdapter([[{ type: 'content', content: 'ok' }]]));
    const chat = await h!.deps.chats.getChatById(chatId);
    const character = chat?.characterId ? await h!.deps.characters.getById(chat.characterId) : null;

    const target = AssistantMessageTarget.forNewMessage(
      { chatId, character: character ?? null, capturePrompts: true },
      {
        chats: h!.deps.chats,
        characters: h!.deps.characters,
        chatMembers: h!.deps.chatMembers,
        personas: h!.deps.personas,
        settings: h!.deps.settings,
        backendConfigs: h!.deps.backendConfigs,
        chatBroadcast: h!.deps.chatBroadcast,
        generationBroadcast: h!.generationBroadcast,
        assembly: h!.chatPromptAssembly,
      },
    );
    const outcome = await h!.generationRunner.run(target);
    expect(outcome.error).toBeUndefined();

    const record = await latestRecord(chatId);
    expect(record.meta?.prompt).toBeDefined();
    expect(record.meta?.prompts).toHaveLength(1);
  });

  it('a failed run writes the traceError into meta', async () => {
    const failing: BackendAdapter = {
      id: 'failing',
      supportsStreaming: true,
      supportsTools: false,
      // Error-only stub: no chunks to yield.
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<BackendStreamItem, GenerationResult> {
        throw new Error('Stream exploded');
      },
      listModels: async () => [],
    };
    const chatId = await setupChat(failing);
    await h!.send(client, { type: 'action.sendAndGenerate', chatId, content: 'go' });
    h!.expectBroadcast('generation.done');

    const record = await latestRecord(chatId);
    expect(record.status).toBe('error');
    expect(record.meta?.traceError).toEqual({ code: 'UNKNOWN', layer: 'failing', message: 'Stream exploded' });
    expect(record.meta?.rounds).toBe(0);
  });
});
