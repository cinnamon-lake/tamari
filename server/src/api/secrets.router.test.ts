import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SecretService } from '../services/SecretService.js';
import { createSecretsRouter } from './secrets.js';

const PASSWORD = 'test-password';

function createSecretService() {
  return {
    list: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as SecretService;
}

function createApp(secretService: SecretService) {
  const app = express();
  app.use(express.json());
  app.use('/secrets', createSecretsRouter(secretService, PASSWORD));
  return app;
}

describe('createSecretsRouter', () => {
  let secretService: ReturnType<typeof createSecretService>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    secretService = createSecretService();
    app = createApp(secretService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET / returns the vault entries from the service', async () => {
    const entries = [{ key: 'api_key', value: 'decrypted-value', label: 'OpenAI' }];
    vi.mocked(secretService.list).mockResolvedValue(entries);

    const res = await request(app).get('/secrets').expect(200);

    expect(res.body).toEqual(entries);
    expect(secretService.list).toHaveBeenCalledWith(PASSWORD);
  });

  it('POST / stores the secret and answers with a bare ack (no value echoed back)', async () => {
    const res = await request(app)
      .post('/secrets')
      .send({ key: 'api_key', value: 'super-secret-value', label: 'OpenAI' })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
    expect(secretService.set).toHaveBeenCalledWith('api_key', 'super-secret-value', PASSWORD, 'OpenAI');
  });

  it('POST / rejects an invalid body with 400 and does not touch the service', async () => {
    const res = await request(app).post('/secrets').send({ key: '', value: '' }).expect(400);

    expect(res.body.error).toBe('Invalid request body');
    expect(secretService.set).not.toHaveBeenCalled();
  });

  it('DELETE /:key deletes the secret and answers with a bare ack', async () => {
    const res = await request(app).delete('/secrets/api_key').expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(secretService.delete).toHaveBeenCalledWith('api_key', PASSWORD);
  });

  it('returns a generic 500 without internals when the service fails', async () => {
    vi.mocked(secretService.set).mockRejectedValue(new Error('cipher exploded with super-secret-value'));

    const res = await request(app)
      .post('/secrets')
      .send({ key: 'api_key', value: 'super-secret-value' })
      .expect(500);

    expect(res.body).toEqual({ error: 'Failed to set secret' });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
  });
});
