import { describe, it, expect, vi } from 'vitest';
import { BackendWorkbench } from './BackendWorkbench.js';
import type { BackendConfig, BackendConfigUpdate, CustomBackend, CustomBackendInsert, CustomBackendUpdate } from '@tamari/types';
import type { z } from 'zod';
import type { BackendConfigCreateInputSchema } from '@tamari/types';
type BackendConfigCreateInput = z.infer<typeof BackendConfigCreateInputSchema>;
import type { BackendAdapter, BackendStreamItem, GenerationResult } from '../../backends/BackendAdapter.js';
import type { EventBus } from '../../bus/EventBus.js';
import type { IBackendConfigRepository } from '../../repos/BackendConfigRepository.js';
import type { ISettingsRepository } from '../../repos/SettingsRepository.js';
import type { SecretService } from '../SecretService.js';
import { LuaRuntime } from '../../scripting/LuaRuntime.js';

vi.mock('dns', () => ({
  default: {
    promises: {
      lookup: vi.fn(async (_hostname: string, _opts: unknown) => {
        // Simulate public DNS resolution for test hostnames
        return [{ address: '93.184.216.34', family: 4 }];
      }),
    },
  },
}));

function makeConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    id: 'cfg1',
    name: 'Test Backend',
    description: '',
    backendProvider: 'openai',
    generationMode: 'chat',
    model: 'gpt-test',
    apiUrl: 'https://api.example.com/v1',
    apiKey: 'sk-live-secret',
    temperature: 0.7,
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
    providerParams: { mirostat: 2 },
    stopStrings: [],
    openrouterProvider: null,
    logitBias: null,
    supportsImages: true,
    supportsAudio: true,
    supportsVideo: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function stubAdapter(overrides: Partial<BackendAdapter> = {}): BackendAdapter {
  const base: BackendAdapter = {
    id: 'stub',
    supportsStreaming: true,
    supportsTools: false,
    stream: async function* (): AsyncGenerator<BackendStreamItem, GenerationResult> {
      yield { type: 'text', token: 'ok' };
      return { finishReason: 'stop', usage: { promptTokens: 8, completionTokens: 1 } };
    },
    listModels: async () => [],
  };
  return { ...base, ...overrides };
}

function makeTemplate(configs: BackendConfig[], adapter: BackendAdapter | null) {
  const store = new Map(configs.map((c) => [c.id, c]));
  const update = vi.fn(async (id: string, patch: BackendConfigUpdate) => {
    const existing = store.get(id);
    if (!existing) throw new Error('not found');
    const updated = { ...existing, ...patch };
    store.set(id, updated);
    return updated;
  });
  const create = vi.fn(async (id: string, data: BackendConfigCreateInput) => {
    const config = makeConfig({ id, ...data });
    store.set(id, config);
    return config;
  });
  const backendConfigs = {
    list: async () => [...store.values()],
    listSummaries: async () => [...store.values()].map((c) => ({ id: c.id, name: c.name })),
    getById: async (id: string) => store.get(id),
    update,
    create,
  } as unknown as IBackendConfigRepository;
  const settings = {
    list: async () => ({ activeBackendConfigId: 'cfg1' }),
    setValue: vi.fn(async () => {}),
  } as unknown as ISettingsRepository;
  const bus = { broadcast: vi.fn() } as unknown as EventBus;

  // Type A custom-backend registry stub (Map-backed)
  const cbStore = new Map<string, CustomBackend>();
  const customBackends = {
    list: async () => [...cbStore.values()],
    getById: async (id: string) => cbStore.get(id),
    create: async (id: string, data: CustomBackendInsert) => {
      const item: CustomBackend = { id, createdAt: 1, updatedAt: 1, ...data };
      cbStore.set(id, item);
      return item;
    },
    update: async (id: string, patch: CustomBackendUpdate) => {
      const existing = cbStore.get(id);
      if (!existing) throw new Error('not found');
      const updated = { ...existing, ...patch };
      cbStore.set(id, updated);
      return updated;
    },
    delete: async (id: string) => {
      cbStore.delete(id);
    },
  };

  const template = new BackendWorkbench({
    backendConfigs,
    settings,
    bus,
    secretService: {} as SecretService,
    secretsPassword: 'pw',
    customBackends,
    luaRuntime: new LuaRuntime(),
    createAdapter: () => adapter,
  });
  return { template, bus, backendConfigs, update, create, settings, store, cbStore };
}

