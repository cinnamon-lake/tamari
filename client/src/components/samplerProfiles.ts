/**
 * Advanced sampler parameter profiles.
 *
 * Each profile is the set of sampler knobs rendered in the "Advanced Sampling"
 * section of BackendConfigModal for a given provider/generation-mode. Selection
 * mirrors `server/src/backends/factory.ts` adapter selection exactly.
 *
 * Wire names are **provider-native** — already in the form the adapter sends —
 * so the server only has to merge `providerParams` verbatim into the provider's
 * `*.params` blob (see `server/src/backends/buildBackendSettings.ts`). The adapters
 * either map them via their `paramMap` (KoboldCpp) or pass them straight through
 * to the request body (`convertParamsToSnakeCase` preserves unknown keys).
 *
 * Adding a knob = add a `KnobDef` entry with its per-profile wire names AND
 * register the wire names in `packages/types/src/providerParams.ts`
 * (ADVANCED_SAMPLER_WIRE_NAMES) — undeclared keys are stripped on write
 * (`samplerProfiles.sync.test.ts` enforces the sync).
 */

export type KnobType = 'number' | 'slider' | 'checkbox' | 'textarea' | 'list';
export type ProfileName = 'llamacpp' | 'text' | 'koboldcpp' | 'chat';
/** Visual knob groups — keys of `backendConfig.adv.group.*` in the i18n dictionary. */
export type SamplerGroup = 'mirostat' | 'samplers' | 'dry' | 'xtc' | 'smoothing' | 'dynatemp' | 'decoding' | 'grammar';

export interface SamplerKnob {
  /** Canonical id, stable across profiles. */
  id: string;
  /** Provider-native key written into `providerParams`. */
  wireName: string;
  /** i18n key suffix appended to `backendConfig.adv.`. */
  labelKey: string;
  type: KnobType;
  /** i18n key suffix for the visual sub-heading (`backendConfig.adv.group.`). */
  group: SamplerGroup;
  min?: number;
  max?: number;
  step?: number;
  /** Display-only default when no stored value; absent means "unset". */
  default?: number | boolean | string;
  /** i18n key suffix for a textarea/list placeholder (`backendConfig.adv.placeholder.`). */
  placeholderKey?: string;
  serialize: 'raw' | 'jsonArray';
}

/**
 * Canonical knob definition. `wire` maps each profile to the wire name that
 * profile's adapter expects; a profile omitting the key does not render it.
 */
interface KnobDef {
  id: string;
  labelKey: string;
  type: KnobType;
  group: SamplerGroup;
  min?: number;
  max?: number;
  step?: number;
  default?: number | boolean | string;
  placeholderKey?: string;
  serialize?: 'raw' | 'jsonArray';
  wire: Partial<Record<ProfileName, string>>;
}

