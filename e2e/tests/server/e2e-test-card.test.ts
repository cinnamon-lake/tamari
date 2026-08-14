/**
 * e2e: test_card rebuilt on TestSessionService.
 *
 * Runs scripted turns through the real generation path against in-memory
 * repositories — asserting transcript parity, keep-by-default session
 * semantics (sessionId returned, continuable via the session service),
 * keepChat:false teardown, mid-run backend failure, turn-timeout abort, arg
 * validation, the WorkbenchTemplate run-verb wiring, and the headline
 * deterministic scenario: a scripted card (backend_logic.lua delegating to
 * a mock backend) + mock `tool:`/`respond:` directives driving the full
 * tool loop with both rounds' prompts captured.
 *
 * Invariant throughout: no real chat rows and no generation records ever
 * land in the DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ClientMessage } from '@tamari/types';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import type { BackendAdapter, BackendStreamItem, GenerationResult, ModelInfo, Prompt } from '../../../server/src/backends/BackendAdapter.js';
import { createBackendAdapter, buildAdapterFactoryInput } from '../../../server/src/backends/factory.js';
import { ScriptBlobRepository } from '../../../server/src/repos/ScriptBlobRepository.js';
import { PromptBuilder } from '../../../server/src/pipeline/PromptBuilder.js';
import { WorldInfoInjector } from '../../../server/src/pipeline/WorldInfoInjector.js';
import { ToolRegistry } from '../../../server/src/services/ToolRegistry.js';
import { UnpackedCardService } from '../../../server/src/services/unpacked/UnpackedCardService.js';
import { TestSessionService } from '../../../server/src/services/TestSessionService.js';
import { CardTestService } from '../../../server/src/services/CardTestService.js';
import { WorkbenchTemplate } from '../../../server/src/services/templates/workbench/WorkbenchTemplate.js';
import type { WorkbenchProviders } from '../../../server/src/services/templates/workbench/router.js';

/** Backend that succeeds until the Nth call, which returns an error result. */
class FailOnCallBackendAdapter implements BackendAdapter {
  readonly id = 'trivial';
  readonly supportsStreaming = true;
  readonly supportsTools = false;
  private calls = 0;

  constructor(
    private failOnCall: number,
    private errorText: string,
  ) {}

  async *stream(prompt: Prompt, _signal: AbortSignal): AsyncGenerator<BackendStreamItem, GenerationResult> {
    this.calls++;
    const usage = { promptTokens: prompt.tokenUsage.prompt, completionTokens: 0 };
    if (this.calls === this.failOnCall) {
      return { finishReason: 'error', usage, error: this.errorText };
    }
    const text = `Reply ${this.calls}.`;
    yield { type: 'text', token: text };
    return { finishReason: 'stop', usage: { ...usage, completionTokens: text.length } };
  }

  async listModels(_signal?: AbortSignal): Promise<ModelInfo[]> {
    return [{ id: 'trivial-model', name: 'Trivial Model' }];
  }
}

/** Backend that never produces tokens — only an abort unsticks it. */
class StuckBackendAdapter implements BackendAdapter {
  readonly id = 'trivial';
  readonly supportsStreaming = true;
  readonly supportsTools = false;

  async *stream(prompt: Prompt, signal: AbortSignal): AsyncGenerator<BackendStreamItem, GenerationResult> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return {
      finishReason: 'error',
      usage: { promptTokens: prompt.tokenUsage.prompt, completionTokens: 0 },
      error: 'Aborted',
    };
  }

  async listModels(_signal?: AbortSignal): Promise<ModelInfo[]> {
    return [{ id: 'trivial-model', name: 'Trivial Model' }];
  }
}

/** Scripted card: delegates to the wrapped backend, surfacing its tool calls
    into the runner's tool loop and print()ing the final text. */
const DELEGATING_LUA = `
function generate(prompt, ctx)
  if type(state) ~= "table" then state = { calls = 0 } end
  state.calls = state.calls + 1
  local res = backends.generate(prompt):await()
  if res.error then error(res.error) end
  if res.toolCalls and #res.toolCalls > 0 then
    return { toolCalls = res.toolCalls }
  end
  print("delegate answered: " .. res.text)
  return res.text
end
`;

