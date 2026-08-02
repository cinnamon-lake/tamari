/**
 * Backend workbench tool template.
 *
 * Lets the model inspect backend configs, edit them (including the Lua
 * request script), and test the result — dry-run the request script against
 * the exact request the adapter would send, or fire a minimal live request —
 * before saving. Typical loop: backend_get → backend_test (dry, with patch)
 * → backend_test (live) → backend_update.
 *
 * Also covers Type A custom backends (scriptable-layers.md §2): the
 * custom_backend_* tools CRUD the registry scripts and dry-run them against a
 * recording delegate (custom_backend_test) — the global-script counterpart of
 * the Character Workbench's backend_logic_* tools.
 *
 * All errors are returned as `content` strings, never thrown.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BackendConfig, BackendConfigUpdate, SettingsMap } from '@tamari/types';
import { BackendConfigCreateInputSchema, BackendConfigUpdateSchema } from '@tamari/types';
import type { ToolContext, ToolExecuteResult } from '../ToolTemplate.js';
import type { EventBus } from '../../bus/EventBus.js';
import type { IBackendConfigRepository } from '../../repos/BackendConfigRepository.js';
import type { ISettingsRepository } from '../../repos/SettingsRepository.js';
import type { SecretService } from '../SecretService.js';
import { resolveSecretSettings } from '../SecretResolver.js';
import { buildBackendSettings } from '../../backends/buildBackendSettings.js';
import { createBackendAdapter, buildAdapterFactoryInput } from '../../backends/factory.js';
import { applyRequestScript, RequestScriptError } from '../../backends/RequestScript.js';
import { redactHeaders, scrubBodyText, scrubText, scrubUrlQuery } from '../../backends/RequestLogger.js';
import { consumeStream, type BackendAdapter, type Prompt } from '../../backends/BackendAdapter.js';
import { toBackendConfigSummary } from '../../lib/summaries.js';
import type { ICustomBackendRepository } from '../../repos/CustomBackendRepository.js';
import type { LuaRuntime } from '../../scripting/LuaRuntime.js';
import { dryRunBackendScript } from '../../backends/customBackendDryRun.js';

const BODY_PREVIEW_LIMIT = 4096;
const LIVE_TIMEOUT_MS = 30_000;
const DEFAULT_TEST_PROMPT = 'Reply with: ok';

export interface BackendWorkbenchDeps {
  backendConfigs: IBackendConfigRepository;
  settings: ISettingsRepository;
  bus: EventBus;
  secretService: SecretService;
  secretsPassword: string;
  /** Type A registry scripts (custom_backend_* tools). */
  customBackends: ICustomBackendRepository;
  /** Lua runtime for custom_backend_test dry-runs. */
  luaRuntime: LuaRuntime;
  /** Injectable for tests; defaults to the real adapter factory. */
  createAdapter?: (settings: SettingsMap) => BackendAdapter | null;
}

const BackendGetArgs = z.object({
  configId: z.string().optional().describe('Backend config id. Defaults to the active config.'),
});

const BackendUpdateArgs = z.object({
  configId: z.string().optional().describe('Backend config id. Defaults to the active config.'),
  patch: z
    .record(z.string(), z.unknown())
    .describe('Partial BackendConfig fields to update. providerParams is shallow-merged into the existing record.'),
});

const BackendCreateArgs = BackendConfigCreateInputSchema.extend({
  activate: z.boolean().optional().describe('Also make the new config the active one. Default false.'),
}).describe(
  'New backend config. Only name is required; provider defaults to openai. apiUrl/apiKey optional (leave apiKey unset for keyless local backends). All sampler fields have defaults.',
);

const BackendTestArgs = z.object({
  configId: z.string().optional().describe('Backend config id. Defaults to the active config.'),
  patch: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('In-memory-only patch applied for this test (not saved). providerParams is shallow-merged.'),
  prompt: z.string().optional().describe(`Test prompt. Defaults to "${DEFAULT_TEST_PROMPT}".`),
  mode: z
    .enum(['dry', 'live'])
    .describe(
      'dry: build the request and apply the request script without sending. live: send a minimal request (30s timeout).',
    ),
});

// ---------- Custom backends (Type A registry scripts, scriptable-layers.md §2) ----------

const CustomBackendGetArgs = z.object({
  id: z.string().describe('Custom backend id (a /custom-backends/<id>/ path).'),
});

