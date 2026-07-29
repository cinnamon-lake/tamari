/**
 * Narrowing helper for untyped values from loosely-typed boundaries on the
 * client: server-broadcast settings blobs, message-extra, instruct-template /
 * regex-rule objects. Mirrors the server's `lib/coerce` so both sides narrow
 * identically and `no-base-to-string` stays satisfied without each call site
 * reimplementing a `typeof` guard.
 *
 * Passes through the safe primitives (`string` / `number` / `bigint` / `boolean`),
 * returning `fallback` for anything that would stringify as `[object Object]`.
 */
export function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return fallback;
}
