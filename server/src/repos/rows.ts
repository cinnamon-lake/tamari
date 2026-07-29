/**
 * Shared row-mapping helpers for repositories.
 *
 * List reads follow the same log-and-degrade philosophy as safeParseJson:
 * one corrupt row must not take down an entire list (or chat history) read,
 * so rows that fail validation are skipped with a warning. Single-row reads
 * (getById) stay strict and throw — a corrupt row you explicitly asked for
 * SHOULD error.
 */

import { getLogger } from '../lib/logger.js';

const log = getLogger('repos');

/**
 * Map DB rows to domain objects, skipping (and logging) any row that fails
 * validation instead of rejecting the whole read. `context` names the read
 * path for the log line (e.g. 'CharacterRepository.list').
 */
export function mapRowsLenient<T>(rows: unknown[], rowTo: (row: unknown) => T, context: string): T[] {
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(rowTo(row));
    } catch (err) {
      log.warn({ err, context }, 'skipping corrupt row');
    }
  }
  return out;
}
