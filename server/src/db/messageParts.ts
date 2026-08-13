/**
 * message_parts storage helpers.
 *
 * Message content parts live in the `message_parts` table (one row per part,
 * ordered by idx), NOT in the messages.extra JSON blob. The blob keeps only
 * small metadata (macroVars, tokenCount, swipe markers, …).
 *
 * These helpers are shared by ChatRepository (normal read/write paths) and
 * import-legacy (boot-time bulk inserts) so every writer splits parts the
 * same way.
 */

import type { InStatement, ResultSet } from '@libsql/client';
import type { ContentPart, MessageExtra } from '@tamari/types';
import { str } from '../lib/coerce.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('db');

/** Minimal executor satisfied by both libsql Client and Transaction. */
export interface SqlExecutor {
  execute(stmt: InStatement): Promise<ResultSet>;
}

/**
 * Split a MessageExtra into the storable blob (parts key removed) and the
 * part list to write into message_parts.
 */
export function splitExtraParts(extra: MessageExtra): { extraJson: string; parts: ContentPart[] } {
  const { parts, ...rest } = extra;
  return {
    extraJson: JSON.stringify(rest),
    parts: Array.isArray(parts) ? parts : [],
  };
}

/** Insert one row per part. Caller is responsible for any surrounding transaction. */
export async function insertMessageParts(
  q: SqlExecutor,
  messageId: number,
  parts: ContentPart[],
): Promise<void> {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    await q.execute({
      sql: 'INSERT INTO message_parts (message_id, idx, type, data) VALUES (?, ?, ?, ?)',
      args: [messageId, i, part.type, JSON.stringify(part)],
    });
  }
}

/** Replace all part rows for a message with the given parts. */
export async function replaceMessageParts(
  q: SqlExecutor,
  messageId: number,
  parts: ContentPart[],
): Promise<void> {
  await q.execute({ sql: 'DELETE FROM message_parts WHERE message_id = ?', args: [messageId] });
  await insertMessageParts(q, messageId, parts);
}

const PARTS_BATCH = 999; // SQLite host parameter limit

/**
 * Fetch parts for a set of messages in one batched query.
 * Returns a map message_id → ordered parts. Messages without rows are absent
 * from the map. Malformed rows are skipped (logged), never fatal.
 */
export async function fetchPartsByMessageId(
  q: SqlExecutor,
  messageIds: number[],
): Promise<Map<number, ContentPart[]>> {
  const byId = new Map<number, ContentPart[]>();
  if (messageIds.length === 0) return byId;

  for (let i = 0; i < messageIds.length; i += PARTS_BATCH) {
    const chunk = messageIds.slice(i, i + PARTS_BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    const rs = await q.execute({
      sql: `SELECT message_id, idx, data FROM message_parts WHERE message_id IN (${placeholders}) ORDER BY message_id, idx`,
      args: chunk,
    });
    for (const row of rs.rows) {
      const mid = Number(row.message_id);
      try {
        const part = JSON.parse(str(row.data)) as ContentPart;
        let list = byId.get(mid);
        if (!list) {
          list = [];
          byId.set(mid, list);
        }
        list.push(part);
      } catch {
        log.warn(`skipping malformed message_parts row (message_id=${mid}, idx=${String(Number(row.idx))})`);
      }
    }
  }
  return byId;
}
