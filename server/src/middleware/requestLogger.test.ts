import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestLogger } from './requestLogger.js';

const childMock = {
  info: vi.fn(),
  debug: vi.fn(),
  isLevelEnabled: vi.fn().mockReturnValue(false),
};

vi.mock('../lib/logger.js', () => ({
  getLogger: vi.fn(() => ({ child: vi.fn(() => childMock) })),
}));

import { getLogger } from '../lib/logger.js';

describe('requestLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLogger).mockClear();
    childMock.isLevelEnabled.mockReturnValue(false);
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(requestLogger());
    app.get('/test', (_req, res) => res.status(200).json({ ok: true }));
    app.post('/login', (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  it('sets an x-request-id response header', async () => {
    const app = createApp();
    const res = await request(app).get('/test').expect(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(typeof res.headers['x-request-id']).toBe('string');
  });

  it('propagates an existing x-request-id header', async () => {
    const app = createApp();
    const res = await request(app).get('/test').set('x-request-id', 'existing-id').expect(200);
    expect(res.headers['x-request-id']).toBe('existing-id');
  });

  it('logs request completion at info level', async () => {
    const app = createApp();
    await request(app).get('/test').expect(200);
    expect(childMock.info).toHaveBeenCalledTimes(1);
    const call = childMock.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.method).toBe('GET');
    expect(call.path).toBe('/test');
    expect(call.status).toBe(200);
    expect(call).toHaveProperty('duration_ms');
  });

  it('redacts sensitive body fields when debug logging is enabled', async () => {
    childMock.isLevelEnabled.mockReturnValue(true);
    const app = createApp();
    await request(app)
      .post('/login')
      .send({ apiKey: 'super-secret', user: 'me', password: 'hunter2' })
      .expect(200);

    expect(childMock.debug).toHaveBeenCalled();
    const debugCall = childMock.debug.mock.calls.find(
      (c: any) => (c[0] as Record<string, unknown>).method === 'POST',
    );
    expect(debugCall).toBeDefined();
    const body = (debugCall![0] as Record<string, unknown>).body as Record<string, string>;
    expect(body.apiKey).toBe('[REDACTED]');
    expect(body.password).toBe('[REDACTED]');
    expect(body.user).toBe('me');
  });
});
