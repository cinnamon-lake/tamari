import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TestHarness } from '../testing/TestHarness.js';
import { createModelsRouter } from './models.js';

vi.mock('../backends/factory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backends/factory.js')>()),
  createBackendAdapter: vi.fn(),
}));

import { createBackendAdapter } from '../backends/factory.js';
import type { SecretService } from '../services/SecretService.js';

const fakeSecretService = { get: vi.fn() } as unknown as SecretService;

function createApp(harness: TestHarness) {
  const app = express();
  app.use('/models', createModelsRouter(harness.deps.settings, harness.deps.backendConfigs, fakeSecretService, 'test-password'));
  return app;
}

describe('createModelsRouter', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    app = createApp(h);
    vi.mocked(createBackendAdapter).mockReset();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('returns an empty list when there is no active backend config', async () => {
    const res = await request(app).get('/models').expect(200);
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  it('returns models from the active backend adapter', async () => {
    const configId = 'cfg-1';
    await h.deps.backendConfigs.create(configId, {
      name: 'Test Config',
      description: '',
      backendProvider: 'openai',
      generationMode: 'chat',
      model: 'gpt-4',
      instructTemplate: '',
      providerParams: {},
    });
    await h.deps.settings.setValue('activeBackendConfigId', configId);

    vi.mocked(createBackendAdapter).mockReturnValue({
      listModels: vi.fn().mockResolvedValue([
        { id: 'model-1', name: 'Model One' },
        { id: 'model-2', name: 'Model Two' },
      ]),
    } as unknown as ReturnType<typeof createBackendAdapter>);

    const res = await request(app).get('/models').expect(200);
    expect(res.body).toEqual({
      items: [
        { id: 'model-1', name: 'Model One' },
        { id: 'model-2', name: 'Model Two' },
      ],
      total: 2,
    });
  });

  it('returns 502 when the adapter throws', async () => {
    const configId = 'cfg-2';
    await h.deps.backendConfigs.create(configId, {
      name: 'Bad Config',
      description: '',
      backendProvider: 'openai',
      generationMode: 'chat',
      model: 'gpt-4',
      instructTemplate: '',
      providerParams: {},
    });
    await h.deps.settings.setValue('activeBackendConfigId', configId);

    vi.mocked(createBackendAdapter).mockReturnValue({
      listModels: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as ReturnType<typeof createBackendAdapter>);

    const res = await request(app).get('/models').expect(502);
    expect(res.body.error).toBe('Failed to fetch models');
  });
});
