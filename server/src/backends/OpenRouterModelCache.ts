/**
 * OpenRouter model cache.
 *
 * Fetches and caches the public `/models` list from OpenRouter.
 * TTL defaults to 5 minutes.
 */

import { logger } from '../lib/logger.js';
import { OpenRouterModelListSchema, type OpenRouterModel } from './types.js';

interface CacheEntry {
  fetchedAt: number;
  models: OpenRouterModel[];
}

export class OpenRouterModelCache {
  private cache: CacheEntry | null = null;
  private readonly ttlMs: number;
  private readonly baseUrl: string;

  constructor(options?: { baseUrl?: string; ttlMs?: number }) {
    this.baseUrl = (options?.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
  }

  /**
   * Return the full cached model list, fetching if necessary.
   */
  async listModels(): Promise<OpenRouterModel[]> {
    if (this.cache && Date.now() - this.cache.fetchedAt < this.ttlMs) {
      return this.cache.models;
    }

    const models = await this.fetchModels();
    this.cache = { fetchedAt: Date.now(), models };
    return models;
  }

  /**
   * Look up a single model by id.
   */
  async getModel(id: string): Promise<OpenRouterModel | undefined> {
    const models = await this.listModels();
    return models.find((m) => m.id === id);
  }

  /**
   * List models filtered to a given output modality (e.g. 'text', 'image', 'embeddings').
   */
  async listModelsByModality(outputModality: string): Promise<OpenRouterModel[]> {
    const models = await this.listModels();
    return models.filter((m) => {
      const outputs = m.architecture?.output_modalities ?? [];
      return outputs.includes(outputModality);
    });
  }

  /**
   * List provider names for a specific model.
   */
  async listProviders(modelId: string): Promise<string[]> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(modelId)}/endpoints`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { endpoints?: Array<{ provider_name?: string }> } };
      const endpoints = data.data?.endpoints ?? [];
      return endpoints.map((e) => e.provider_name).filter((n): n is string => Boolean(n));
    } catch (err) {
      logger.warn({ err }, 'OpenRouter provider-name fetch failed');
      return [];
    }
  }

  /**
   * Clear the in-memory cache. Useful for testing or forced refresh.
   */
  clear(): void {
    this.cache = null;
  }

  private async fetchModels(): Promise<OpenRouterModel[]> {
    const url = `${this.baseUrl}/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`OpenRouter /models returned HTTP ${res.status}`);
    }

    const raw: unknown = await res.json();
    const parsed = OpenRouterModelListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `OpenRouter /models parse failed: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      );
    }
    const models = parsed.data.data ?? [];

    // Sort by id for stable ordering
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  }
}
