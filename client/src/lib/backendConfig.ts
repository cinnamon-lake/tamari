/**
 * Non-UI logic for BackendConfigModal: logit-bias text format, stop-string
 * serialization, providerParams building/seeding, and model-list fetching.
 * Kept pure (no signals, no DOM) so it is unit-testable; the component owns
 * only state and rendering.
 */

import { isDeclaredProviderParamKey } from '@tamari/types';
import { apiFetch } from './apiFetch.js';
import type { SamplerKnob } from '../components/samplerProfiles.js';

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
}

/**
 * Parse the logit-bias textarea: one `token:bias` pair per line. Lines without
 * a colon, with an empty token, or with a non-numeric bias are skipped; the
 * bias may itself contain colons (everything after the first colon is parsed
 * as the number, so those lines drop out as NaN). Returns null when nothing
 * valid remains, so an empty field clears the config value.
 */
export function parseLogitBias(text: string): Record<string, number> | null {
  const result: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [rawToken, ...rest] = trimmed.split(':');
    if (rawToken === undefined || rest.length === 0) continue;
    const token = rawToken.trim();
    const biasStr = rest.join(':').trim();
    const bias = Number(biasStr);
    if (token && !isNaN(bias)) {
      result[token] = bias;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** Inverse of parseLogitBias: one `token:bias` per line, '' for unset. */
export function formatLogitBias(bias: Record<string, number> | null | undefined): string {
  if (!bias) return '';
  return Object.entries(bias)
    .map(([k, v]) => `${k}:${v}`)
    .join('\n');
}

/** Stop-strings textarea serialization: one per line, trimmed, blanks dropped. */
export function splitStopStrings(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the `providerParams` patch for saveConfig: only DECLARED keys survive
 * (@tamari/types providerParams contract) — structural keys are carried over from
 * the existing config, requestScript is always set, and for each rendered
 * advanced knob serialize its value — dropping it when empty/unset so unset
 * knobs do not pollute the request body. Checkboxes send only when true.
 * Undeclared keys (e.g. legacy v1 settings dumps) are NOT preserved; the
 * server repo sanitizes on write too, so they never come back.
 * Carries the per-knob `samplerDisabled` record (typed camelCase + advanced wire
 * keys) so the server can omit disabled samplers from the request.
 */
export function buildAdvancedProviderParams(
  existing: Record<string, unknown> | undefined,
  requestScriptValue: string,
  profile: SamplerKnob[],
  values: Record<string, unknown>,
  disabled: Record<string, true>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Carry over declared keys only (structural + escape-hatch params like cacheTTL
  // that the modal doesn't render); undeclared junk is dropped for good.
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (isDeclaredProviderParamKey(key)) result[key] = value;
  }
  result['requestScript'] = requestScriptValue;
  for (const knob of profile) {
    const raw = values[knob.wireName];
    const serialized =
      knob.serialize === 'jsonArray'
        ? Array.isArray(raw)
          ? raw
          : typeof raw === 'string'
            ? raw
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean)
            : []
        : raw;
    const isEmpty =
      serialized === null ||
      serialized === undefined ||
      serialized === '' ||
      (Array.isArray(serialized) && serialized.length === 0);
    if (isEmpty) {
      delete result[knob.wireName];
    } else {
      result[knob.wireName] = serialized;
    }
  }
  if (Object.keys(disabled).length > 0) {
    result['samplerDisabled'] = disabled;
  } else {
    delete result['samplerDisabled'];
  }
  return result;
}

/**
 * providerParams for save/create: advanced sampler knobs (existing keys
 * preserved) plus, for the `custom` provider, the selected Lua script and
 * its default delegate. Empty selections drop the key so the server falls
 * back to the active backend at generation time.
 */
export interface ProviderParamsInput {
  existing: Record<string, unknown> | undefined;
  requestScript: string;
  profile: SamplerKnob[];
  values: Record<string, unknown>;
  disabled: Record<string, true>;
  provider: string;
  customBackendId: string;
  delegateConfigId: string;
  mockScript: string;
  cacheMode: 'off' | 'auto' | 'manual';
  cacheDepth: number;
  cacheTTL: string;
}

export function buildProviderParams(input: ProviderParamsInput): Record<string, unknown> {
  const params = buildAdvancedProviderParams(
    input.existing,
    input.requestScript,
    input.profile,
    input.values,
    input.disabled,
  );
  if (input.provider === 'custom') {
    if (input.customBackendId) params['customBackendId'] = input.customBackendId;
    else delete params['customBackendId'];
    if (input.delegateConfigId) params['delegateConfigId'] = input.delegateConfigId;
    else delete params['delegateConfigId'];
  }
  if (input.provider === 'mock') {
    if (input.mockScript) params['mockScript'] = input.mockScript;
    else delete params['mockScript'];
  }
  if (input.provider === 'claude' || input.provider === 'openrouter') {
    // Off mode drops the keys entirely; an absent cacheMode reads as 'off'
    // server-side. cacheDepth is only meaningful in manual mode.
    if (input.cacheMode !== 'off') params['cacheMode'] = input.cacheMode;
    else delete params['cacheMode'];
    if (input.cacheMode === 'manual' && input.cacheDepth > 0) params['cacheDepth'] = input.cacheDepth;
    else delete params['cacheDepth'];
    if (input.cacheTTL.trim()) params['cacheTTL'] = input.cacheTTL.trim();
    else delete params['cacheTTL'];
  }
  return params;
}

/**
 * Seed the advanced-knob form state from a config's providerParams: knobs the
 * user explicitly set keep their value + enabled state. Knobs NOT in
 * providerParams get a real default value (for display) and are disabled
 * (not sent) until the user enables them.
 */
export function seedAdvancedParams(
  providerParams: Record<string, unknown> | undefined,
  profile: SamplerKnob[],
): { values: Record<string, unknown>; disabled: Record<string, true> } {
  const pp = { ...providerParams };
  const existingDisabled = (pp['samplerDisabled'] as Record<string, true> | undefined) ?? {};
  const seeded: Record<string, unknown> = { ...pp };
  const disabled: Record<string, true> = {};
  for (const knob of profile) {
    const wasSet = knob.wireName in pp;
    if (!wasSet && knob.default !== undefined) {
      seeded[knob.wireName] = knob.default;
    }
    if (!wasSet) {
      disabled[knob.wireName] = true;
    }
  }
  return { values: seeded, disabled: { ...existingDisabled, ...disabled } };
}

/** Fetch the provider's model list; throws on non-OK so callers can flag failure. */
export async function fetchModelList(): Promise<ModelInfo[]> {
  const res = await apiFetch('/api/models');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { items?: ModelInfo[] };
  return data.items ?? [];
}

/** Extract OpenRouter provider prefixes (`vendor/model` ids) from a model list. */
export function extractOpenRouterProviders(models: ModelInfo[]): string[] {
  const providers = new Set<string>();
  for (const m of models) {
    const slashIdx = m.id.indexOf('/');
    if (slashIdx > 0) providers.add(m.id.slice(0, slashIdx));
  }
  return Array.from(providers).sort();
}

/** Restrict a model list to one OpenRouter provider; '' means no filter. */
export function filterModelsByProvider(models: ModelInfo[], provider: string): ModelInfo[] {
  if (!provider) return models;
  return models.filter((m) => m.id.startsWith(provider + '/'));
}
