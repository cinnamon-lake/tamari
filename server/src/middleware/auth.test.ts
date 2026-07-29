import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthMiddleware } from './auth.js';
import type { AuthService } from '../services/AuthService.js';

function createApp(auth: AuthService) {
  const app = express();
  app.get('/health', (_req, res) => res.send('ok'));
  app.use('/api', createAuthMiddleware(auth));
  app.get('/api/protected', (_req, res) => res.json({ ok: true }));
  app.get('/api/characters/:id/assets/:assetId', (_req, res) => res.json({ public: true }));
  return app;
}

describe('createAuthMiddleware', () => {
  let validate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    validate = vi.fn();
  });

  it('allows /health without a token', async () => {
    validate.mockReturnValue(false);
    const app = createApp({ validate } as unknown as AuthService);
    await request(app).get('/health').expect(200);
    expect(validate).not.toHaveBeenCalled();
  });

  it('allows character asset URLs without a token', async () => {
    validate.mockReturnValue(false);
    const app = createApp({ validate } as unknown as AuthService);
    const res = await request(app).get('/api/characters/123/assets/logo.png').expect(200);
    expect(res.body).toEqual({ public: true });
    expect(validate).not.toHaveBeenCalled();
  });

  it('accepts a valid Bearer token', async () => {
    validate.mockImplementation((token: string) => token === 'valid-token');
    const app = createApp({ validate } as unknown as AuthService);
    const res = await request(app)
      .get('/api/protected')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(validate).toHaveBeenCalledWith('valid-token');
  });

  it('accepts a valid token from the query string', async () => {
    validate.mockImplementation((token: string) => token === 'query-token');
    const app = createApp({ validate } as unknown as AuthService);
    const res = await request(app).get('/api/protected?token=query-token').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(validate).toHaveBeenCalledWith('query-token');
  });

  it('rejects an invalid token', async () => {
    validate.mockReturnValue(false);
    const app = createApp({ validate } as unknown as AuthService);
    const res = await request(app)
      .get('/api/protected')
      .set('Authorization', 'Bearer bad-token')
      .expect(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('rejects missing token', async () => {
    validate.mockReturnValue(false);
    const app = createApp({ validate } as unknown as AuthService);
    const res = await request(app).get('/api/protected').expect(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });
});
