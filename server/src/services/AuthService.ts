/**
 * Shared-secret authentication + revocable session tokens.
 *
 * Two credential kinds are accepted anywhere a bearer token is read:
 *   - master: `TAMARI_SECRET` verbatim. Full access, including vault
 *     plaintext (`GET /api/secrets` masks values for other credentials).
 *     Scripts (curl, mcp-call.sh) use this kind.
 *   - session: `<id>.<secret>` issued by POST /api/auth/session after the
 *     password was presented once. Revocable and expiring; the browser
 *     stores only this kind, so a leaked UI token cannot decrypt anything.
 *
 * The vault key remains PBKDF2(TAMARI_SECRET) (see SecretService) and never
 * crosses the wire.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getLogger } from '../lib/logger.js';

const log = getLogger('services/AuthService');

/** Hash both sides so `timingSafeEqual` always sees equal-length buffers —
 * a raw compare would short-circuit on length (the leak fixed in 2026-08). */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function hashSecretPart(secretPart: string): string {
  return createHash('sha256').update(secretPart, 'utf8').digest('hex');
}

export interface AuthSessionRow {
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface AuthSessionStore {
  create(session: AuthSessionRow): Promise<void>;
  get(id: string): Promise<AuthSessionRow | undefined>;
  delete(id: string): Promise<void>;
  /** Best-effort sweep of rows whose expiry has passed. */
  deleteExpired(beforeEpochSec: number): Promise<void>;
}

export interface IssuedSession {
  token: string;
  expiresAt: number;
}

export type AuthKind = 'master' | 'session';

// Brute-force friction: repeated bad credentials from one source inside the
// window lock that source out until the failures age out of the window.
// In-memory only — a restart forgives, which is the right trade for a
// single-operator app.
const ATTEMPT_WINDOW_MS = 60_000;
const ATTEMPT_THRESHOLD = 8;
const MAX_TRACKED_SOURCES = 10_000;

const SESSION_TTL_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;

/** `<id>.<secret>` with a 12-hex-char id — exactly what issueSession mints. */
const SESSION_ID_RE = /^[0-9a-f]{12}$/;

export class AuthService {
  private attempts = new Map<string, number[]>();
  private sessionTtlMs: number;
  private now: () => number;

  constructor(
    private secret: string,
    private sessions?: AuthSessionStore,
    opts?: { now?: () => number; sessionTtlMs?: number },
  ) {
    this.now = opts?.now ?? Date.now;
    this.sessionTtlMs = opts?.sessionTtlMs ?? SESSION_TTL_MS_DEFAULT;
  }

  /**
   * Validate a credential with per-source brute-force protection. `source`
   * is the peer address (or any stable bucket); undefined shares one global
   * bucket. Returns the credential kind, or null when rejected.
   */
  async classify(source: string | undefined, credential: string | undefined): Promise<AuthKind | null> {
    if (!credential || !this.secret) return null;
    const bucket = this.attemptBucket(source);
    this.pruneBucket(bucket);
    if (bucket.length >= ATTEMPT_THRESHOLD) {
      log.warn({ source: source ?? 'unknown' }, 'auth: source locked out, refusing without compare');
      return null;
    }
    const kind = await this.compareKind(credential);
    if (kind === null) {
      this.recordFailure(bucket);
      return null;
    }
    bucket.length = 0;
    return kind;
  }

  validate(source: string | undefined, credential: string | undefined): Promise<boolean> {
    return this.classify(source, credential).then((kind) => kind !== null);
  }

  // ---------- sessions ----------

  /** Exchange a successfully-presented password for a session token. */
  async issueSession(password: string, label?: string): Promise<IssuedSession | null> {
    if (!this.sessions || !constantTimeEquals(password, this.secret)) return null;
    const id = randomBytes(6).toString('hex');
    const secretPart = randomBytes(32).toString('base64url');
    const issuedAtMs = this.now();
    const expiresAt = issuedAtMs + this.sessionTtlMs;
    await this.sessions.create({
      id,
      tokenHash: hashSecretPart(secretPart),
      createdAt: Math.floor(issuedAtMs / 1000),
      expiresAt: Math.floor(expiresAt / 1000),
    });
    void this.sessions.deleteExpired(Math.floor(this.now() / 1000)).catch(() => undefined);
    if (label !== undefined && label !== '') log.info({ label }, 'auth: session issued');
    return { token: `${id}.${secretPart}`, expiresAt };
  }

  /** Revoke the session contained in `token`. Returns false for master tokens. */
  async revokeSession(token: string | undefined): Promise<boolean> {
    const parsed = parseSessionToken(token);
    if (!parsed || !this.sessions) return false;
    const row = await this.sessions.get(parsed.id);
    if (!row) return false;
    await this.sessions.delete(parsed.id);
    return true;
  }

  private async compareKind(credential: string): Promise<AuthKind | null> {
    if (constantTimeEquals(credential, this.secret)) return 'master';
    const parsed = parseSessionToken(credential);
    if (!parsed || !this.sessions) return null;
    const row = await this.sessions.get(parsed.id);
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt * 1000 <= this.now()) {
      await this.sessions.delete(parsed.id).catch(() => undefined);
      return null;
    }
    // Fixed-width hex digests — safe for timingSafeEqual's raw byte compare.
    // A malformed row (tampered DB) must read as "invalid", not throw.
    try {
      if (!timingSafeEqual(Buffer.from(hashSecretPart(parsed.secretPart)), Buffer.from(row.tokenHash))) return null;
    } catch {
      return null;
    }
    return 'session';
  }

  // ---------- brute-force tracking ----------

  private attemptBucket(source: string | undefined): number[] {
    const key = source ?? 'global';
    let bucket = this.attempts.get(key);
    if (!bucket) {
      if (this.attempts.size >= MAX_TRACKED_SOURCES) this.pruneStaleBuckets();
      bucket = [];
      this.attempts.set(key, bucket);
    }
    return bucket;
  }

  private pruneBucket(bucket: number[]): void {
    const cutoff = this.now() - ATTEMPT_WINDOW_MS;
    while (bucket.length > 0 && bucket[0]! <= cutoff) bucket.shift();
  }

  private recordFailure(bucket: number[]): void {
    bucket.push(this.now());
    if (bucket.length > ATTEMPT_THRESHOLD * 4) bucket.splice(0, bucket.length - ATTEMPT_THRESHOLD * 4);
  }

  private pruneStaleBuckets(): void {
    const cutoff = this.now() - ATTEMPT_WINDOW_MS;
    for (const [key, bucket] of this.attempts) {
      if (bucket.length === 0 || bucket[bucket.length - 1]! < cutoff) this.attempts.delete(key);
    }
  }
}

function parseSessionToken(token: string | undefined): { id: string; secretPart: string } | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const id = token.slice(0, dot);
  if (!SESSION_ID_RE.test(id)) return null;
  return { id, secretPart: token.slice(dot + 1) };
}
