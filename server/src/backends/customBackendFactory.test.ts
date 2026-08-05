import { describe, expect, it } from 'vitest';
import type { BackendConfig, CustomBackend } from '@tamari/types';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import {
  createCustomBackendAdapter,
  createContextualBackendAdapter,
  customBackendSelectionFromSettings,
  getCharacterBackendScript,
  MAX_CUSTOM_BACKEND_DEPTH,
  type CustomBackendFactoryDeps,
} from './customBackendFactory.js';
import type { BackendAdapter, BackendStreamItem, GenerationResult, Prompt } from './BackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';
import type { ICustomBackendRepository } from '../repos/CustomBackendRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import { MemoryScriptBlobRepository } from './MemoryScriptBlobRepository.js';

function makePrompt(): Prompt {
  return { messages: [{ role: 'user', content: 'hi' }], tokenUsage: { prompt: 1, completion: 1 } };
}

function makeConfig(name: string, provider: string, customBackendId?: string): BackendConfig {
  return {
    id: `cfg-${name}`,
    name,
    description: '',
    backendProvider: provider,
    generationMode: 'chat',
    model: 'm',
    apiUrl: null,
    apiKey: null,
    temperature: null,
    maxTokens: null,
    topP: null,
    topK: null,
    minP: null,
    topA: null,
    repetitionPenalty: null,
    frequencyPenalty: null,
    presencePenalty: null,
    instructTemplate: '',
    contextLength: null,
    promptHistoryLimit: null,
    providerParams: customBackendId ? { customBackendId } : {},
    stopStrings: [],
    openrouterProvider: null,
    logitBias: null,
    supportsImages: false,
    supportsAudio: false,
    supportsVideo: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeDeps(
  opts: {
    customBackends?: CustomBackend[];
    configs?: BackendConfig[];
    createResolvedAdapter?: (settings: Record<string, unknown>) => Promise<BackendAdapter | null>;
  } = {},
): CustomBackendFactoryDeps {
  const cbStore = new Map((opts.customBackends ?? []).map((c) => [c.id, c]));
  const cfgStore = new Map((opts.configs ?? []).map((c) => [c.id, c]));
  return {
    customBackends: {
      getById: async (id: string) => cbStore.get(id),
    } as unknown as ICustomBackendRepository,
    backendConfigs: {
      list: async () => [...cfgStore.values()],
      getById: async (id: string) => cfgStore.get(id),
    } as unknown as IBackendConfigRepository,
    settings: { list: async () => ({}) } as unknown as ISettingsRepository,
    luaRuntime: new LuaRuntime(),
    scriptBlobs: new MemoryScriptBlobRepository(),
    createResolvedAdapter:
      opts.createResolvedAdapter ??
      (async () => {
        throw new Error('createResolvedAdapter not expected');
      }),
  };
}

function makeCb(id: string, luaSource: string, name = id): CustomBackend {
  return { id, name, description: '', luaSource, createdAt: 1, updatedAt: 1 };
}

function mockAdapter(id: string, text: string): BackendAdapter {
  return {
    id,
    supportsStreaming: true,
    supportsTools: false,
    async *stream(): AsyncGenerator<BackendStreamItem, GenerationResult> {
      yield { type: 'text', token: text };
      return { finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
    },
    listModels: async () => [],
  };
}

describe('customBackendSelectionFromSettings', () => {
  it('reads the selection for provider custom', () => {
    expect(
      customBackendSelectionFromSettings({ backendProvider: 'custom', customBackendId: 'cb-1', delegateConfigId: 'cfg-9' }),
    ).toEqual({ customBackendId: 'cb-1', delegateConfigId: 'cfg-9' });
  });

  it('defaults the delegate to null', () => {
    expect(customBackendSelectionFromSettings({ backendProvider: 'custom', customBackendId: 'cb-1' })).toEqual({
      customBackendId: 'cb-1',
      delegateConfigId: null,
    });
  });

  it('returns null for other providers or missing id', () => {
    expect(customBackendSelectionFromSettings({ backendProvider: 'openai', customBackendId: 'cb-1' })).toBeNull();
    expect(customBackendSelectionFromSettings({ backendProvider: 'custom' })).toBeNull();
  });
});

describe('createCustomBackendAdapter', () => {
  it('builds a working adapter from the registry', async () => {
    const deps = makeDeps({ customBackends: [makeCb('cb-1', 'function generate(p, c) return "ok" end')] });
    const adapter = await createCustomBackendAdapter(deps, 'cb-1', null);
    expect(adapter.id).toBe('custom:cb-1');
    const { items } = await consumeStream(adapter.stream(makePrompt(), new AbortController().signal));
    expect(items).toEqual([{ type: 'text', token: 'ok' }]);
  });

  it('throws for a missing custom backend', async () => {
    const deps = makeDeps();
    await expect(createCustomBackendAdapter(deps, 'nope', null)).rejects.toThrow('not found');
  });

  it('delegates to the default delegate config when no id is given', async () => {
    const deps = makeDeps({
      customBackends: [makeCb('cb-1', 'function generate(p, c) local r = backends.generate(p):await() return r.text end')],
      configs: [makeConfig('Main Model', 'openai')],
      createResolvedAdapter: async () => mockAdapter('openai', 'default-delegate-text'),
    });
    const adapter = await createCustomBackendAdapter(deps, 'cb-1', 'cfg-Main Model');
    const { items } = await consumeStream(adapter.stream(makePrompt(), new AbortController().signal));
    expect(items).toEqual([{ type: 'text', token: 'default-delegate-text' }]);
  });

  it('delegates to an explicit config id when given', async () => {
    const deps = makeDeps({
      customBackends: [
        makeCb('cb-1', 'function generate(p, c) local r = backends.generate("cfg-Aux", p):await() return r.text end'),
      ],
      configs: [makeConfig('Aux', 'openai'), makeConfig('Main', 'openai')],
      createResolvedAdapter: async () => mockAdapter('openai', 'aux-text'),
    });
    const adapter = await createCustomBackendAdapter(deps, 'cb-1', 'cfg-Main');
    const { items } = await consumeStream(adapter.stream(makePrompt(), new AbortController().signal));
    expect(items).toEqual([{ type: 'text', token: 'aux-text' }]);
  });

  it('errors when no default delegate is configured', async () => {
    const deps = makeDeps({
      customBackends: [makeCb('cb-1', 'function generate(p, c) local r = backends.generate(p):await() return r.text end')],
    });
    const adapter = await createCustomBackendAdapter(deps, 'cb-1', null);
    const { result } = await consumeStream(adapter.stream(makePrompt(), new AbortController().signal));
    expect(result.error).toContain('no delegate configured');
  });

  it('delegation to an unknown config id errors inside the script', async () => {
    const deps = makeDeps({
      customBackends: [
        makeCb('cb-1', 'function generate(p, c) local r = backends.generate("cfg-ghost", p):await() return r.text end'),
      ],
    });
    const adapter = await createCustomBackendAdapter(deps, 'cb-1', null);
    const { result } = await consumeStream(adapter.stream(makePrompt(), new AbortController().signal));
    expect(result.error).toContain('"cfg-ghost" not found');
  });

  it('caps custom → custom delegation depth', async () => {
    // Cycle: cb-1 → cfg-b (custom cb-2) → cb-2 → cfg-a (custom cb-1) → …
    const cyclicLua = (target: string) =>
      `function generate(p, c) local r = backends.generate("${target}", p):await() return r.text end`;
    const deps = makeDeps({
      customBackends: [makeCb('cb-1', cyclicLua('cfg-b')), makeCb('cb-2', cyclicLua('cfg-a'))],
      configs: [makeConfig('a', 'custom', 'cb-1'), makeConfig('b', 'custom', 'cb-2')],
    });
    const adapter = await createCustomBackendAdapter(deps, 'cb-1', null);
    const { result } = await consumeStream(adapter.stream(makePrompt(), new AbortController().signal));
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain(`max ${MAX_CUSTOM_BACKEND_DEPTH}`);
  });

  it('errors when a custom config has no customBackendId', async () => {
    const deps = makeDeps({
      customBackends: [
        makeCb('cb-1', 'function generate(p, c) local r = backends.generate("cfg-broken", p):await() return r.text end'),
      ],
      configs: [makeConfig('broken', 'custom')],
    });
    const adapter = await createCustomBackendAdapter(deps, 'cb-1', null);
    const { result } = await consumeStream(adapter.stream(makePrompt(), new AbortController().signal));
    expect(result.error).toContain('customBackendId');
  });
});

describe('getCharacterBackendScript', () => {
  it('returns the script when enabled and non-empty', () => {
    const character = { extensions: { contextualBackend: { enabled: true, luaSource: 'return 1' } } };
    expect(getCharacterBackendScript(character)).toEqual({ luaSource: 'return 1' });
  });

  it('returns null when disabled, empty, missing, or malformed', () => {
    expect(getCharacterBackendScript({ extensions: { contextualBackend: { enabled: false, luaSource: 'x' } } })).toBeNull();
    expect(getCharacterBackendScript({ extensions: { contextualBackend: { enabled: true, luaSource: '  ' } } })).toBeNull();
    expect(getCharacterBackendScript({ extensions: {} })).toBeNull();
    expect(getCharacterBackendScript({ extensions: { contextualBackend: 'garbage' } })).toBeNull();
    expect(getCharacterBackendScript(null)).toBeNull();
    expect(getCharacterBackendScript(undefined)).toBeNull();
  });

  it('parses the files module map tolerantly', () => {
    const character = {
      extensions: {
        contextualBackend: {
          enabled: true,
          luaSource: 'return 1',
          files: { 'lib/utils.lua': 'return {}', 'lib/noext': 'return 1' },
        },
      },
    };
    expect(getCharacterBackendScript(character)).toEqual({
      luaSource: 'return 1',
      files: { 'lib/utils.lua': 'return {}', 'lib/noext': 'return 1' },
    });
  });

  it('drops invalid keys, non-string values, and garbage files shapes', () => {
    expect(
      getCharacterBackendScript({
        extensions: {
          contextualBackend: {
            enabled: true,
            luaSource: 'x',
            files: {
              '../evil.lua': 'x',
              '/abs.lua': 'x',
              'bad name.lua': 'x',
              'ok/good.lua': 42,
              'ok/alsoBad.lua': null,
            },
          },
        },
      }),
    ).toEqual({ luaSource: 'x' });

    // Non-object files values are ignored outright.
    expect(
      getCharacterBackendScript({
        extensions: { contextualBackend: { enabled: true, luaSource: 'x', files: 'not-a-map' } },
      }),
    ).toEqual({ luaSource: 'x' });
    expect(
      getCharacterBackendScript({
        extensions: { contextualBackend: { enabled: true, luaSource: 'x', files: ['lib/a.lua'] } },
      }),
    ).toEqual({ luaSource: 'x' });
  });
});

describe('createContextualBackendAdapter', () => {
  it('uses the active adapter as the default delegate', async () => {
    const deps = makeDeps();
    const active = mockAdapter('active', 'writer-model-text');
    const adapter = createContextualBackendAdapter(deps, {
      characterId: 'char-1',
      characterName: 'Card',
      luaSource: 'function generate(p, c) local r = backends.generate(p):await() return r.text .. "!" end',
      activeAdapter: active,
    });
    expect(adapter.id).toBe('character-backend:char-1');
    const { items, result } = await consumeStream(adapter.stream(makePrompt(), new AbortController().signal));
    expect(items).toEqual([{ type: 'text', token: 'writer-model-text!' }]);
    expect(result.finishReason).toBe('stop');
  });

  it('resolves explicit config ids for multi-target scripts', async () => {
    const deps = makeDeps({
      configs: [makeConfig('Aux', 'openai')],
      createResolvedAdapter: async () => mockAdapter('openai', 'aux-text'),
    });
    const adapter = createContextualBackendAdapter(deps, {
      characterId: 'char-1',
      characterName: 'Card',
      luaSource: 'function generate(p, c) local r = backends.generate("cfg-Aux", p):await() return r.text end',
      activeAdapter: mockAdapter('active', 'active-text'),
    });
    const { items } = await consumeStream(adapter.stream(makePrompt(), new AbortController().signal));
    expect(items).toEqual([{ type: 'text', token: 'aux-text' }]);
  });
});