const CustomBackendCreateArgs = z.object({
  name: z.string().min(1).describe('Script name.'),
  description: z.string().optional().describe('What this backend does.'),
  luaSource: z
    .string()
    .min(1)
    .describe(
      'Lua source implementing generate(prompt, ctx) — returns a string, { text = ... }, { toolCalls = ... }, or { __passthrough = true }. backends.generate(prompt):await() delegates to the config\'s default backend; state/serialize()/deserialize() persist per-chat state.',
    ),
});

const CustomBackendUpdateArgs = z.object({
  id: z.string().describe('Custom backend id (a /custom-backends/<id>/ path).'),
  patch: z
    .object({
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      luaSource: z.string().min(1).optional(),
    })
    .describe('Fields to update. Omitted fields are unchanged.'),
});

const CustomBackendDeleteArgs = z.object({
  id: z.string().describe('Custom backend id (a /custom-backends/<id>/ path).'),
});

const CustomBackendTestArgs = z.object({
  id: z.string().optional().describe('Custom backend id to test. Omit when passing luaSource directly.'),
  luaSource: z.string().optional().describe('Test this Lua source instead of a stored script — iterate without saving.'),
  input: z.string().min(1).describe('Sample user message fed to generate() as the last prompt message.'),
  state: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    // Models keep passing the snapshot as a parsed object — accept both and
    // normalize to the raw string format dryRunBackendScript expects.
    .transform((v) => (typeof v === 'string' || v === undefined ? v : JSON.stringify(v)))
    .describe('Canned script-state snapshot injected as the `state` global — a JSON string OR a plain object (serialized for you), e.g. the stateOut of a previous dry-run.'),
  delegateResponse: z
    .union([z.string(), z.object({ error: z.string() }), z.object({ text: z.string() })])
    .optional()
    // { text } unwraps to a plain canned-text response.
    .transform((v) => (typeof v === 'object' && 'text' in v ? v.text : v))
    .describe('Canned answer for every delegated backends.generate() call — text, { "text": "..." }, or { "error": "..." } to test delegation failures. Defaults to a placeholder.'),
  history: z
    .array(z.object({ role: z.string(), content: z.string() }))
    .optional()
    .describe('Canned full branch history (oldest first) backing the `chat` global. Omit → `chat` is nil in the dry-run.'),
});

