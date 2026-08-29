import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { MulterError } from 'multer';
import { errorHandler, apiError } from './errorHandler.js';

function createApp(throwFn: () => void) {
  const app = express();
  app.get('/trigger', () => throwFn());
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 500 with the flat error message in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/trigger').expect(500);
    expect(res.body).toEqual({ error: 'boom' });
  });

  it('uses status and message from an ApiError', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp(() => {
      throw apiError('NOT_FOUND', 'missing resource', 404);
    });
    const res = await request(app).get('/trigger').expect(404);
    expect(res.body).toEqual({ error: 'missing resource' });
  });

  it('passes ApiError details through to the client', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp(() => {
      throw apiError('INVALID_REQUEST', 'Invalid request body', 400, {
        details: { fieldErrors: { key: ['too short'] } },
      });
    });
    const res = await request(app).get('/trigger').expect(400);
    expect(res.body).toEqual({ error: 'Invalid request body', details: { fieldErrors: { key: ['too short'] } } });
  });

  it('hides internal details in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = createApp(() => {
      throw new Error('secret internals');
    });
    const res = await request(app).get('/trigger').expect(500);
    expect(res.body).toEqual({ error: 'An internal error occurred' });
  });

  it('does not redact deliberate ApiError messages in production, even at 5xx', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = createApp(() => {
      throw apiError('UPSTREAM_ERROR', 'Failed to fetch models', 502);
    });
    const res = await request(app).get('/trigger').expect(502);
    expect(res.body).toEqual({ error: 'Failed to fetch models' });
  });

  it('handles non-Error values gracefully', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error throw path
      throw 'oops';
    });
    const res = await request(app).get('/trigger').expect(500);
    expect(res.body).toEqual({ error: 'Unknown error' });
  });

  it('maps multer LIMIT_FILE_SIZE to 413 with a visible message, even in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = createApp(() => {
      throw new MulterError('LIMIT_FILE_SIZE');
    });
    const res = await request(app).get('/trigger').expect(413);
    expect(res.body).toEqual({ error: 'File too large' });
  });

  it('maps other multer errors to 400', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp(() => {
      throw new MulterError('LIMIT_UNEXPECTED_FILE', 'file');
    });
    const res = await request(app).get('/trigger').expect(400);
    expect(typeof res.body.error).toBe('string');
  });
});
