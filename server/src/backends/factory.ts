/**
 * Backend adapter factory.
 *
 * Consumes a typed `AdapterFactoryInput` (see `buildAdapterFactoryInput`) and
 * instantiates the appropriate adapter. Supports reverse proxy URLs and proxy
 * passwords — we do NOT validate API key formats because that breaks
 * legitimate proxy/local setups.
 */

import { OpenAIBackendAdapter } from './OpenAIBackendAdapter.js';
import { OpenRouterBackendAdapter } from './OpenRouterBackendAdapter.js';
import { ClaudeBackendAdapter } from './ClaudeBackendAdapter.js';
import { GeminiBackendAdapter } from './GeminiBackendAdapter.js';
import { TextCompletionBackendAdapter } from './TextCompletionBackendAdapter.js';
import { LlamaCppBackendAdapter } from './LlamaCppBackendAdapter.js';
import { MoonshotBackendAdapter } from './MoonshotBackendAdapter.js';

import { KoboldCppBackendAdapter } from './KoboldCppBackendAdapter.js';
import type { BackendAdapter } from './BackendAdapter.js';
import type { BackendConfig } from '@tamari/types';
import { buildBackendSettings } from './buildBackendSettings.js';
import { str } from '../lib/coerce.js';

/**
 * Async factory interface consumed by services (GenerationService,
 * MemoryService, AgentTemplate). Implementations resolve secrets, build the
 * typed factory input, and create the adapter.
 */
export interface BackendAdapterFactory {
  create(settings: Record<string, unknown>): Promise<BackendAdapter | null>;
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
  /** Cache TTL for Claude prompt caching (direct or via OpenRouter). */
  cacheTTL?: string;
  contextLength?: number;
  openaiParams?: Record<string, unknown>;
  textgenParams?: Record<string, unknown>;
  claudeParams?: Record<string, unknown>;
  geminiParams?: Record<string, unknown>;
  koboldcppParams?: Record<string, unknown>;
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
    cacheTTL: parseOptionalString(settings['claudeCacheTTL']),
    contextLength: parseNumber(settings['contextLength']),
    openaiParams: parseParams(settings['openai.params']),
    textgenParams: parseParams(settings['textgen.params']),
    claudeParams: parseParams(settings['claude.params']),
    geminiParams: parseParams(settings['gemini.params']),
    koboldcppParams: parseParams(settings['koboldcpp.params']),
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

  // Providers that can work without an API key (local backends / custom proxies)
  const localProviders = new Set(['llamacpp', 'tabbyapi', 'koboldcpp']);
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

  if (input.provider === 'openrouter') {
    return new OpenRouterBackendAdapter({
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
      cacheTTL: input.cacheTTL,
    });
  }

  if (input.provider === 'claude') {
    return new ClaudeBackendAdapter({
      ...connection,
      params: input.claudeParams,
      cacheTTL: input.cacheTTL,
    });
  }

  if (input.provider === 'gemini') {
    return new GeminiBackendAdapter({
      ...connection,
      params: input.geminiParams,
    });
  }

  if (input.provider === 'llamacpp') {
    return new LlamaCppBackendAdapter({
      ...connection,
      params: input.textgenParams,
    });
  }

  if (input.provider === 'tabbyapi') {
    return new TextCompletionBackendAdapter({
      ...connection,
      params: input.textgenParams,
    });
  }

  // Text completion mode uses the generic /completions endpoint
  if (input.generationMode === 'text') {
    return new TextCompletionBackendAdapter({
      ...connection,
      params: input.textgenParams,
    });
  }

  if (input.provider === 'koboldcpp') {
    return new KoboldCppBackendAdapter({
      baseUrl: effectiveUrl,
      apiKey: effectiveKey,
      requestScript: input.requestScript,
      params: input.koboldcppParams ?? input.textgenParams,
      contextLength: input.contextLength ?? 4096,
    });
  }

  if (input.provider === 'moonshot') {
    return new MoonshotBackendAdapter({
      ...connection,
      // buildBackendSettings maps moonshot to the openai.params blob
      // (paramsKeyForProvider); there is no separate moonshot.params key.
      params: input.openaiParams,
    });
  }

  return new OpenAIBackendAdapter({
    ...connection,
    params: input.openaiParams,
  });
}

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
