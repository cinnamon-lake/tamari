/**
 * Kokoro FastAPI TTS adapter.
 *
 * Targets the OpenAI-compatible endpoints exposed by
 * remsky/Kokoro-FastAPI and similar wrappers.
 *
 * Endpoints:
 *   GET  /audio/voices      — list voices
 *   POST /audio/speech      — generate speech (OpenAI-compatible)
 */

import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface KokoroFastApiConfig {
  baseUrl: string;
  apiKey?: string;
  requestScript?: string;
}

export class KokoroFastApiAdapter implements TtsAdapter {
  readonly id = 'kokoro';
  readonly name = 'Kokoro (FastAPI)';

  constructor(private config: KokoroFastApiConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      h['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return h;
  }

  private async applyScript(url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    if (!this.config.requestScript) return { url, init };
    return applyRequestScript(url, init, this.config.requestScript);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      const { url, init } = await this.applyScript(`${this.baseUrl}/audio/voices`, { signal });
      const res = await fetch(url, init);
      return res.ok;
    } catch (err) {
      logger.debug({ err }, 'Kokoro healthCheck failed');
      return false;
    }
  }

  async listVoices(signal?: AbortSignal): Promise<TtsVoice[]> {
    const { url, init } = await this.applyScript(`${this.baseUrl}/audio/voices`, {
      headers: this.headers,
      signal,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`Failed to list voices: HTTP ${res.status} - ${text}`);
    }
    const data = (await res.json()) as { voices?: Array<{ id: string; name?: string; description?: string; language?: string }> };
    const voices = data.voices ?? [];
    return voices.map((v) => ({
      id: v.id,
      name: v.name ?? v.id,
      description: v.description,
      language: v.language,
    }));
  }

  async generate(
    text: string,
    voiceId: string,
    opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      model: 'kokoro',
      input: text,
      voice: voiceId || 'af_heart',
      response_format: opts.format ?? 'wav',
      speed: opts.extra?.speed ?? 1.0,
    };

    const { url, init } = await this.applyScript(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
    });
    const res = await fetch(url, init);

    if (!res.ok) {
      const text = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`TTS generation failed: HTTP ${res.status} - ${text}`);
    }

    const contentType = res.headers.get('content-type') ?? 'audio/wav';
    const audio = new Uint8Array(await res.arrayBuffer());

    return { audio, contentType };
  }
}
