/**
 * AllTalk TTS adapter (erew123/alltalk_tts, v2 OpenAI-compatible endpoint).
 *
 * Endpoint: POST /v1/audio/speech  (OpenAI-compatible; model is ignored)
 * Auth:     none.
 * Response: raw audio bytes.
 *
 * The OpenAI endpoint validates `voice` against the 6 classic OpenAI names
 * (alloy/echo/fable/nova/onyx/shimmer); other names are rejected with 400.
 * Repo: https://github.com/erew123/alltalk_tts
 */

import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface AllTalkConfig {
  baseUrl: string;
  apiKey?: string;
  requestScript?: string;
}

const DEFAULT_VOICE = 'alloy';
const VOICES = ['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer'];

export class AllTalkAdapter implements TtsAdapter {
  readonly id = 'alltalk';
  readonly name = 'AllTalk';

  constructor(private config: AllTalkConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private async applyScript(url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    if (!this.config.requestScript) return { url, init };
    return applyRequestScript(url, init, this.config.requestScript);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      const { url, init } = await this.applyScript(`${this.baseUrl}/api/ready`, { signal });
      const res = await fetch(url, init);
      return res.ok;
    } catch (err) {
      logger.debug({ err }, 'AllTalk healthCheck failed');
      return false;
    }
  }

  async listVoices(_signal?: AbortSignal): Promise<TtsVoice[]> {
    return VOICES.map((v) => ({ id: v, name: v }));
  }

  async generate(
    text: string,
    voiceId: string,
    opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      model: 'tts-1',
      input: text,
      voice: voiceId || DEFAULT_VOICE,
      response_format: opts.format ?? 'mp3',
      speed: opts.extra?.speed ?? 1.0,
    };
    if (opts.extra) Object.assign(body, opts.extra);

    const { url, init } = await this.applyScript(`${this.baseUrl}/v1/audio/speech`, {
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
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
    const audio = new Uint8Array(await res.arrayBuffer());
    return { audio, contentType };
  }
}
