/**
 * 015 — one-time migration: move `extra.parts` out of the messages.extra JSON
 * blob into the message_parts table (created by 014).
 *
 * Idempotent: part rows are written with INSERT OR REPLACE, and processed rows
 * no longer have a `parts` key in extra, so a retry after a mid-run crash
 * simply re-processes the remaining rows.
 */

import { str } from '../../lib/coerce.js';
import { getLogger } from '../../lib/logger.js';
import type { Migration } from '../runMigrations.js';

const log = getLogger('db');

const migration: Migration = {
  async up({ db }) {
    const rs = await db.execute("SELECT id, extra FROM messages WHERE extra LIKE '%\"parts\"%'");
    let migrated = 0;
    for (const row of rs.rows) {
      const id = Number(row.id);
      let extra: Record<string, unknown>;
      try {
        extra = JSON.parse(str(row.extra) || '{}') as Record<string, unknown>;
      } catch {
        continue;
      }
      const parts = extra.parts;
      if (!Array.isArray(parts)) continue;

      const tx = await db.transaction('write');
      try {
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i] as Record<string, unknown> | null;
          const type = part && typeof part === 'object' && typeof part.type === 'string' ? part.type : 'unknown';
          await tx.execute({
            sql: 'INSERT OR REPLACE INTO message_parts (message_id, idx, type, data) VALUES (?, ?, ?, ?)',
            args: [id, i, type, JSON.stringify(part ?? null)],
          });
        }
        delete extra.parts;
        await tx.execute({
          sql: 'UPDATE messages SET extra = ? WHERE id = ?',
          args: [JSON.stringify(extra), id],
        });
        await tx.commit();
        migrated++;
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    }
    if (migrated > 0) {
      log.info(`migrated ${migrated} messages from extra.parts to message_parts`);
    }
  },
};

export default migration;
