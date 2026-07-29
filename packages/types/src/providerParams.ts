/**
 * The `providerParams` contract.
 *
 * `BackendConfig.providerParams` is NOT a free-form key-value bag. v2 declares
 * exactly which keys may live there; everything else — above all the legacy v1
 * settings dumps that migrated configs carry (`groq_model`, `scenario_format`,
 * `proxy_password`, …) — is dropped at every boundary: repository writes,
 * the backend-settings funnel, and the client editor.
 *
 * Three kinds of keys are declared:
 *  1. STRUCTURAL — consumed by server machinery, never sent as samplers
 *     (requestScript, the custom-backend wiring, the samplerDisabled record).
 *  2. ADVANCED SAMPLER WIRE NAMES — the provider-native keys of the knobs in
 *     `client/src/components/samplerProfiles.ts` (KNOBS). Adding a UI knob
 *     means adding its wire names here too — a client test enforces the sync.
 *  3. ADAPTER PARAM KEYS — undocumented escape-hatch params adapters read from
 *     the params blob (`camelToSnake` maps them onto wire names).
 */

export const PROVIDER_PARAMS_STRUCTURAL_KEYS: readonly string[] = [
  'requestScript',
  'custom.requestScript',
  'samplerDisabled',
  'customBackendId',
  'delegateConfigId',
];

export const ADVANCED_SAMPLER_WIRE_NAMES: readonly string[] = [
  // Mirostat
  'mirostat_mode', 'mirostat', 'mirostat_tau', 'mirostat_eta',
  // Alternative samplers
  'typical_p', 'typical', 'tfs_z', 'tfs', 'penalty_alpha',
  // DRY
  'dry_multiplier', 'dry_base', 'dry_allowed_length', 'dry_penalty_last_n', 'dry_sequence_breakers',
  // XTC
  'xtc_threshold', 'xtc_probability',
  // Smoothing
  'smoothing_factor', 'smoothing_curve',
  // Dynamic temperature
  'dynatemp', 'min_temp', 'max_temp', 'dynatemp_exponent',
  // Decoding
  'seed', 'sampler_seed', 'ban_eos_token', 'skip_special_tokens', 'add_bos_token', 'banned_tokens',
  // Grammar
  'grammar', 'grammar_string',
];

export const ADAPTER_PARAM_KEYS: readonly string[] = ['cacheTTL', 'strictTools'];

const DECLARED_KEYS: ReadonlySet<string> = new Set([
  ...PROVIDER_PARAMS_STRUCTURAL_KEYS,
  ...ADVANCED_SAMPLER_WIRE_NAMES,
  ...ADAPTER_PARAM_KEYS,
]);

/** True when `key` is a declared providerParams key. */
export function isDeclaredProviderParamKey(key: string): boolean {
  return DECLARED_KEYS.has(key);
}

/**
 * Drop every undeclared key from a providerParams blob. Returns a new object;
 * undeclared keys are not v2's — respecting them is how legacy settings ended
 * up inside LLM request bodies.
 */
export function sanitizeProviderParams(
  providerParams: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!providerParams) return out;
  for (const [key, value] of Object.entries(providerParams)) {
    if (DECLARED_KEYS.has(key)) out[key] = value;
  }
  return out;
}