/** Replace the apiKey with a boolean marker so secrets never reach the model. */
function redactConfig(config: BackendConfig): Record<string, unknown> {
  const { apiKey, ...rest } = config;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

function requestScriptOf(config: BackendConfig): string | undefined {
  const script = config.providerParams['requestScript'] ?? config.providerParams['custom.requestScript'];
  return typeof script === 'string' ? script : undefined;
}

function describeRequest(url: string, init: RequestInit): Record<string, unknown> {
  const rawBody = typeof init.body === 'string' ? init.body : '';
  const scrubbedBody = scrubBodyText(rawBody);
  return {
    url: scrubUrlQuery(url),
    method: init.method ?? 'POST',
    headers: redactHeaders(init.headers),
    body:
      scrubbedBody.length > BODY_PREVIEW_LIMIT
        ? scrubbedBody.slice(0, BODY_PREVIEW_LIMIT) + '\n… [truncated]'
        : scrubbedBody,
  };
}

export class BackendWorkbench {

  constructor(private deps: BackendWorkbenchDeps) {}

  async execute(toolName: string, args: Record<string, unknown>, _context?: ToolContext): Promise<ToolExecuteResult> {
    try {
      switch (toolName) {
        case 'backend_get':
          return await this.getConfig(args);
        case 'backend_create':
          return await this.createConfig(args);
        case 'backend_update':
          return await this.updateConfig(args);
        case 'backend_test':
          return await this.testConfig(args);
        case 'custom_backend_get':
          return await this.customBackendGet(args);
        case 'custom_backend_create':
          return await this.customBackendCreate(args);
        case 'custom_backend_update':
          return await this.customBackendUpdate(args);
        case 'custom_backend_delete':
          return await this.customBackendDelete(args);
        case 'custom_backend_test':
          return await this.customBackendTest(args);
        default:
          return { content: `Error: unknown tool ${toolName}` };
      }
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async activeConfigId(): Promise<string> {
    const all = await this.deps.settings.list();
    const id = all['activeBackendConfigId'];
    return typeof id === 'string' ? id : '';
  }

  private async resolveConfig(configId: string | undefined): Promise<BackendConfig | undefined> {
    const id = configId ?? (await this.activeConfigId());
    if (!id) return undefined;
    return this.deps.backendConfigs.getById(id);
  }

  private async getConfig(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendGetArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const config = await this.resolveConfig(parsed.data.configId);
    if (!config) return { content: 'Error: backend config not found' };
    return { content: JSON.stringify(redactConfig(config)) };
  }

  private async createConfig(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendCreateArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments: ${parsed.error.message}` };
    const { activate, ...data } = parsed.data;

    const backendConfig = await this.deps.backendConfigs.create(randomUUID(), data);

    // Same broadcast set as the backendConfig.create dispatcher handler.
    this.deps.bus.broadcast({ type: 'backendConfig.created', backendConfig });
    this.deps.bus.broadcast({ type: 'backendConfig.snapshot', backendConfig });
    const list = await this.deps.backendConfigs.listSummaries();
    this.deps.bus.broadcast({ type: 'backendConfig.listed', backendConfigs: list.map(toBackendConfigSummary) });

    if (activate === true) {
      await this.deps.settings.setValue('activeBackendConfigId', backendConfig.id);
      this.deps.bus.broadcast({ type: 'settings.changed', key: 'activeBackendConfigId', value: backendConfig.id });
    }

    return { content: JSON.stringify(redactConfig(backendConfig)) };
  }

  private async updateConfig(args: Record<string, unknown>): Promise<ToolExecuteResult> {    const parsed = BackendUpdateArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };

    const config = await this.resolveConfig(parsed.data.configId);
    if (!config) return { content: 'Error: backend config not found' };

    const patch = BackendConfigUpdateSchema.safeParse(parsed.data.patch);
    if (!patch.success) return { content: `Error: invalid patch: ${patch.error.message}` };

    // Shallow-merge providerParams so a requestScript edit doesn't clobber sampler keys.
    const merged: BackendConfigUpdate = { ...(patch.data as BackendConfigUpdate) };
    if (merged.providerParams) {
      merged.providerParams = { ...config.providerParams, ...merged.providerParams };
    }

    const backendConfig = await this.deps.backendConfigs.update(config.id, merged);

    // Same broadcast triplet as the backendConfig.update dispatcher handler (no exclusion).
    this.deps.bus.broadcast({ type: 'backendConfig.updated', backendConfig });
    this.deps.bus.broadcast({ type: 'backendConfig.snapshot', backendConfig });
    const list = await this.deps.backendConfigs.listSummaries();
    this.deps.bus.broadcast({ type: 'backendConfig.listed', backendConfigs: list.map(toBackendConfigSummary) });

    return { content: JSON.stringify(redactConfig(backendConfig)) };
  }

  private async testConfig(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendTestArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const { configId, patch, prompt, mode } = parsed.data;

    const persisted = await this.resolveConfig(configId);
    if (!persisted) return { content: 'Error: backend config not found' };

    // Merge the patch in memory only — the model iterates without dirtying the
    // saved config, then persists via backend_update once green.
    let candidate: BackendConfig = persisted;
    if (patch) {
      const validPatch = BackendConfigUpdateSchema.safeParse(patch);
      if (!validPatch.success) return { content: `Error: invalid patch: ${validPatch.error.message}` };
      const patchData = validPatch.data as BackendConfigUpdate;
      candidate = {
        ...persisted,
        ...patchData,
        providerParams: { ...persisted.providerParams, ...(patchData.providerParams ?? {}) },
      };
    }

    const backendSettings = buildBackendSettings(await this.deps.settings.list(), candidate);
    await resolveSecretSettings(backendSettings, this.deps.secretService, this.deps.secretsPassword);
    const createAdapter = this.deps.createAdapter ?? ((s: SettingsMap) => createBackendAdapter(buildAdapterFactoryInput(s)));
    const adapter = createAdapter(backendSettings as SettingsMap);
    if (!adapter) {
      return { content: 'Error: no API key configured for this backend (adapter could not be created)' };
    }

    const promptText = prompt ?? DEFAULT_TEST_PROMPT;
    const testPrompt: Prompt = {
      messages: [{ role: 'user', content: promptText }],
      text: promptText, // text-completion adapters read prompt.text
      tokenUsage: { prompt: 8, completion: 16 },
    };

    if (mode === 'dry') {
      return this.dryRun(adapter, candidate, testPrompt);
    }
    return this.liveRun(adapter, testPrompt);
  }

  private async dryRun(
    adapter: BackendAdapter,
    candidate: BackendConfig,
    testPrompt: Prompt,
  ): Promise<ToolExecuteResult> {
    if (!adapter.buildRequest) {
      return { content: 'Error: dry run not supported for this provider, use live' };
    }

    const { url, init } = adapter.buildRequest(testPrompt);
    const before = describeRequest(url, init);

    const script = requestScriptOf(candidate);
    // Mirror adapter stream() behaviour: no script → no script engine, no SSRF re-check.
    if (!script?.trim()) {
      return { content: JSON.stringify({ mode: 'dry', before, after: before }) };
    }

    try {
      const result = await applyRequestScript(url, init, script);
      const after = describeRequest(result.url, result.init);
      return { content: JSON.stringify({ mode: 'dry', before, after }) };
    } catch (err) {
      const message = err instanceof RequestScriptError ? err.message : String(err);
      return { content: JSON.stringify({ mode: 'dry', before, error: message }) };
    }
  }

  private async liveRun(adapter: BackendAdapter, testPrompt: Prompt): Promise<ToolExecuteResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, LIVE_TIMEOUT_MS);
    try {
      const { items, result } = await consumeStream(adapter.stream(testPrompt, controller.signal));
      const text = items
        .filter((i) => i.type === 'text')
        .map((i) => i.token)
        .join('');
      const ok = result.finishReason !== 'error' && !result.error;
      return {
        content: JSON.stringify({
          mode: 'live',
          ok,
          ...(text ? { text: text.slice(0, 300) } : {}),
          finishReason: result.finishReason,
          ...(result.error ? { error: scrubText(result.error) } : {}),
          usage: result.usage,
        }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: JSON.stringify({ mode: 'live', ok: false, error: scrubText(message) }) };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------- Custom backends (Type A registry scripts) ----------

  private async rebroadcastCustomBackends(): Promise<void> {
    // Mirror the custombackend.* dispatcher handlers: full list after every mutation.
    const items = await this.deps.customBackends.list();
    this.deps.bus.broadcast({ type: 'custombackend.listed', items });
  }

  private async customBackendGet(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CustomBackendGetArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const item = await this.deps.customBackends.getById(parsed.data.id);
    if (!item) return { content: `Error: custom backend "${parsed.data.id}" not found` };
    return { content: JSON.stringify(item) };
  }

  private async customBackendCreate(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CustomBackendCreateArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const item = await this.deps.customBackends.create(randomUUID(), {
      name: parsed.data.name,
      description: parsed.data.description ?? '',
      luaSource: parsed.data.luaSource,
    });
    this.deps.bus.broadcast({ type: 'custombackend.created', item });
    await this.rebroadcastCustomBackends();
    return { content: JSON.stringify(item) };
  }

  private async customBackendUpdate(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CustomBackendUpdateArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const existing = await this.deps.customBackends.getById(parsed.data.id);
    if (!existing) return { content: `Error: custom backend "${parsed.data.id}" not found` };
    const item = await this.deps.customBackends.update(parsed.data.id, parsed.data.patch);
    this.deps.bus.broadcast({ type: 'custombackend.updated', item });
    await this.rebroadcastCustomBackends();
    return { content: JSON.stringify(item) };
  }

  private async customBackendDelete(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CustomBackendDeleteArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const existing = await this.deps.customBackends.getById(parsed.data.id);
    if (!existing) return { content: `Error: custom backend "${parsed.data.id}" not found` };
    await this.deps.customBackends.delete(parsed.data.id);
    this.deps.bus.broadcast({ type: 'custombackend.deleted', id: parsed.data.id });
    await this.rebroadcastCustomBackends();
    return { content: `Deleted custom backend "${parsed.data.id}".` };
  }

  private async customBackendTest(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CustomBackendTestArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const { id, luaSource, input, state, delegateResponse, history } = parsed.data;

    let source = luaSource;
    if (source === undefined) {
      if (!id) return { content: 'Error: pass either id (stored script) or luaSource (ad-hoc)' };
      const item = await this.deps.customBackends.getById(id);
      if (!item) return { content: `Error: custom backend "${id}" not found` };
      source = item.luaSource;
    }

    const outcome = await dryRunBackendScript(this.deps.luaRuntime, {
      luaSource: source,
      input,
      state,
      delegateResponse,
      history,
    });
    return { content: JSON.stringify(outcome) };
  }
}
