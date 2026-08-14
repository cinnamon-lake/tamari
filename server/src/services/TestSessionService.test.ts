/**
 * TestSessionService unit tests: start/greeting, message flow against the
 * deterministic mock provider (backendOverride), prompt capture, Lua script
 * state across turns, the mock tool loop, TTL/LRU eviction, and end cleanup.
 *
 * Wired over a TestHarness (real repos for characters/personas/backend
 * configs) with the REAL backend factory so the 'mock' provider resolves
 * like production; the session's own chat/generation state is in-memory —
 * every test asserts the DB stays empty.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ClientMessage } from '@tamari/types';
import { TestHarness } from '../testing/TestHarness.js';
import { TestSessionService, type TestSessionServiceDeps } from './TestSessionService.js';
import { createBackendAdapter, buildAdapterFactoryInput } from '../backends/factory.js';
import { ScriptBlobRepository } from '../repos/ScriptBlobRepository.js';
import { PromptBuilder } from '../pipeline/PromptBuilder.js';
import { WorldInfoInjector } from '../pipeline/WorldInfoInjector.js';
import { ToolRegistry } from './ToolRegistry.js';
import { UnpackedCardService } from './unpacked/UnpackedCardService.js';

/** Scripted card: counts generate() calls in its Lua state and print()s them. */
const COUNTER_LUA = `
function generate(prompt, ctx)
  if type(state) ~= "table" then state = { calls = 0 } end
  state.calls = state.calls + 1
  print("call " .. state.calls)
  return "scripted reply " .. state.calls
end
`;

function makeService(h: TestHarness, unpackedCards: UnpackedCardService, toolRegistry?: ToolRegistry): TestSessionService {
  const deps: TestSessionServiceDeps = {
    settings: h.deps.settings,
    backendConfigs: h.deps.backendConfigs,
    promptLists: h.deps.promptLists,
    backendFactory: { create: async (s) => createBackendAdapter(buildAdapterFactoryInput(s)) },
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
    ...(toolRegistry ? { toolRegistry, toolsetRepo: h.deps.toolsets } : {}),
  };
  return new TestSessionService(deps);
}

