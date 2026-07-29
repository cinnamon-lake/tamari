import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackendConfigInsert } from '@tamari/types';
import { TestHarness } from '../testing/TestHarness.js';
import { BackendConfigRepository } from './BackendConfigRepository.js';

function makeInsert(overrides: Partial<BackendConfigInsert> = {}): BackendConfigInsert {
  return {
    name: 'Test',
    description: '',
    backendProvider: 'openai',
    generationMode: 'chat',
    model: 'gpt-4o',
    instructTemplate: '',
    providerParams: {},
    stopStrings: [],
    openrouterProvider: null,
    logitBias: null,
    ...overrides,
  };
}

describe('BackendConfigRepository providerParams contract', () => {
  let h: TestHarness;
  let repo: BackendConfigRepository;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    repo = new BackendConfigRepository(h.db);
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('create drops undeclared providerParams keys and keeps declared ones', async () => {
    const created = await repo.create('bc-1', makeInsert({
      providerParams: {
        seed: 42,
        mirostat_mode: 2,
        requestScript: '-- lua',
        samplerDisabled: { topK: true },
        customBackendId: 'cb-1',
        cacheTTL: '5m',
        // Undeclared legacy junk:
        groq_model: 'llama-3.3-70b-versatile',
        proxy_password: 'super-secret',
        scenario_format: '{{scenario}}',
        extensions: {},
      },
    }));

    expect(created.providerParams).toEqual({
      seed: 42,
      mirostat_mode: 2,
      requestScript: '-- lua',
      samplerDisabled: { topK: true },
      customBackendId: 'cb-1',
      cacheTTL: '5m',
    });

    // …and it is the stored row that is clean, not just the return value.
    const fetched = await repo.getById('bc-1');
    expect(fetched?.providerParams['proxy_password']).toBeUndefined();
    expect(fetched?.providerParams['groq_model']).toBeUndefined();
  });

  it('update sanitizes a providerParams patch', async () => {
    await repo.create('bc-2', makeInsert({ providerParams: { seed: 1 } }));
    const updated = await repo.update('bc-2', {
      providerParams: { typical_p: 0.9, reverse_proxy: 'https://proxy.example.com' },
    });
    expect(updated.providerParams).toEqual({ typical_p: 0.9 });
  });
});
