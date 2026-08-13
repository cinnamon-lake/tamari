/**
 * 010 — one-time migration: move message text from the legacy `content`
 * column into `extra.parts`.
 *
 * Moved from db/index.ts, where it ran as an ad-hoc boot-time migration.
 * Idempotent: skips rows that already have parts.
 */

import { str } from '../../lib/coerce.js';
import { getLogger } from '../../lib/logger.js';
import type { Migration } from '../runMigrations.js';

const log = getLogger('db');

const migration: Migration = {
  async up({ db }) {
    const rs = await db.execute(
      "SELECT id, content, extra FROM messages WHERE content != '' AND content IS NOT NULL",
    );
    let migrated = 0;
    for (const row of rs.rows) {
      const id = Number(row.id);
      const content = str(row.content);
      let extra: Record<string, unknown>;
      try {
        extra = JSON.parse(str(row.extra) || '{}') as Record<string, unknown>;
      } catch {
        extra = {};
      }
      const parts = extra.parts;
      if (!Array.isArray(parts) || parts.length === 0) {
        extra.parts = [{ type: 'text', text: content }];
        await db.execute({
          sql: 'UPDATE messages SET extra = ?, content = ? WHERE id = ?',
          args: [JSON.stringify(extra), '', id],
        });
        migrated++;
      }
    }
    if (migrated > 0) {
      log.info(`migrated ${migrated} messages from content to extra.parts`);
    }
  },
};

export default migration;