describe('TestSessionService', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;
  let service: TestSessionService;
  let characterId: string;

  beforeEach(async () => {
    let unpackedCards!: UnpackedCardService;
    h = new TestHarness({
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
    client = h.connectClient();
    service = makeService(h, unpackedCards);

    await h.send(client, { type: 'character.create', data: { name: 'Testsubject', description: 'A test subject.', firstMes: 'Greetings, {{user}}!' } } as ClientMessage);
    characterId = h.expectBroadcast('character.created').character.id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await h.teardown();
  });

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
    } as unknown as ClientMessage);
    return h.expectBroadcast('backendConfig.created').backendConfig.id;
  }

  async function expectDbEmpty() {
    expect((await h.deps.chats.listChats({ limit: 100 })).items).toHaveLength(0);
    const rs = await h.db.execute('SELECT COUNT(*) AS n FROM generations');
    expect(Number(rs.rows[0]?.n ?? 0)).toBe(0);
  }

  it('starts a session and materializes the greeting without touching the DB', async () => {
    const result = await service.start({ characterId });
    expect(result.characterName).toBe('Testsubject');
    expect(result.greeting).toBe('Greetings, User!');
    expect(typeof result.sessionId).toBe('string');
    await expectDbEmpty();
  });

  it('rejects a start without characterId/folderPath or with an unknown card', async () => {
    await expect(service.start({})).rejects.toThrow(/invalid arguments/);
    await expect(service.start({ characterId: 'nope' })).rejects.toThrow(/character not found: nope/);
  });

  it('runs a turn against the mock provider and captures the round prompt', async () => {
    const mockConfigId = await createMockConfig('respond:Mock says hello.');
    const { sessionId } = await service.start({ characterId, backendConfigId: mockConfigId });

    const turn = await service.message({ sessionId, content: 'Hi there' });
    expect(turn.reply).toBe('Mock says hello.');
    expect(turn.finishReason).toBe('stop');
    expect(typeof turn.generationId).toBe('string');

    // Lean state: chain + generation meta WITHOUT prompts.
    const state = (await service.state({ sessionId })) as {
      messages: { role: string; text: string }[];
      generations: { id: string; status: string; meta: Record<string, unknown> | null }[];
    };
    expect(state.messages.map((m) => [m.role, m.text])).toEqual([
      ['assistant', 'Greetings, User!'],
      ['user', 'Hi there'],
      ['assistant', 'Mock says hello.'],
    ]);
    expect(state.generations).toHaveLength(1);
    expect(state.generations[0]!.status).toBe('complete');
    expect(state.generations[0]!.meta).not.toHaveProperty('prompts');

    // Opt-in: full meta WITH the captured prompt.
    const full = (await service.state({ sessionId, generationId: turn.generationId })) as {
      generation: { meta: { prompts?: unknown[]; prompt?: unknown } };
    };
    expect(full.generation.meta.prompts).toHaveLength(1);
    expect(full.generation.meta.prompt).toBeDefined();

    // A generation from another session/unknown id is rejected.
    await expect(service.state({ sessionId, generationId: 'nope' })).rejects.toThrow(/generation not found/);
    await expectDbEmpty();
  });

  it('exposes the scripted card’s Lua state and print() output across turns', async () => {
    const mockConfigId = await createMockConfig('respond:unused');
    await h.deps.characters.update(characterId, {
      extensions: { contextualBackend: { enabled: true, luaSource: COUNTER_LUA } },
    });
    const { sessionId } = await service.start({ characterId, backendConfigId: mockConfigId });

    const first = await service.message({ sessionId, content: 'one' });
    expect(first.reply).toBe('scripted reply 1');
    expect(first.scriptState).toEqual({ calls: 1 });
    expect(first.debug).toContain('call 1');

    const second = await service.message({ sessionId, content: 'two' });
    expect(second.reply).toBe('scripted reply 2');
    expect(second.scriptState).toEqual({ calls: 2 });
    await expectDbEmpty();
  });

  it('runs the full tool loop against mock tool:/respond: directives', async () => {
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
    // Rebuild the service with the tool registry wired (and let the harness
    // dispatcher know about the template for toolset.create).
    let unpackedCards!: UnpackedCardService;
    await h.teardown();
    h = new TestHarness({
      toolRegistry,
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
    client = h.connectClient();
    service = makeService(h, unpackedCards, toolRegistry);

    await h.send(client, { type: 'character.create', data: { name: 'Testsubject', description: 'd', firstMes: 'hi' } } as ClientMessage);
    characterId = h.expectBroadcast('character.created').character.id;
    await h.send(client, {
      type: 'toolset.create',
      data: { templateId: 'weather', name: 'Weather Toolset', config: {}, toolOverrides: {}, enabled: true },
    } as ClientMessage);
    h.expectBroadcast('toolset.created');

    const mockConfigId = await createMockConfig('tool:get_weather:{"city":"Paris"}\nrespond:It is sunny in Paris.');
    const { sessionId } = await service.start({ characterId, backendConfigId: mockConfigId });

    const turn = await service.message({ sessionId, content: 'weather?' });
    expect(turn.reply).toBe('It is sunny in Paris.');

    const full = (await service.state({ sessionId, generationId: turn.generationId })) as {
      generation: { meta: { rounds?: number; toolCalls?: { name: string }[]; prompts?: unknown[] } };
    };
    expect(full.generation.meta.rounds).toBe(2);
    expect(full.generation.meta.toolCalls).toEqual([{ name: 'get_weather', isError: undefined }]);
    // Both rounds' prompts captured; round 2 carries the tool result.
    expect(full.generation.meta.prompts).toHaveLength(2);
    expect(JSON.stringify(full.generation.meta.prompts?.[1])).toContain('sunny, 25°C');
    await expectDbEmpty();
  });

  it('ends a session: state/message/end afterwards fail, DB stays empty', async () => {
    const mockConfigId = await createMockConfig('respond:hi');
    const { sessionId } = await service.start({ characterId, backendConfigId: mockConfigId });
    await service.message({ sessionId, content: 'yo' });

    await expect(service.end({ sessionId })).resolves.toEqual({ ended: true });
    await expect(service.state({ sessionId })).rejects.toThrow(/unknown session/);
    await expect(service.message({ sessionId, content: 'yo' })).rejects.toThrow(/unknown session/);
    await expect(service.end({ sessionId })).rejects.toThrow(/unknown session/);
    await expectDbEmpty();
  });

  it('evicts sessions idle past the TTL on the next op', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mockConfigId = await createMockConfig('respond:hi');
    const old = await service.start({ characterId, backendConfigId: mockConfigId });
    const fresh = await service.start({ characterId, backendConfigId: mockConfigId });

    vi.setSystemTime(Date.now() + 20 * 60 * 1000);
    // Touch the fresh session mid-window — the old one keeps aging.
    await service.state({ sessionId: fresh.sessionId });
    vi.setSystemTime(Date.now() + 20 * 60 * 1000);

    // Any op prunes: the old session is idle > 30 min, the fresh one is not.
    await expect(service.state({ sessionId: old.sessionId })).rejects.toThrow(/unknown session/);
    await expect(service.state({ sessionId: fresh.sessionId })).resolves.toBeDefined();
  });

  it('caps sessions with LRU eviction', async () => {
    const mockConfigId = await createMockConfig('respond:hi');
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      ids.push((await service.start({ characterId, backendConfigId: mockConfigId })).sessionId);
    }
    // The first session was evicted (cap 20); the newest is alive.
    await expect(service.state({ sessionId: ids[0]! })).rejects.toThrow(/unknown session/);
    await expect(service.state({ sessionId: ids[20]! })).resolves.toBeDefined();
  });
});
