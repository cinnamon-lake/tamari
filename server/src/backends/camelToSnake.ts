/**
 * Convert common camelCase generation parameter keys to snake_case.
 *
 * OpenAI-compatible APIs (OpenAI, Claude, OpenRouter, TabbyAPI, etc.)
 * expect snake_case keys such as `top_p`, `frequency_penalty`, etc.
 * Our internal preset schema stores them as camelCase (`topP`, etc.)
 * so we need to translate at the adapter boundary.
 */

const CAMEL_TO_SNAKE: Record<string, string> = {
  maxTokens: 'max_tokens',
  maxCompletionTokens: 'max_completion_tokens',
  topP: 'top_p',
  topK: 'top_k',
  minP: 'min_p',
  topA: 'top_a',
  frequencyPenalty: 'frequency_penalty',
  presencePenalty: 'presence_penalty',
  repetitionPenalty: 'repetition_penalty',
  logitBias: 'logit_bias',
  stopStrings: 'stop',
  stopSequences: 'stop',
  responseFormat: 'response_format',
  toolChoice: 'tool_choice',
  reasoningEffort: 'reasoning_effort',
  cacheDepth: 'cache_depth',
  cacheTTL: 'cache_ttl',
  strictTools: 'strict_tools',
};

/**
 * Return a new params object with camelCase keys converted to snake_case.
 * Unknown keys are passed through unchanged so that provider-specific
 * overrides (e.g. `dry_multiplier`) are preserved.
 */
export function convertParamsToSnakeCase(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const snake = CAMEL_TO_SNAKE[key] ?? key;
    result[snake] = value;
  }
  return result;
}
