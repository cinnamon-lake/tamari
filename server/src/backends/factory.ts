/**
 * Backend adapter factory.
 *
 * Consumes a typed `AdapterFactoryInput` (see `buildAdapterFactoryInput`) and
 * instantiates the appropriate adapter via the provider registry
 * (`registerBackendProvider`). Supports reverse proxy URLs and proxy
 * passwords — we do NOT validate API key formats because that breaks
 * legitimate proxy/local setups. Unknown provider ids THROW (the legacy
 * silent fallthrough to OpenAI is gone).
 */

import { OpenAIBackendAdapter } from './OpenAIBackendAdapter.js';
import { OpenRouterBackendAdapter } from './OpenRouterBackendAdapter.js';
import { ClaudeBackendAdapter } from './ClaudeBackendAdapter.js';
import { GeminiBackendAdapter } from './GeminiBackendAdapter.js';
import { TextCompletionBackendAdapter } from './TextCompletionBackendAdapter.js';
import { LlamaCppBackendAdapter } from './LlamaCppBackendAdapter.js';
import { MoonshotBackendAdapter } from './MoonshotBackendAdapter.js';

import { KoboldCppBackendAdapter } from './KoboldCppBackendAdapter.js';
import { MockBackendAdapter } from './MockBackendAdapter.js';
import type { BackendAdapter } from './BackendAdapter.js';
import type { BackendConfig } from '@tamari/types';
import { buildBackendSettings } from './buildBackendSettings.js';
import { getInstructTemplate, parseCustomInstructTemplates, type InstructTemplate } from './InstructTemplate.js';
import { str } from '../lib/coerce.js';

/**
 * Async factory interface consumed by services (GenerationRunner,
 * MemoryService, AgentTemplate). Implementations resolve secrets, build the
 * typed factory input, and create the adapter.
 */
export interface BackendAdapterFactory {
  create(settings: Record<string, unknown>): Promise<BackendAdapter | null>;
}

/** Resolved connection shared by every provider factory. */
interface ProviderConnection {
  baseUrl: string;
  apiKey: string;
  model: string;
  requestScript?: string;
}

/** Factory for one backend provider in the registry. */
export type ProviderAdapterFactory = (
  input: AdapterFactoryInput,
  connection: ProviderConnection,
) => BackendAdapter;

const PROVIDER_REGISTRY = new Map<string, ProviderAdapterFactory>();

/** Register (or replace) a backend provider. Built-ins register at module
    load; Lua/custom backends can register additional ids later. */
export function registerBackendProvider(id: string, factory: ProviderAdapterFactory): void {
  PROVIDER_REGISTRY.set(id, factory);
}

/** Provider ids known to the registry (for error messages and validation). */
export function knownBackendProviders(): string[] {
  return [...PROVIDER_REGISTRY.keys()];
}

/** OpenRouter-specific routing/reasoning options for `AdapterFactoryInput`. */
export interface OpenRouterFactoryOptions {
  transforms?: string[];
  plugins?: Array<{ id: string }>;
  providerOrder?: string[];
  allowFallbacks?: boolean;
  reasoningEffort?: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
  reasoningSummary?: 'auto' | 'concise' | 'detailed';
}

/**
 * Typed input for `createBackendAdapter`. Built once from the raw settings
 * map (plus an optional BackendConfig, merged via `buildBackendSettings`) by
 * `buildAdapterFactoryInput`, so the factory itself never touches stringly
 * settings keys.
 *
 * The per-provider `*Params` blobs are the single channel for sampler knobs:
 * `buildBackendSettings` merges the BackendConfig's typed samplers
 * (temperature, topP, minP, topA, repetitionPenalty, …) and advanced
 * providerParams into the blob for the active provider.
 */
export interface AdapterFactoryInput {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  generationMode: string;
  requestScript?: string;
  contextLength?: number;
  /** Instruct template name for text-completion adapters. */
  instructTemplate?: string;
  /** User-defined instruct templates (keyed by template ID). */
  customInstructTemplates?: Record<string, InstructTemplate>;
  /** Whether past reasoning blocks are inlined into flat text prompts. */
  reasoningAddToPrompts?: boolean;
  openaiParams?: Record<string, unknown>;
  textgenParams?: Record<string, unknown>;
  claudeParams?: Record<string, unknown>;
  geminiParams?: Record<string, unknown>;
  koboldcppParams?: Record<string, unknown>;
  /** Inline response script for the deterministic 'mock' provider. */
  mockScript?: string;
  openrouter: OpenRouterFactoryOptions;
}

