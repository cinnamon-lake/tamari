/**
 * Name helpers for E2E specs.
 */

/**
 * Unique entity name: `<base> <epoch-ms> <rand>`. The timestamp makes names
 * unique across runs and workers; the random suffix guards against two calls
 * in the same millisecond (sequential creates inside one test).
 */
export function uniqueName(base: string): string {
  return `${base} ${Date.now()} ${Math.floor(Math.random() * 100000)}`;
}
