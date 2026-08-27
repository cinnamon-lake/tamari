import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService, type AuthSessionRow } from './AuthService.js';

/** In-memory session store double — tracks rows so issue/validate/revoke and
 * expiry sweeps can be exercised without SQLite. */
function memoryStore() {
  const rows = new Map<string, AuthSessionRow>();
  return {
    async create(session: AuthSessionRow) {
      rows.set(session.id, session);
    },
    async get(id: string) {
      return rows.get(id);
    },
    async delete(id: string) {
      rows.delete(id);
    },
    async deleteExpired(beforeEpochSec: number) {
      for (const [id, row] of rows) {
        if (row.expiresAt !== null && row.expiresAt < beforeEpochSec) rows.delete(id);
      }
    },
    all: () => rows,
  };
}

const SECRET = 'correct-horse-battery';

describe('AuthService: credentials', () => {
  let auth: AuthService;

  beforeEach(() => {
    auth = new AuthService(SECRET);
  });

  it('classifies the master secret', async () => {
    await expect(auth.classify('src', SECRET)).resolves.toBe('master');
  });

  it('rejects wrong secrets of any length', async () => {
    // Same/different lengths both go through the hashed compare.
    await expect(auth.classify('src', 'x')).resolves.toBeNull();
    await expect(auth.classify('src', `${SECRET}-but-longer`)).resolves.toBeNull();
  });

  it('records the credential kind for issued sessions', async () => {
    const store = memoryStore();
    const withSessions = new AuthService(SECRET, store);
    const issued = await withSessions.issueSession(SECRET);
    expect(issued).not.toBeNull();
    expect(issued!.token).toMatch(/^[0-9a-f]{12}\./);
    await expect(withSessions.classify('src', issued!.token)).resolves.toBe('session');
  });

  it('refuses session issuance with a wrong password', async () => {
    const store = memoryStore();
    const withSessions = new AuthService(SECRET, store);
    await expect(withSessions.issueSession('wrong')).resolves.toBeNull();
    expect(store.all().size).toBe(0);
  });

  it('revokes sessions; master tokens are not revocable', async () => {
    const store = memoryStore();
    const withSessions = new AuthService(SECRET, store);
    const issued = (await withSessions.issueSession(SECRET))!;
    await withSessions.revokeSession(issued.token);
    await expect(withSessions.classify('src', issued.token)).resolves.toBeNull();

    await expect(withSessions.revokeSession(SECRET)).resolves.toBe(false);
  });

  it('expires sessions past their TTL', async () => {
    let now = 1_000_000_000_000;
    const ttl = 1000;
    const store = memoryStore();
    const withSessions = new AuthService(SECRET, store, { now: () => now, sessionTtlMs: ttl });
    const issued = (await withSessions.issueSession(SECRET))!;
    expect((await withSessions.classify('s', issued.token)) ?? null).toBe('session');
    now += ttl + 1;
    await expect(withSessions.classify('s', issued.token)).resolves.toBeNull();
  });
});

describe('AuthService: brute-force lockout', () => {
  it('locks out after repeated failures from one source — even for valid passwords', async () => {
    const now = 0;
    const auth = new AuthService(SECRET, undefined, { now: () => now });
    for (let i = 0; i < 8; i++) {
      await expect(auth.classify('attacker', 'wrong')).resolves.toBeNull();
    }
    await expect(auth.classify('attacker', SECRET)).resolves.toBeNull();
    // Another source is unaffected.
    await expect(auth.classify('other', SECRET)).resolves.toBe('master');
  });

  it('forgives after the window passes', async () => {
    let now = 0;
    const auth = new AuthService(SECRET, undefined, { now: () => now });
    for (let i = 0; i < 8; i++) {
      await expect(auth.classify('attacker', 'wrong')).resolves.toBeNull();
    }
    now += 61_000; // ATTEMPT_WINDOW_MS (60s) has passed
    await expect(auth.classify('attacker', SECRET)).resolves.toBe('master');
  });

  it('clears failures on success', async () => {
    const auth = new AuthService(SECRET, undefined);
    // Seven failures (one below the threshold of 8)…
    for (let i = 0; i < 7; i++) {
      await expect(auth.classify('client', 'wrong')).resolves.toBeNull();
    }
    // …a success resets the bucket…
    await expect(auth.classify('client', SECRET)).resolves.toBe('master');
    // …so seven more failures still don't lock out.
    for (let i = 0; i < 7; i++) {
      await expect(auth.classify('client', 'wrong')).resolves.toBeNull();
    }
    await expect(auth.classify('client', SECRET)).resolves.toBe('master');
  });
});
