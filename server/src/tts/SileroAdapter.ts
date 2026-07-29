/**
 * Silero TTS adapter.
 *
 * Silero ships no official HTTP server; this targets the popular open wrapper
 * `ouoertheo/silero-api-server` (the wrapper SillyTavern points users at).
 *
 * Endpoint: POST /tts/generate
 * Auth:     none.
 * Voices:   dynamic from the loaded Silero model; GET /tts/speakers lists them.
 * Response: raw WAV bytes (48kHz 16-bit mono).
 *
 * Wrapper: https://github.com/ouoertheo/silero-api-server
 */

import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface SileroConfig {
  baseUrl: string;
  requestScript?: string;
}

const DEFAULT_SPEAKER = 'en_0';

export class SileroAdapter implements TtsAdapter {
  readonly id = 'silero';
  readonly name = 'Silero';

  constructor(private config: SileroConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private async applyScript(url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    if (!this.config.requestScript) return { url, init };
    return applyRequestScript(url, init, this.config.requestScript);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      const { url, init } = await this.applyScript(`${this.baseUrl}/tts/speakers`, { signal });
      const res = await fetch(url, init);
      return res.ok;
    } catch (err) {
      logger.debug({ err }, 'Silero healthCheck failed');
      return false;
    }
  }

  async listVoices(signal?: AbortSignal): Promise<TtsVoice[]> {
    const { url, init } = await this.applyScript(`${this.baseUrl}/tts/speakers`, { signal });
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`Failed to list voices: HTTP ${res.status} - ${text}`);
    }
    const data = (await res.json()) as Array<{ name?: string; voice_id?: string; preview_url?: string }>;
    return data.map((v) => ({ id: v.voice_id ?? v.name ?? '', name: v.name ?? v.voice_id ?? '', previewUrl: v.preview_url }));
  }

  async generate(
    text: string,
    voiceId: string,
    _opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      speaker: voiceId || DEFAULT_SPEAKER,
      text,
      session: 'tamari',
    };

    const { url, init } = await this.applyScript(`${this.baseUrl}/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      const t = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`TTS generation failed: HTTP ${res.status} - ${t}`);
    }
    const contentType = res.headers.get('content-type') ?? 'audio/wav';
    const audio = new Uint8Array(await res.arrayBuffer());
    return { audio, contentType };
  }
}