describe('e2e test_card (session-based)', () => {
  let h: TestHarness;
  let cardTest: CardTestService;
  let testSessions: TestSessionService;
  let client: ReturnType<TestHarness['connectClient']>;
  /** Read by the harness backendFactory at generation time — tests may swap it. */
  let backend: BackendAdapter;

  beforeEach(async () => {
    backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'Reply one.' }],
      [{ type: 'content', content: 'Reply two.' }],
    ]);
    let unpackedCards!: UnpackedCardService;
    h = new TestHarness({
      // Mock-provider configs resolve through the real factory (deterministic
      // canned responses); anything else falls back to the swappable backend.
      backendFactory: {
        create: async (s) =>
          s['backendProvider'] === 'mock' ? createBackendAdapter(buildAdapterFactoryInput(s)) : backend,
      },
      wrapRepos: (ctx) => {
        // TestSessionService needs an UnpackedCardService for folderPath
        // resolution; unused for DB cards, so it is never started here.
        unpackedCards = new UnpackedCardService({
          characters: ctx.characters,
          characterAssets: ctx.characterAssets,
          quickReplies: ctx.quickReplies,
          storage: ctx.storage,
          bus: ctx.bus,
          settings: ctx.settings,
          dataDir: ctx.dataDir,
          watch: false,
        });
        return {};
      },
    });
    await h.initSchema();
    testSessions = new TestSessionService({
      settings: h.deps.settings,
      backendConfigs: h.deps.backendConfigs,
      promptLists: h.deps.promptLists,
      backendFactory: {
        create: async (s) =>
          s['backendProvider'] === 'mock' ? createBackendAdapter(buildAdapterFactoryInput(s)) : backend,
      },
      customBackends: h.deps.customBackends,
      scriptBlobs: new ScriptBlobRepository(h.db),
      luaRuntime: h.deps.luaRuntime,
      characters: h.deps.characters,
      personas: h.deps.personas,
      chatMembers: h.deps.chatMembers,
      unpackedCards,
      attachments: h.deps.attachments,
      storage: h.deps.storage,
      promptBuilder: new PromptBuilder(new WorldInfoInjector()),
      worldInfo: h.deps.worldInfo,
      characterAssets: h.deps.characterAssets,
    });
    cardTest = new CardTestService({ testSessions });
    client = h.connectClient();

    await h.send(client, {
      type: 'persona.create',
      data: { name: 'Tester', description: 'A human user.' },
    } as ClientMessage);
    h.expectBroadcast('persona.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Test Config',
        description: '',
        backendProvider: 'openai',
        generationMode: 'chat',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
        instructTemplate: '',
        providerParams: {},
      },
    } as ClientMessage);
    const preset = h.expectBroadcast('backendConfig.created');
    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: preset.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Testsubject', description: 'A test subject.' },
    } as ClientMessage);
    h.expectBroadcast('character.created');
  });

  afterEach(async () => {
    await h.teardown();
  });

  function characterId(): string {
    return h.expectBroadcast('character.created').character.id;
  }

  /** Create a mock-provider backend config and return its id. */
  async function createMockConfig(script: string): Promise<string> {
    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Mock',
        description: '',
        backendProvider: 'mock',
        generationMode: 'chat',
        model: 'mock-model',
        apiKey: '',
        contextLength: 4096,
        maxTokens: 100,
        instructTemplate: '',
        providerParams: { mockScript: script },
      },
    } as ClientMessage);
    return h.expectBroadcast('backendConfig.created').backendConfig.id;
  }

  async function expectDbEmpty() {
    expect((await h.deps.chats.listChats({ limit: 100 })).items).toHaveLength(0);
    const rs = await h.db.execute('SELECT COUNT(*) AS n FROM generations');
    expect(Number(rs.rows[0]?.n ?? 0)).toBe(0);
  }

  it('runs a scripted chat and keeps the session by default — no DB rows at all', async () => {
    const result = await cardTest.run({ characterId: characterId(), turns: ['Hello', 'Again'] });
    expect(typeof result.content).toBe('string');
    const parsed = JSON.parse(result.content as string);

    expect(parsed.characterName).toBe('Testsubject');
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]).toMatchObject({ input: 'Hello', reply: 'Reply one.', finishReason: expect.any(String) });
    expect(parsed.turns[1]).toMatchObject({ input: 'Again', reply: 'Reply two.' });
    expect(parsed.generationIds).toHaveLength(2);
    expect(parsed.turns[0].generationId).toBe(parsed.generationIds[0]);

    // Default: the session is kept and continuable via the session service.
    expect(typeof parsed.sessionId).toBe('string');
    const state = (await testSessions.state({ sessionId: parsed.sessionId })) as {
      messages: { role: string; text: string }[];
      generations: { id: string }[];
    };
    expect(state.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(state.generations.map((g) => g.id).sort()).toEqual([...parsed.generationIds].sort());

    // The captured prompts are inspectable per generation.
    const full = (await testSessions.state({ sessionId: parsed.sessionId, generationId: parsed.generationIds[0] })) as {
      generation: { meta: { prompts?: unknown[] } };
    };
    expect(full.generation.meta.prompts).toHaveLength(1);

    // The whole point of the rebuild: no real chat, no DB generation records.
    await expectDbEmpty();
  });

  it('ends the session immediately when keepChat is false', async () => {
    const result = await cardTest.run({ characterId: characterId(), turns: ['Hello'], keepChat: false });
    const parsed = JSON.parse(result.content as string);
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.turns[0].reply).toBe('Reply one.');
    await expectDbEmpty();
  });

  it('aborts the run when the backend fails mid-run', async () => {
    backend = new FailOnCallBackendAdapter(2, 'boom: backend exploded');
    const result = await cardTest.run({ characterId: characterId(), turns: ['one', 'two', 'three'] });
    expect(result.content).toMatch(/^Error: generation failed \([^)]+\): boom: backend exploded/);
    await expectDbEmpty();
  });

  it('aborts the in-flight generation when a turn times out', async () => {
    backend = new StuckBackendAdapter();
    const result = await cardTest.run({ characterId: characterId(), turns: ['hi'], timeoutMs: 1000 });
    expect(result.content).toMatch(/^Error: generation timed out after 1000ms/);
    await expectDbEmpty();
  });

  it('rejects invalid args and unknown cards with Error content', async () => {
    const noCard = await cardTest.run({ turns: ['hi'] });
    expect(noCard.content).toMatch(/^Error: invalid arguments/);

    const missing = await cardTest.run({ characterId: 'nope', turns: ['hi'] });
    expect(missing.content).toMatch(/^Error: character not found: nope/);
  });

  it('is wired into the workbench run verbs', async () => {
    const fakeProvider = { execute: async () => ({ content: '{}' }) };
    const providers = {
      characterWorkbench: fakeProvider,
      backendWorkbench: fakeProvider,
      toolsetWorkbench: fakeProvider,
      quickReplyWorkbench: fakeProvider,
      luaToolWorkbench: fakeProvider,
      cardTest,
    } as unknown as WorkbenchProviders;
    const template = new WorkbenchTemplate(providers);

    const menu = await template.execute('run', {});
    expect(menu.content).toContain('test_card');

    const result = await template.execute('run', { verb: 'test_card', args: { characterId: characterId(), turns: ['Hello'] } });
    const parsed = JSON.parse(result.content as string);
    expect(parsed.turns[0].reply).toBe('Reply one.');
  });

  it('drives the full tool loop for a scripted card against mock tool:/respond: directives', async () => {
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
            description: 'Get the current weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      }),
      execute: (_toolName, args) => Promise.resolve({ content: `Weather for ${(args as { city: string }).city}: sunny, 25°C` }),
      serialize: () => '',
      deserialize: () => {},
    });
    // Rebuild the harness + services with the tool registry wired in.
    let unpackedCards!: UnpackedCardService;
    await h.teardown();
    h = new TestHarness({
      toolRegistry,
      backendFactory: {
        create: async (s) =>
          s['backendProvider'] === 'mock' ? createBackendAdapter(buildAdapterFactoryInput(s)) : backend,
      },
      wrapRepos: (ctx) => {
        unpackedCards = new UnpackedCardService({
          characters: ctx.characters,
          characterAssets: ctx.characterAssets,
          quickReplies: ctx.quickReplies,
          storage: ctx.storage,
          bus: ctx.bus,
          settings: ctx.settings,
          dataDir: ctx.dataDir,
          watch: false,
        });
        return {};
      },
    });
    await h.initSchema();
    testSessions = new TestSessionService({
      settings: h.deps.settings,
      backendConfigs: h.deps.backendConfigs,
      promptLists: h.deps.promptLists,
      backendFactory: {
        create: async (s) =>
          s['backendProvider'] === 'mock' ? createBackendAdapter(buildAdapterFactoryInput(s)) : backend,
      },
      customBackends: h.deps.customBackends,
      scriptBlobs: new ScriptBlobRepository(h.db),
      luaRuntime: h.deps.luaRuntime,
      characters: h.deps.characters,
      personas: h.deps.personas,
      chatMembers: h.deps.chatMembers,
      unpackedCards,
      attachments: h.deps.attachments,
      storage: h.deps.storage,
      promptBuilder: new PromptBuilder(new WorldInfoInjector()),
      worldInfo: h.deps.worldInfo,
      characterAssets: h.deps.characterAssets,
      toolRegistry,
      toolsetRepo: h.deps.toolsets,
    });
    cardTest = new CardTestService({ testSessions });
    client = h.connectClient();

    await h.send(client, {
      type: 'toolset.create',
      data: { templateId: 'weather', name: 'Weather Toolset', config: {}, toolOverrides: {}, enabled: true },
    } as ClientMessage);
    h.expectBroadcast('toolset.created');

    // The scripted card: backend_logic.lua delegating to the mock backend.
    const character = await h.deps.characters.create('char-scripted', {
      name: 'Scripted Weather',
      description: 'A scripted card.',
      firstMes: 'Ask me about the weather.',
      extensions: { contextualBackend: { enabled: true, luaSource: DELEGATING_LUA } },
    });

    const mockConfigId = await createMockConfig('tool:get_weather:{"city":"Paris"}\nrespond:It is sunny in Paris.');
    const result = await cardTest.run({ characterId: character.id, backendConfigId: mockConfigId, turns: ['weather in Paris?'] });
    const parsed = JSON.parse(result.content as string);

    // Round 1: the mock emits the tool call; round 2: the canned answer.
    expect(parsed.turns[0].reply).toBe('It is sunny in Paris.');
    expect(parsed.generationIds).toHaveLength(1);

    const full = (await testSessions.state({ sessionId: parsed.sessionId, generationId: parsed.generationIds[0] })) as {
      generation: { meta: { layer?: string; rounds?: number; toolCalls?: { name: string }[]; prompts?: unknown[] } };
    };
    expect(full.generation.meta.rounds).toBe(2);
    expect(full.generation.meta.toolCalls?.map((t) => t.name)).toEqual(['get_weather']);
    // Both rounds' prompts captured; round 2 carries the tool result.
    expect(full.generation.meta.prompts).toHaveLength(2);
    expect(JSON.stringify(full.generation.meta.prompts?.[1])).toContain('sunny, 25°C');

    // The card's Lua state and print() output are inspectable. Within one
    // generation each round restores the last PERSISTED snapshot (only the
    // final round's state lands on the message), so `calls` ticks once per
    // turn here, not once per round.
    const state = (await testSessions.state({ sessionId: parsed.sessionId })) as { scriptState?: { calls: number } };
    expect(state.scriptState?.calls).toBe(1);
    const turn = await testSessions.message({ sessionId: parsed.sessionId, content: 'again?' });
    expect(turn.scriptState).toMatchObject({ calls: 2 });
    expect(turn.debug).toContain('delegate answered:');

    await expectDbEmpty();
  });
});