const KNOBS: KnobDef[] = [
  // --- Mirostat ---
  {
    id: 'mirostatMode',
    labelKey: 'mirostatMode',
    type: 'number',
    group: 'mirostat',
    min: 0,
    max: 2,
    step: 1,
    wire: { llamacpp: 'mirostat_mode', text: 'mirostat_mode', koboldcpp: 'mirostat' },
  },
  {
    id: 'mirostatTau',
    labelKey: 'mirostatTau',
    type: 'slider',
    group: 'mirostat',
    min: 0,
    max: 10,
    step: 0.1,
    wire: { llamacpp: 'mirostat_tau', text: 'mirostat_tau', koboldcpp: 'mirostat_tau' },
  },
  {
    id: 'mirostatEta',
    labelKey: 'mirostatEta',
    type: 'slider',
    group: 'mirostat',
    min: 0,
    max: 1,
    step: 0.01,
    wire: { llamacpp: 'mirostat_eta', text: 'mirostat_eta', koboldcpp: 'mirostat_eta' },
  },

  // --- Alternative samplers ---
  {
    id: 'typicalP',
    labelKey: 'typicalP',
    type: 'slider',
    group: 'samplers',
    min: 0,
    max: 1,
    step: 0.01,
    wire: { llamacpp: 'typical_p', text: 'typical_p', koboldcpp: 'typical' },
  },
  {
    id: 'tfs',
    labelKey: 'tfs',
    type: 'slider',
    group: 'samplers',
    min: 0,
    max: 1,
    step: 0.01,
    // llama.cpp uses tfs_z; ooba/tabby use tfs; kobold uses tfs.
    wire: { llamacpp: 'tfs_z', text: 'tfs', koboldcpp: 'tfs' },
  },
  {
    id: 'penaltyAlpha',
    labelKey: 'penaltyAlpha',
    type: 'slider',
    group: 'samplers',
    min: 0,
    max: 2,
    step: 0.01,
    wire: { llamacpp: 'penalty_alpha', text: 'penalty_alpha', koboldcpp: 'penalty_alpha' },
  },

  // --- DRY ---
  {
    id: 'dryMultiplier',
    labelKey: 'dryMultiplier',
    type: 'slider',
    group: 'dry',
    min: 0,
    max: 5,
    step: 0.01,
    wire: { llamacpp: 'dry_multiplier', text: 'dry_multiplier', koboldcpp: 'dry_multiplier' },
  },
  {
    id: 'dryBase',
    labelKey: 'dryBase',
    type: 'slider',
    group: 'dry',
    min: 1,
    max: 4,
    step: 0.01,
    wire: { llamacpp: 'dry_base', text: 'dry_base', koboldcpp: 'dry_base' },
  },
  {
    id: 'dryAllowedLength',
    labelKey: 'dryAllowedLength',
    type: 'number',
    group: 'dry',
    min: 1,
    max: 20,
    step: 1,
    wire: { llamacpp: 'dry_allowed_length', text: 'dry_allowed_length', koboldcpp: 'dry_allowed_length' },
  },
  {
    id: 'dryPenaltyLastN',
    labelKey: 'dryPenaltyLastN',
    type: 'number',
    group: 'dry',
    min: 0,
    max: 2048,
    step: 1,
    wire: { llamacpp: 'dry_penalty_last_n', text: 'dry_penalty_last_n', koboldcpp: 'dry_penalty_last_n' },
  },
  {
    id: 'drySequenceBreakers',
    labelKey: 'drySequenceBreakers',
    type: 'list',
    group: 'dry',
    placeholderKey: 'drySequenceBreakers',
    serialize: 'jsonArray',
    wire: { llamacpp: 'dry_sequence_breakers', text: 'dry_sequence_breakers', koboldcpp: 'dry_sequence_breakers' },
  },

  // --- XTC ---
  {
    id: 'xtcThreshold',
    labelKey: 'xtcThreshold',
    type: 'slider',
    group: 'xtc',
    min: 0,
    max: 1,
    step: 0.01,
    wire: { llamacpp: 'xtc_threshold', text: 'xtc_threshold', koboldcpp: 'xtc_threshold' },
  },
  {
    id: 'xtcProbability',
    labelKey: 'xtcProbability',
    type: 'slider',
    group: 'xtc',
    min: 0,
    max: 1,
    step: 0.01,
    wire: { llamacpp: 'xtc_probability', text: 'xtc_probability', koboldcpp: 'xtc_probability' },
  },

  // --- Smoothing ---
  {
    id: 'smoothingFactor',
    labelKey: 'smoothingFactor',
    type: 'slider',
    group: 'smoothing',
    min: 0,
    max: 10,
    step: 0.01,
    wire: { llamacpp: 'smoothing_factor', text: 'smoothing_factor', koboldcpp: 'smoothing_factor' },
  },
  {
    id: 'smoothingCurve',
    labelKey: 'smoothingCurve',
    type: 'slider',
    group: 'smoothing',
    min: 0,
    max: 10,
    step: 0.01,
    wire: { llamacpp: 'smoothing_curve', text: 'smoothing_curve', koboldcpp: 'smoothing_curve' },
  },

  // --- Dynamic temperature ---
  {
    id: 'dynatemp',
    labelKey: 'dynatemp',
    type: 'checkbox',
    group: 'dynatemp',
    default: false,
    wire: { llamacpp: 'dynatemp', text: 'dynatemp', koboldcpp: 'dynatemp' },
  },
  {
    id: 'minTemp',
    labelKey: 'minTemp',
    type: 'slider',
    group: 'dynatemp',
    min: 0,
    max: 2,
    step: 0.01,
    wire: { llamacpp: 'min_temp', text: 'min_temp', koboldcpp: 'min_temp' },
  },
  {
    id: 'maxTemp',
    labelKey: 'maxTemp',
    type: 'slider',
    group: 'dynatemp',
    min: 0,
    max: 2,
    step: 0.01,
    wire: { llamacpp: 'max_temp', text: 'max_temp', koboldcpp: 'max_temp' },
  },
  {
    id: 'dynatempExponent',
    labelKey: 'dynatempExponent',
    type: 'slider',
    group: 'dynatemp',
    min: 0,
    max: 5,
    step: 0.01,
    wire: { llamacpp: 'dynatemp_exponent', text: 'dynatemp_exponent', koboldcpp: 'dynatemp_exponent' },
  },

  // --- Decoding (seed + special-token / banned-token control) ---
  {
    id: 'seed',
    labelKey: 'seed',
    type: 'number',
    group: 'decoding',
    // chat providers accept `seed`; kobold uses `sampler_seed`.
    wire: { llamacpp: 'seed', text: 'seed', koboldcpp: 'sampler_seed', chat: 'seed' },
  },
  {
    id: 'banEosToken',
    labelKey: 'banEosToken',
    type: 'checkbox',
    group: 'decoding',
    default: false,
    wire: { llamacpp: 'ban_eos_token', text: 'ban_eos_token', koboldcpp: 'ban_eos_token' },
  },
  {
    id: 'skipSpecialTokens',
    labelKey: 'skipSpecialTokens',
    type: 'checkbox',
    group: 'decoding',
    default: false,
    wire: { llamacpp: 'skip_special_tokens', text: 'skip_special_tokens', koboldcpp: 'skip_special_tokens' },
  },
  {
    id: 'addBosToken',
    labelKey: 'addBosToken',
    type: 'checkbox',
    group: 'decoding',
    default: false,
    wire: { llamacpp: 'add_bos_token', text: 'add_bos_token', koboldcpp: 'add_bos_token' },
  },
  {
    id: 'bannedTokens',
    labelKey: 'bannedTokens',
    type: 'list',
    group: 'decoding',
    placeholderKey: 'bannedTokens',
    serialize: 'jsonArray',
    wire: { llamacpp: 'banned_tokens', text: 'banned_tokens', koboldcpp: 'banned_tokens' },
  },

  // --- Grammar (GBNF constrained generation; local-LLM only) ---
  {
    id: 'grammarString',
    labelKey: 'grammarString',
    type: 'textarea',
    group: 'grammar',
    placeholderKey: 'grammar',
    wire: { llamacpp: 'grammar', text: 'grammar_string', koboldcpp: 'grammar' },
  },
];

