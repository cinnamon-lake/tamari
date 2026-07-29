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

  it('returns 500 with the error message in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp(() => {
      throw new Error('boom');
    });
    const res = await request(app).get('/trigger').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('boom');
  });

  it('uses status and code from an ApiError', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error throw path
      throw apiError('NOT_FOUND', 'missing resource', 404);
    });
    const res = await request(app).get('/trigger').expect(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'missing resource' });
  });

  it('hides internal details in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = createApp(() => {
      throw new Error('secret internals');
    });
    const res = await request(app).get('/trigger').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('An internal error occurred');
  });

  it('handles non-Error values gracefully', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error throw path
      throw 'oops';
    });
    const res = await request(app).get('/trigger').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('Unknown error');
  });

  it('maps multer LIMIT_FILE_SIZE to 413 with a visible message, even in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = createApp(() => {
      throw new MulterError('LIMIT_FILE_SIZE');
    });
    const res = await request(app).get('/trigger').expect(413);
    expect(res.body.error.code).toBe('LIMIT_FILE_SIZE');
    expect(res.body.error.message).toBe('File too large');
  });

  it('maps other multer errors to 400', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp(() => {
      throw new MulterError('LIMIT_UNEXPECTED_FILE', 'file');
    });
    const res = await request(app).get('/trigger').expect(400);
    expect(res.body.error.code).toBe('LIMIT_UNEXPECTED_FILE');
  });
});