/**
 * Build the typed factory input from the raw settings map. When a
 * `backendConfig` is given it is merged into the settings first via
 * `buildBackendSettings` (the single merge authority); callers that already
 * merged (e.g. GenerationService) pass the merged map with no config.
 */
export function buildAdapterFactoryInput(
  allSettings: Record<string, unknown>,
  backendConfig?: BackendConfig | null,
): AdapterFactoryInput {
  const settings = backendConfig ? buildBackendSettings(allSettings, backendConfig) : allSettings;

  return {
    provider: str(settings['backendProvider']),
    apiKey: str(settings['apiKey']),
    baseUrl: str(settings['apiUrl']),
    model: str(settings['model']),
    generationMode: str(settings['generationMode']),
    requestScript:
      parseOptionalString(settings['requestScript']) ?? parseOptionalString(settings['custom.requestScript']),
    contextLength: parseNumber(settings['contextLength']),
    instructTemplate: parseOptionalString(settings['instructTemplate']),
    customInstructTemplates: parseCustomInstructTemplates(settings['instructTemplates']),
    reasoningAddToPrompts: parseOptionalBoolean(settings['reasoningAddToPrompts']),
    openaiParams: parseParams(settings['openai.params']),
    textgenParams: parseParams(settings['textgen.params']),
    claudeParams: parseParams(settings['claude.params']),
    geminiParams: parseParams(settings['gemini.params']),
    koboldcppParams: parseParams(settings['koboldcpp.params']),
    mockScript: parseOptionalString(settings['mockScript']),
    openrouter: {
      transforms: parseStringArray(settings['openrouter.transforms']),
      plugins: parsePlugins(settings['openrouter.plugins']),
      providerOrder: parseStringArray(settings['openrouter.providerOrder']),
      allowFallbacks: parseOptionalBoolean(settings['openrouter.allowFallbacks']),
      reasoningEffort: parseReasoningEffort(settings['openrouter.reasoningEffort']),
      reasoningSummary: parseReasoningSummary(settings['openrouter.reasoningSummary']),
    },
  };
}

/** Shared text-formatting config for text-completion adapters: the adapter
    owns the chat→string flattening, so it needs the resolved template. */
function textFormatting(input: AdapterFactoryInput): { template: InstructTemplate; includeReasoning: boolean } {
  return {
    template: getInstructTemplate(input.instructTemplate, input.customInstructTemplates),
    includeReasoning: input.reasoningAddToPrompts ?? false,
  };
}

export function createBackendAdapter(
  input: AdapterFactoryInput,
  forModelListing = false,
): BackendAdapter | null {
  const canonicalUrls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    claude: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    moonshot: 'https://api.moonshot.ai/v1',
    llamacpp: 'http://localhost:8080',
    tabbyapi: 'http://localhost:5000',
    koboldcpp: 'http://localhost:5001',
  };

  const effectiveUrl = input.baseUrl || canonicalUrls[input.provider] || '';
  const effectiveKey = input.apiKey;

  // Providers that can work without an API key (local backends / custom
  // proxies / the deterministic mock — no network at all)
  const localProviders = new Set(['llamacpp', 'tabbyapi', 'koboldcpp', 'mock']);
  const needsKey = !localProviders.has(input.provider);

  // Only require a key when hitting a cloud provider. Local backends and
  // reverse proxies often don't need one. Skip key check for model listing
  // since some adapters fall back to static lists (Gemini, Moonshot) or hit
  // public endpoints (OpenRouter).
  if (!forModelListing && !effectiveKey && needsKey) {
    return null;
  }

  const connection = {
    baseUrl: effectiveUrl,
    apiKey: effectiveKey,
    model: input.model,
    requestScript: input.requestScript,
  };

  // Providers whose dedicated adapter always wins — even in text-completion
  // mode (this ordering preserves the legacy if-chain exactly).
  const factory = PROVIDER_REGISTRY.get(input.provider);
  if (factory && DIRECT_PROVIDERS.has(input.provider)) return factory(input, connection);

  // Text completion mode uses the generic /completions endpoint
  if (input.generationMode === 'text') {
    return new TextCompletionBackendAdapter({
      ...connection,
      params: input.textgenParams,
      ...textFormatting(input),
    });
  }

  if (factory) return factory(input, connection);

  // The legacy silent fallthrough to OpenAI is gone: unknown ids are
  // configuration errors and must be loud.
  throw new Error(
    `Unknown backend provider "${input.provider}". Known providers: ${[...PROVIDER_REGISTRY.keys()].join(', ')}`,
  );
}

