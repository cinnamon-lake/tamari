/**
 * Script blob repository — the global append-only KV store behind the
 * backend-script `store` global. Blobs are immutable; there is deliberately
 * no list/search/update — scripts look up by exact id, and keep their own
 * logical name→id mapping in their (branch-aware) state.
 */

import type { Client } from '@libsql/client';

const MAX_NAME = 60;
const MAX_CONTENT = 64 * 1024;

export interface IScriptBlobRepository {
  /** Append a blob; returns its id ("<name>#<seq>" — name is only a debug prefix). */
  put(name: string, content: string): Promise<string>;
  /** The blob's content, or null when no such id. */
  get(id: string): Promise<string | null>;
}

export class ScriptBlobRepository implements IScriptBlobRepository {
  constructor(private client: Client) {}

  async put(name: string, content: string): Promise<string> {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME) {
      throw new Error(`script blob name must be 1-${MAX_NAME} chars`);
    }
    if (typeof content !== 'string' || content.length > MAX_CONTENT) {
      throw new Error(`script blob content must be a string of at most ${MAX_CONTENT} chars`);
    }
    const tx = await this.client.transaction('write');
    try {
      const rs = await tx.execute('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM script_blobs');
      const seq = Number(rs.rows[0]!.next);
      const id = `${name}#${seq}`;
      await tx.execute({
        sql: 'INSERT INTO script_blobs (id, seq, content, created_at) VALUES (?, ?, ?, ?)',
        args: [id, seq, content, Date.now()],
      });
      await tx.commit();
      return id;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  async get(id: string): Promise<string | null> {
    const rs = await this.client.execute({ sql: 'SELECT content FROM script_blobs WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return null;
    return rs.rows[0]!.content as string; // TEXT NOT NULL column
  }
}
