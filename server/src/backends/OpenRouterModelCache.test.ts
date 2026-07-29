import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterModelCache } from './OpenRouterModelCache.js';

describe('OpenRouterModelCache', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  function mockModelsResponse(
    models: Array<{ id: string; name: string; architecture?: { output_modalities?: string[] } }>,
  ) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: models }),
    } as Response);
  }

  it('fetches and caches models', async () => {
    const cache = new OpenRouterModelCache({ ttlMs: 60_000 });
    mockModelsResponse([
      { id: 'openai/gpt-4o', name: 'GPT-4o', architecture: { output_modalities: ['text'] } },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', architecture: { output_modalities: ['text'] } },
    ]);

    const models = await cache.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]!.id).toBe('anthropic/claude-3.5-sonnet'); // sorted by id
    expect(models[1]!.id).toBe('openai/gpt-4o');

    // Second call should use cache (no additional fetch)
    const models2 = await cache.listModels();
    expect(models2).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('filters models by modality', async () => {
    const cache = new OpenRouterModelCache();
    mockModelsResponse([
      { id: 'openai/gpt-4o', name: 'GPT-4o', architecture: { output_modalities: ['text'] } },
      { id: 'stability/sd-xl', name: 'SD XL', architecture: { output_modalities: ['image'] } },
    ]);

    const textModels = await cache.listModelsByModality('text');
    expect(textModels).toHaveLength(1);
    expect(textModels[0]!.id).toBe('openai/gpt-4o');
  });

  it('looks up a single model by id', async () => {
    const cache = new OpenRouterModelCache();
    mockModelsResponse([{ id: 'openai/gpt-4o', name: 'GPT-4o' }]);

    const model = await cache.getModel('openai/gpt-4o');
    expect(model).toBeDefined();
    expect(model?.name).toBe('GPT-4o');

    const missing = await cache.getModel('unknown');
    expect(missing).toBeUndefined();
  });

  it('fetches providers for a model', async () => {
    const cache = new OpenRouterModelCache();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          endpoints: [{ provider_name: 'Anthropic' }, { provider_name: 'OpenRouter' }],
        },
      }),
    } as Response);

    const providers = await cache.listProviders('anthropic/claude-3.5-sonnet');
    expect(providers).toEqual(['Anthropic', 'OpenRouter']);
  });

  it('returns empty providers on failure', async () => {
    const cache = new OpenRouterModelCache();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const providers = await cache.listProviders('unknown');
    expect(providers).toEqual([]);
  });

  it('throws when fetch fails', async () => {
    const cache = new OpenRouterModelCache();
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    await expect(cache.listModels()).rejects.toThrow('Network error');
  });
});
