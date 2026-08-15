/**
 * Build the flat `backendSettings` map consumed by the backend adapter
 * factory (`backends/factory.ts`) from the global settings plus a BackendConfig.
 *
 * Extracted from GenerationService so other callers (e.g. the backend
 * workbench tool template) can build settings for a *candidate* config
 * without importing the full generation service.
 */

import type { BackendConfig } from '@tamari/types';
import { isDeclaredProviderParamKey } from '@tamari/types';

/**
 * Map a backend provider + generation mode to the settings key whose `*.params`
 * blob the adapter factory reads (`factory.ts`). Sampler values are merged into
 * this blob so they reach `config.params` and flow into the request body.
 */
export function paramsKeyForProvider(provider: string, generationMode: string): string {
  switch (provider) {
    case 'claude':
      return 'claude.params';
    case 'gemini':
      return 'gemini.params';
    case 'koboldcpp':
      return 'koboldcpp.params'; // factory reads koboldcpp.params ?? textgen.params
    case 'llamacpp':
    case 'tabbyapi':
      return 'textgen.params';
    case 'moonshot':
      return 'openai.params'; // factory reads moonshot.params ?? openai.params
    default:
      // openai, openrouter, and text-mode openai
      return generationMode === 'text' ? 'textgen.params' : 'openai.params';
  }
}

/**
 * Coerce the `providerParams.samplerDisabled` record into a key set. A knob
 * listed here is kept on the config but NOT sent to the provider (e.g. a model
 * that dropped `top_k`). Sparse — a knob's absence means it is enabled.
 */
function readSamplerDisabled(raw: unknown): Set<string> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return new Set(Object.keys(raw));
  }
  return new Set();
}

/**
 * Build the flat `backendSettings` map passed to `backendFactory.create`,
 * merging the active BackendConfig's connection fields, sampler knobs, and
 * providerParams into the right places.
 *
 * Sampler wiring (the fix): the typed knobs (temperature, topP, …) and the
 * advanced providerParams entries (mirostat, dry_*, etc.) are merged into the
 * provider's `*.params` blob — the only place the factory reads samplers from.
 * Without this, those values are stored and round-tripped to the UI but never
 * reach any adapter.
 *
 * `requestScript` stays a top-level key (the factory reads it there) and is
 * excluded from the params blob so it is not dumped into the request body.
 * `maxTokens`/`stopStrings`/`logitBias` have dedicated paths elsewhere and are
 * intentionally NOT merged into the generic params blob.
 */
export function buildBackendSettings(
  allSettings: Record<string, unknown>,
  backendConfig: BackendConfig | null | undefined,
): Record<string, unknown> {
  const backendSettings: Record<string, unknown> = { ...allSettings };
  if (!backendConfig) return backendSettings;

  backendSettings['backendProvider'] = backendConfig.backendProvider;
  backendSettings['model'] = backendConfig.model;
  backendSettings['generationMode'] = backendConfig.generationMode;
  backendSettings['instructTemplate'] = backendConfig.instructTemplate;
  if (backendConfig.apiUrl) backendSettings['apiUrl'] = backendConfig.apiUrl;
  if (backendConfig.apiKey) backendSettings['apiKey'] = backendConfig.apiKey;
  // Context length lives only on the config (koboldcpp's max_context_length
  // wire param + the {{maxContext}} macro); there is no global fallback.
  if (backendConfig.contextLength != null) backendSettings['contextLength'] = backendConfig.contextLength;

  // requestScript (and any other top-level-consumed providerParams key) flows
  // top-level; factory.ts reads `requestScript` directly at the top of create().
  for (const [key, value] of Object.entries(backendConfig.providerParams)) {
    if (backendSettings[key] === undefined) backendSettings[key] = value;
  }

  if (backendConfig.openrouterProvider) {
    backendSettings['openrouter.providerOrder'] = [backendConfig.openrouterProvider];
  }

  // Merge typed sampler knobs + advanced providerParams into the provider's
  // *.params blob so the factory hands them to the adapter as config.params.
  // Per-config values overwrite any same-named global params key.
  const paramsKey = paramsKeyForProvider(backendConfig.backendProvider, backendConfig.generationMode);
  const merged: Record<string, unknown> = {
    ...((backendSettings[paramsKey] as Record<string, unknown> | undefined) ?? {}),
  };

  // Per-knob disable record: a knob listed here is kept on the config but NOT
  // sent (e.g. a model that dropped top_k). Sparse — absent means enabled.
  // Typed knobs are keyed by camelCase; advanced knobs by their provider wire name.
  const disabled = readSamplerDisabled(backendConfig.providerParams.samplerDisabled);

  const typedSamplers: Record<string, unknown> = {
    temperature: backendConfig.temperature,
    topP: backendConfig.topP,
    topK: backendConfig.topK,
    minP: backendConfig.minP,
    topA: backendConfig.topA,
    repetitionPenalty: backendConfig.repetitionPenalty,
    frequencyPenalty: backendConfig.frequencyPenalty,
    presencePenalty: backendConfig.presencePenalty,
  };

  const advancedSamplers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(backendConfig.providerParams)) {
    // requestScript and mockScript are consumed top-level by the factory;
    // samplerDisabled is the disable record itself (metadata, never a sampler
    // to send). cacheMode/cacheDepth are consumed by ChatPromptAssembly
    // (BuildOptions.caching), never wire params. Anything v2 doesn't declare
    // (e.g. the v1 settings dumps on migrated configs) is not a wire param —
    // drop it (@tamari/types providerParams contract).
    if (
      key === 'requestScript' || key === 'custom.requestScript' || key === 'samplerDisabled' || key === 'mockScript' ||
      key === 'cacheMode' || key === 'cacheDepth'
    )
      continue;
    if (!isDeclaredProviderParamKey(key)) continue;
    advancedSamplers[key] = value;
  }

  for (const [key, value] of Object.entries({ ...typedSamplers, ...advancedSamplers })) {
    if (disabled.has(key)) continue;
    if (value === null || value === undefined) continue;
    merged[key] = value;
  }
  backendSettings[paramsKey] = merged;

  // logitBias has its own dedicated merge into both openai.params and textgen.params
  // (adapters read it from whichever blob they consume).
  if (backendConfig.logitBias && Object.keys(backendConfig.logitBias).length > 0) {
    const openAiExisting = (backendSettings['openai.params'] as Record<string, unknown> | undefined) ?? {};
    backendSettings['openai.params'] = { ...openAiExisting, logitBias: backendConfig.logitBias };
    const textgenExisting = (backendSettings['textgen.params'] as Record<string, unknown> | undefined) ?? {};
    backendSettings['textgen.params'] = { ...textgenExisting, logitBias: backendConfig.logitBias };
  }

  return backendSettings;
}