/** Providers whose adapter preempts text-completion mode (legacy order). */
const DIRECT_PROVIDERS = new Set(['openrouter', 'claude', 'gemini', 'llamacpp', 'tabbyapi', 'mock']);

// ── Built-in providers ───────────────────────────────────────────────────

registerBackendProvider('openrouter', (input, connection) =>
  new OpenRouterBackendAdapter({
    ...connection,
    // OpenRouter extends OpenAIBackendAdapter and inherits its params dump;
    // the openai.params blob carries the per-config sampler knobs
    // (temperature, minP → min_p, topA → top_a, repetitionPenalty → …).
    params: input.openaiParams,
    transforms: input.openrouter.transforms,
    plugins: input.openrouter.plugins,
    providerOrder: input.openrouter.providerOrder,
    allowFallbacks: input.openrouter.allowFallbacks,
    reasoningEffort: input.openrouter.reasoningEffort,
    reasoningSummary: input.openrouter.reasoningSummary,
  }),
);

registerBackendProvider('claude', (input, connection) =>
  new ClaudeBackendAdapter({
    ...connection,
    params: input.claudeParams,
  }),
);

registerBackendProvider('gemini', (input, connection) =>
  new GeminiBackendAdapter({
    ...connection,
    params: input.geminiParams,
  }),
);

registerBackendProvider('llamacpp', (input, connection) =>
  new LlamaCppBackendAdapter({
    ...connection,
    params: input.textgenParams,
    ...textFormatting(input),
  }),
);

registerBackendProvider('tabbyapi', (input, connection) =>
  new TextCompletionBackendAdapter({
    ...connection,
    params: input.textgenParams,
    ...textFormatting(input),
  }),
);

registerBackendProvider('koboldcpp', (input, connection) =>
  new KoboldCppBackendAdapter({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    requestScript: connection.requestScript,
    params: input.koboldcppParams ?? input.textgenParams,
    contextLength: input.contextLength ?? 4096,
    ...textFormatting(input),
  }),
);

registerBackendProvider('moonshot', (input, connection) =>
  new MoonshotBackendAdapter({
    ...connection,
    // buildBackendSettings maps moonshot to the openai.params blob
    // (paramsKeyForProvider); there is no separate moonshot.params key.
    params: input.openaiParams,
  }),
);

registerBackendProvider('openai', (input, connection) =>
  new OpenAIBackendAdapter({
    ...connection,
    params: input.openaiParams,
  }),
);

// Deterministic scripted backend for headless card testing (no network; the
// canned responses live in the config's providerParams.mockScript).
registerBackendProvider('mock', (input) => new MockBackendAdapter(input.mockScript ?? ''));

function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim().length > 0)
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return undefined;
}

function parsePlugins(value: unknown): Array<{ id: string }> | undefined {
  if (Array.isArray(value))
    return value.filter((v): v is { id: string } => typeof v === 'object' && v !== null && 'id' in v);
  return undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) return parsed;
  }
  return undefined;
}

function parseParams(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

const REASONING_EFFORTS = new Set(['xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed']);

function parseReasoningEffort(value: unknown): 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none' | undefined {
  const s = (typeof value === 'string' ? value : '')
    .trim()
    .toLowerCase();
  if (REASONING_EFFORTS.has(s)) return s as 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
  return undefined;
}

function parseReasoningSummary(value: unknown): 'auto' | 'concise' | 'detailed' | undefined {
  const s = (typeof value === 'string' ? value : '')
    .trim()
    .toLowerCase();
  if (REASONING_SUMMARIES.has(s)) return s as 'auto' | 'concise' | 'detailed';
  return undefined;
}
