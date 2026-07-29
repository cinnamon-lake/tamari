/**
 * Parse a JSON column value with a Zod schema, returning a fallback on any
 * parse or validation failure. Used at the DB row → domain-object boundary
 * so a single corrupt or truncated row never crashes a list/get/snapshot read.
 *
 * Always log + degrade rather than throw: a bad row should not take down the
 * entire list (or, for the settings blob, client boot).
 */
import type { ZodType } from 'zod';
import { getLogger } from './logger.js';

const log = getLogger('safeJson');

export function safeParseJson<T>(value: unknown, schema: ZodType<T>, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return schema.parse(JSON.parse(value));
  } catch (err) {
    log.warn({ err, value: value.slice(0, 200) }, 'safeParseJson: parse failed, using fallback');
    return fallback;
  }
}
