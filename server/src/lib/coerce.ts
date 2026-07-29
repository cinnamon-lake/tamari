/**
 * Narrowing helper for untyped values from loosely-typed boundaries:
 * libsql {@link Row} columns (whose `Value` union includes `Uint8Array`, so
 * `String()` would yield `[object Object]`), JSON.parse results, settings
 * blobs, tool args, and message-extra. Centralized so call sites don't each
 * reimplement a `typeof` guard — and so `no-base-to-string` stays satisfied.
 *
 * Passes through the safe primitives (`string` / `number` / `bigint` / `boolean`),
 * returning `fallback` for anything that would stringify as `[object Object]`
 * (`Uint8Array`, plain objects, `null`, `undefined`, `symbol`).
 */
export function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return fallback;
}
