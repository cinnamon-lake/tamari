/**
 * Moonshot (Kimi) backend adapter.
 *
 * Moonshot's API is OpenAI-compatible. This adapter extends
 * OpenAIBackendAdapter with Moonshot-specific defaults and model listing.
 */

import { OpenAIBackendAdapter, type OpenAIAdapterConfig } from './OpenAIBackendAdapter.js';
import type { ModelInfo } from './BackendAdapter.js';
import { MoonshotModelListSchema } from './types.js';
import { logger } from '../lib/logger.js';

export type MoonshotAdapterConfig = OpenAIAdapterConfig;

const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'kimi-k2.6', name: 'Kimi K2.6', contextLength: 256000 },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', contextLength: 256000 },
  { id: 'kimi-k2-0905-preview', name: 'Kimi K2 (0905)', contextLength: 256000 },
  { id: 'kimi-k2-0711-preview', name: 'Kimi K2 (0711)', contextLength: 256000 },
  { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo', contextLength: 256000 },
  { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', contextLength: 256000 },
  { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo', contextLength: 256000 },
  { id: 'moonshot-v1-8k', name: 'Moonshot V1 8K', contextLength: 8192 },
  { id: 'moonshot-v1-32k', name: 'Moonshot V1 32K', contextLength: 32768 },
  { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K', contextLength: 131072 },
  { id: 'moonshot-v1-auto', name: 'Moonshot V1 Auto', contextLength: 131072 },
  { id: 'moonshot-v1-8k-vision-preview', name: 'Moonshot V1 8K Vision', contextLength: 8192 },
  { id: 'moonshot-v1-32k-vision-preview', name: 'Moonshot V1 32K Vision', contextLength: 32768 },
  { id: 'moonshot-v1-128k-vision-preview', name: 'Moonshot V1 128K Vision', contextLength: 131072 },
];

export class MoonshotBackendAdapter extends OpenAIBackendAdapter {
  readonly id = 'moonshot';

  constructor(config: MoonshotAdapterConfig) {
    super(config);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const url = `${this.config.baseUrl.replace(/\/$/, '')}/models`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });
      if (!response.ok) {
        return FALLBACK_MODELS;
      }
      const raw: unknown = await response.json();
      const parsed = MoonshotModelListSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.data) {
        return FALLBACK_MODELS;
      }
      return parsed.data.data.map((m) => ({
        id: m.id,
        name: m.id,
        contextLength: m.context_length ?? 131072,
      }));
    } catch (err) {
      logger.warn({ err }, 'Moonshot listModels failed, returning fallback');
      return FALLBACK_MODELS;
    }
  }
}
