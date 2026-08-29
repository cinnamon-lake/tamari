import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthMiddleware, type AuthedRequest } from './auth.js';
import { AuthService, type AuthSessionRow, type AuthSessionStore } from '../services/AuthService.js';

const SECRET = 'middleware-test-secret';

function createApp(auth: AuthService) {
  const app = express();
  app.get('/health', (_req, res) => res.send('ok'));
  app.use('/api', createAuthMiddleware(auth));
  app.get('/api/protected', (req, res) => {
    res.json({ ok: true, kind: (req as AuthedRequest).authKind ?? null });
  });
  app.get('/api/characters/:id/assets/:assetId', (_req, res) => res.json({ public: true }));
  return app;
}

describe('createAuthMiddleware', () => {
  let auth: AuthService;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    auth = new AuthService(SECRET);
    app = createApp(auth);
  });

  it('allows /health without a token', async () => {
    await request(app).get('/health').expect(200);
  });

  it('allows character asset URLs without a token', async () => {
    const res = await request(app).get('/api/characters/123/assets/logo.png').expect(200);
    expect(res.body).toEqual({ public: true });
  });

  it('accepts the master secret as Bearer and records the credential kind', async () => {
    const res = await request(app).get('/api/protected').set('Authorization', `Bearer ${SECRET}`).expect(200);
    expect(res.body).toEqual({ ok: true, kind: 'master' });
  });

  it('accepts an issued session token and records its kind', async () => {
    // Session issuance needs a session store; use a bare in-memory one.
    const rows = new Map<string, AuthSessionRow>();
    const store: AuthSessionStore = {
      create: async (s) => void rows.set(s.id, s),
      get: async (id) => rows.get(id),
      delete: async (id) => void rows.delete(id),
      deleteExpired: async () => undefined,
    };
    const withSessions = new AuthService(SECRET, store);
    const issued = await withSessions.issueSession(SECRET);
    expect(issued).not.toBeNull();
    const res = await request(createApp(withSessions))
      .get('/api/protected')
      .set('Authorization', `Bearer ${issued!.token}`)
      .expect(200);
    expect(res.body.kind).toBe('session');
  });

  it('accepts a valid token from the query string', async () => {
    const res = await request(app)
      .get(`/api/protected?token=${encodeURIComponent(SECRET)}`)
      .expect(200);
    expect(res.body).toEqual({ ok: true, kind: 'master' });
  });

  it('rejects an invalid token', async () => {
    const res = await request(app).get('/api/protected').set('Authorization', 'Bearer bad-token').expect(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('rejects missing token', async () => {
    const res = await request(app).get('/api/protected').expect(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('locks a source out after repeated failures', async () => {
    // ATTEMPT_THRESHOLD is 8 in AuthService; a run of wrong passwords must
    // eventually flip to immediate lockout rejections (still 401, but
    // short-circuited before compare — observable via success being refused).
    for (let i = 0; i < 8; i++) {
      await request(app).get(`/api/protected?token=wrong-${i}`).expect(401);
    }
    // Even the CORRECT password is refused while locked out.
    await request(app)
      .get(`/api/protected?token=${encodeURIComponent(SECRET)}`)
      .expect(401);
  });
});