/**
 * Default values for knobs that don't declare their own `default`.
 * These represent the "neutral/off" setting — the value the knob would have
 * if enabled but at its least-aggressive position. Used for display when a
 * knob is disabled (not sent).
 */
const KNOB_DEFAULTS: Record<string, number | boolean | string> = {
  mirostatMode: 0,
  mirostatTau: 5,
  mirostatEta: 0.3,
  typicalP: 1,
  tfs: 1,
  penaltyAlpha: 0,
  dryMultiplier: 0,
  dryBase: 1,
  dryAllowedLength: 20,
  dryPenaltyLastN: 0,
  xtcThreshold: 0.5,
  xtcProbability: 0,
  smoothingFactor: 0,
  smoothingCurve: 1,
  minTemp: 0,
  maxTemp: 2,
  dynatempExponent: 1,
  seed: -1,
  skipSpecialTokens: true,
};

function buildProfile(name: ProfileName): SamplerKnob[] {
  const knobs: SamplerKnob[] = [];
  for (const def of KNOBS) {
    const wireName = def.wire[name];
    if (!wireName) continue;
    knobs.push({
      id: def.id,
      labelKey: def.labelKey,
      type: def.type,
      group: def.group,
      min: def.min,
      max: def.max,
      step: def.step,
      default: def.default ?? KNOB_DEFAULTS[def.id],
      placeholderKey: def.placeholderKey,
      serialize: def.serialize ?? 'raw',
      wireName,
    });
  }
  return knobs;
}

const PROFILES: Record<ProfileName, SamplerKnob[]> = {
  llamacpp: buildProfile('llamacpp'),
  text: buildProfile('text'),
  koboldcpp: buildProfile('koboldcpp'),
  chat: buildProfile('chat'),
};

/**
 * Select the profile name matching the adapter `factory.ts` would build for the
 * given provider/generation-mode.
 */
export function selectProfile(provider: string, generationMode: 'chat' | 'text'): ProfileName {
  if (provider === 'llamacpp') return 'llamacpp';
  if (provider === 'koboldcpp') return 'koboldcpp';
  if (provider === 'tabbyapi' || generationMode === 'text') return 'text';
  return 'chat'; // openai, openrouter, claude, gemini, moonshot
}

/** The ordered knob list to render for the active provider/generation-mode. */
export function getSamplerProfile(provider: string, generationMode: 'chat' | 'text'): SamplerKnob[] {
  return PROFILES[selectProfile(provider, generationMode)];
}
