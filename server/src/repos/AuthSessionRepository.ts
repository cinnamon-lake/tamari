/**
 * Auth sessions repository — rows backing AuthService's revocable session
 * tokens. Only SHA-256 hashes of the token secret are stored; the plaintext
 * half never touches disk (see server/src/db/migrations/018_auth_sessions.sql).
 */

import type { Client } from '@libsql/client';
import { AuthSessionRowSchema } from '@tamari/types';
import type { AuthSessionRow } from '@tamari/types';

export class AuthSessionRepository {
  constructor(private client: Client) {}

  async create(session: AuthSessionRow): Promise<void> {
    await this.client.execute({
      sql: 'INSERT INTO auth_sessions (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
      args: [session.id, session.tokenHash, session.createdAt, session.expiresAt],
    });
  }

  async get(id: string): Promise<AuthSessionRow | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM auth_sessions WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    const r = AuthSessionRowSchema.parse(rs.rows[0]);
    return {
      id: r.id,
      tokenHash: r.token_hash,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    };
  }

  async delete(id: string): Promise<void> {
    await this.client.execute({ sql: 'DELETE FROM auth_sessions WHERE id = ?', args: [id] });
  }

  async deleteExpired(beforeEpochSec: number): Promise<void> {
    await this.client.execute({
      sql: 'DELETE FROM auth_sessions WHERE expires_at IS NOT NULL AND expires_at < ?',
      args: [beforeEpochSec],
    });
  }
}
