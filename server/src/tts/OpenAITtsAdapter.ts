/**
 * OpenAI TTS adapter (Audio Speech API).
 *
 * Endpoint: POST /v1/audio/speech
 * Auth:     Authorization: Bearer <key>
 * Response: raw audio bytes (chunked).
 *
 * The built-in voice set has no list endpoint, so voices are a static enum.
 * Docs: https://platform.openai.com/docs/guides/text-to-speech
 */

import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface OpenAITtsConfig {
  baseUrl: string;
  apiKey?: string;
  requestScript?: string;
  model?: string;
}

const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';
const VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
];

export class OpenAITtsAdapter implements TtsAdapter {
  readonly id = 'openai';
  readonly name = 'OpenAI';

  constructor(private config: OpenAITtsConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private get model(): string {
    return this.config.model || DEFAULT_MODEL;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    return h;
  }

  private async applyScript(url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    if (!this.config.requestScript) return { url, init };
    return applyRequestScript(url, init, this.config.requestScript);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      const { url, init } = await this.applyScript(`${this.baseUrl}/v1/models`, { headers: this.headers, signal });
      const res = await fetch(url, init);
      return res.ok;
    } catch (err) {
      logger.debug({ err }, 'OpenAI TTS healthCheck failed');
      return false;
    }
  }

  async listVoices(_signal?: AbortSignal): Promise<TtsVoice[]> {
    // OpenAI exposes no voice-list endpoint; the built-in set is a fixed enum.
    return VOICES.map((v) => ({ id: v, name: v }));
  }

  async generate(
    text: string,
    voiceId: string,
    opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      voice: voiceId || DEFAULT_VOICE,
      response_format: opts.format ?? 'mp3',
      speed: opts.extra?.speed ?? 1.0,
    };
    if (opts.extra) Object.assign(body, opts.extra);

    const { url, init } = await this.applyScript(`${this.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      const t = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`TTS generation failed: HTTP ${res.status} - ${t}`);
    }
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
    const audio = new Uint8Array(await res.arrayBuffer());
    return { audio, contentType };
  }
}