describe('BackendWorkbench', () => {
  describe('backend_create', () => {
    it('creates a config with defaults and broadcasts; redacts apiKey', async () => {
      const { template, bus, store } = makeTemplate([], stubAdapter());
      const res = await template.execute('backend_create', {
        name: 'Local Llama',
        backendProvider: 'llamacpp',
        model: 'llama-3',
        apiUrl: 'http://localhost:8080',
        apiKey: 'secret-key',
      });
      const parsed = JSON.parse(res.content as string) as { id: string; name: string; hasApiKey: boolean; apiKey?: string };
      expect(parsed.name).toBe('Local Llama');
      expect(parsed.hasApiKey).toBe(true);
      expect(parsed.apiKey).toBeUndefined();
      expect(store.size).toBe(1);
      const types = (bus.broadcast as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { type: string }).type);
      expect(types).toEqual(['backendConfig.created', 'backendConfig.snapshot', 'backendConfig.listed']);
    });

    it('rejects a missing name', async () => {
      const { template, store } = makeTemplate([], stubAdapter());
      const res = await template.execute('backend_create', { model: 'x' });
      expect(String(res.content)).toContain('Error: invalid arguments');
      expect(store.size).toBe(0);
    });

    it('activate=true sets activeBackendConfigId and broadcasts settings.changed', async () => {
      const { template, bus, settings } = makeTemplate([], stubAdapter());
      const res = await template.execute('backend_create', { name: 'New Active', activate: true });
      const parsed = JSON.parse(res.content as string) as { id: string };
      expect(settings.setValue).toHaveBeenCalledWith('activeBackendConfigId', parsed.id);
      const types = (bus.broadcast as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { type: string }).type);
      expect(types).toContain('settings.changed');
    });
  });

  describe('backend_get', () => {
    it('redacts the apiKey', async () => {
      const { template } = makeTemplate([makeConfig()], stubAdapter());
      const res = await template.execute('backend_get', {});
      const parsed = JSON.parse(res.content as string) as Record<string, unknown>;
      expect(parsed.hasApiKey).toBe(true);
      expect(parsed.apiKey).toBeUndefined();
      expect(res.content).not.toContain('sk-live-secret');
    });

    it('errors when the config is not found', async () => {
      const { template } = makeTemplate([makeConfig()], stubAdapter());
      const res = await template.execute('backend_get', { configId: 'nope' });
      expect(res.content).toBe('Error: backend config not found');
    });
  });

  describe('backend_update', () => {
    it('shallow-merges providerParams and broadcasts the three events', async () => {
      const { template, bus, update, store } = makeTemplate([makeConfig()], stubAdapter());
      const res = await template.execute('backend_update', {
        patch: { providerParams: { requestScript: 'request.url = request.url' } },
      });

      // Existing providerParams keys survive the requestScript patch
      const mergedPatch = update.mock.calls[0]?.[1];
      expect(mergedPatch?.providerParams).toEqual({
        mirostat: 2,
        requestScript: 'request.url = request.url',
      });
      expect(store.get('cfg1')?.providerParams['mirostat']).toBe(2);

      // Response is redacted like backend_get
      const parsed = JSON.parse(res.content as string) as Record<string, unknown>;
      expect(parsed.apiKey).toBeUndefined();
      expect(parsed.hasApiKey).toBe(true);

      const broadcast = bus.broadcast as ReturnType<typeof vi.fn>;
      const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
      expect(types).toEqual(['backendConfig.updated', 'backendConfig.snapshot', 'backendConfig.listed']);
    });
  });

  describe('backend_test dry', () => {
    it('shows script mutations in after, with secrets scrubbed', async () => {
      const adapter = stubAdapter({
        buildRequest: () => ({
          url: 'https://api.example.com/v1/chat/completions?key=sekret',
          init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekret' },
            body: JSON.stringify({ model: 'gpt-test', temperature: 1, apiKey: 'sekret' }),
          },
        }),
      });
      const config = makeConfig({ providerParams: { requestScript: 'request.body.temperature = 0.2' } });
      const { template } = makeTemplate([config], adapter);

      const res = await template.execute('backend_test', { mode: 'dry' });
      const parsed = JSON.parse(res.content as string) as {
        before: { url: string; headers: Record<string, string>; body: string };
        after: { url: string; headers: Record<string, string>; body: string };
        error?: string;
      };
      expect(parsed.error).toBeUndefined();

      // Script mutation visible in after
      const afterBody = JSON.parse(parsed.after.body) as { temperature: number };
      expect(afterBody.temperature).toBe(0.2);
      const beforeBody = JSON.parse(parsed.before.body) as { temperature: number };
      expect(beforeBody.temperature).toBe(1);

      // Secret header absent; query ?key= scrubbed; body apiKey scrubbed
      expect(parsed.after.headers['Authorization']).toBeUndefined();
      expect(parsed.after.url).not.toContain('sekret');
      expect(parsed.after.url).toContain('REDACTED');
      expect(res.content).not.toContain('sekret');
    });

    it('errors when the adapter has no buildRequest', async () => {
      const { template } = makeTemplate([makeConfig()], stubAdapter());
      const res = await template.execute('backend_test', { mode: 'dry' });
      expect(res.content).toBe('Error: dry run not supported for this provider, use live');
    });
  });

  describe('backend_test live', () => {
    it('returns ok with the streamed text', async () => {
      const adapter = stubAdapter({
        stream: async function* (): AsyncGenerator<BackendStreamItem, GenerationResult> {
          yield { type: 'text', token: 'Hel' };
          yield { type: 'text', token: 'lo' };
          return { finishReason: 'stop', usage: { promptTokens: 8, completionTokens: 2 } };
        },
      });
      const { template } = makeTemplate([makeConfig()], adapter);
      const res = await template.execute('backend_test', { mode: 'live' });
      const parsed = JSON.parse(res.content as string) as { ok: boolean; text: string; finishReason: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.text).toBe('Hello');
      expect(parsed.finishReason).toBe('stop');
    });

    it('returns a scrubbed error string on upstream failure', async () => {
      const adapter = stubAdapter({
        stream: async function* (): AsyncGenerator<BackendStreamItem, GenerationResult> {
          yield* [];
          return await Promise.resolve({
            finishReason: 'error',
            usage: { promptTokens: 8, completionTokens: 0 },
            error: 'HTTP 401: invalid key Bearer sk-abc123',
          });
        },
      });
      const { template } = makeTemplate([makeConfig()], adapter);
      const res = await template.execute('backend_test', { mode: 'live' });
      const parsed = JSON.parse(res.content as string) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('Bearer [REDACTED]');
      expect(parsed.error).not.toContain('sk-abc123');
    });
  });

  describe('custom_backend tools', () => {
    const ECHO_LUA = 'function generate(prompt, ctx) return "echo:" .. prompt.messages[#prompt.messages].content end';

    it('create → get round-trips a script and broadcasts', async () => {
      const { template, bus } = makeTemplate([], stubAdapter());
      const created = JSON.parse(
        (await template.execute('custom_backend_create', {
          name: 'Echo',
          description: 'repeats input',
          luaSource: ECHO_LUA,
        })).content as string,
      ) as { id: string };
      expect(created.id).toBeTruthy();

      const got = JSON.parse((await template.execute('custom_backend_get', { id: created.id })).content as string) as { name: string; luaSource: string };
      expect(got.name).toBe('Echo');
      expect(got.luaSource).toBe(ECHO_LUA);

      const types = (bus.broadcast as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { type: string }).type);
      expect(types).toContain('custombackend.created');
      expect(types).toContain('custombackend.listed');
    });

    it('update patches fields; delete removes and broadcasts', async () => {
      const { template, bus, cbStore } = makeTemplate([], stubAdapter());
      const created = JSON.parse(
        (await template.execute('custom_backend_create', { name: 'A', luaSource: ECHO_LUA })).content as string,
      ) as { id: string };

      const updated = JSON.parse(
        (await template.execute('custom_backend_update', { id: created.id, patch: { name: 'B' } })).content as string,
      ) as { name: string; luaSource: string };
      expect(updated.name).toBe('B');
      expect(updated.luaSource).toBe(ECHO_LUA);

      await template.execute('custom_backend_delete', { id: created.id });
      expect(cbStore.size).toBe(0);
      const types = (bus.broadcast as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { type: string }).type);
      expect(types).toContain('custombackend.updated');
      expect(types).toContain('custombackend.deleted');
    });

    it('get/update/delete error for unknown ids', async () => {
      const { template } = makeTemplate([], stubAdapter());
      expect((await template.execute('custom_backend_get', { id: 'nope' })).content).toContain('not found');
      expect((await template.execute('custom_backend_update', { id: 'nope', patch: { name: 'x' } })).content).toContain('not found');
      expect((await template.execute('custom_backend_delete', { id: 'nope' })).content).toContain('not found');
    });

    it('custom_backend_test dry-runs a stored script and an ad-hoc luaSource', async () => {
      const { template } = makeTemplate([], stubAdapter());
      const created = JSON.parse(
        (await template.execute('custom_backend_create', { name: 'Echo', luaSource: ECHO_LUA })).content as string,
      ) as { id: string };

      const stored = JSON.parse(
        (await template.execute('custom_backend_test', { id: created.id, input: 'hello' })).content as string,
      ) as { ok: boolean; text?: string };
      expect(stored.ok).toBe(true);
      expect(stored.text).toBe('echo:hello');

      const adhoc = JSON.parse(
        (await template.execute('custom_backend_test', {
          luaSource: 'function generate(p, c) local r = backends.generate(p):await() return r.text end',
          input: 'hi',
          delegateResponse: 'CANNED',
        })).content as string,
      ) as { ok: boolean; text?: string; delegations: unknown[] };
      expect(adhoc.ok).toBe(true);
      expect(adhoc.text).toBe('CANNED');
      expect(adhoc.delegations).toHaveLength(1);

      expect((await template.execute('custom_backend_test', { input: 'hi' })).content).toContain('either id');
    });

    it('custom_backend_test accepts state as a plain object and delegateResponse as { text } / { error }', async () => {
      const { template } = makeTemplate([], stubAdapter());
      const res = JSON.parse(
        (await template.execute('custom_backend_test', {
          luaSource:
            'function generate(p, c) local n = (type(state) == "table" and state.turns or 0) + 1 state = { turns = n } local r = backends.generate(p):await() return r.text .. " (turn " .. n .. ")" end',
          input: 'hi',
          state: { turns: 2 },
          delegateResponse: { text: 'CANNED' },
        })).content as string,
      ) as { ok: boolean; text?: string; stateOut?: string };
      expect(res.ok).toBe(true);
      expect(res.text).toBe('CANNED (turn 3)');
      expect(JSON.parse(res.stateOut!)).toEqual({ turns: 3 });

      const failing = JSON.parse(
        (await template.execute('custom_backend_test', {
          luaSource: 'function generate(p, c) local r = backends.generate(p):await() return r.text end',
          input: 'hi',
          delegateResponse: { error: 'delegate died' },
        })).content as string,
      ) as { ok: boolean; error?: string };
      expect(failing.ok).toBe(false);
      expect(failing.error).toContain('delegate died');
    });
  });
});
