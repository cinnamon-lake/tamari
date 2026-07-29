/**
 * VITS adapter targeting Artrajz/vits-simple-api.
 *
 * The de-facto standard HTTP surface for the VITS family (it wraps VITS /
 * Bert-VITS2 / GPT-SoVITS behind one uniform API).
 *
 * Endpoint: POST /voice/vits
 * Auth:     optional X-API-KEY (if the server enabled api_key_enabled).
 * Voices:   numeric speaker id; GET /voice/speakers lists them (keyed by model type).
 * Response: raw audio bytes.
 *
 * Repo: https://github.com/Artrajz/vits-simple-api
 */

import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface VitsSimpleConfig {
  baseUrl: string;
  apiKey?: string;
  requestScript?: string;
}

type SpeakerEntry = { id: number; name?: string; lang?: string[] };

export class VitsSimpleApiAdapter implements TtsAdapter {
  readonly id = 'vits';
  readonly name = 'VITS (simple-api)';

  constructor(private config: VitsSimpleConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['X-API-KEY'] = this.config.apiKey;
    return h;
  }

  private async applyScript(url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    if (!this.config.requestScript) return { url, init };
    return applyRequestScript(url, init, this.config.requestScript);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      const { url, init } = await this.applyScript(`${this.baseUrl}/voice/speakers`, { signal });
      const res = await fetch(url, init);
      return res.ok;
    } catch (err) {
      logger.debug({ err }, 'VITS healthCheck failed');
      return false;
    }
  }

  async listVoices(signal?: AbortSignal): Promise<TtsVoice[]> {
    const { url, init } = await this.applyScript(`${this.baseUrl}/voice/speakers`, {
      headers: this.headers,
      signal,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`Failed to list voices: HTTP ${res.status} - ${text}`);
    }
    // Response is keyed by model type (VITS, BERT-VITS2, ...); flatten into one list.
    const data = (await res.json()) as Record<string, SpeakerEntry[] | undefined>;
    const voices: TtsVoice[] = [];
    for (const list of Object.values(data)) {
      if (!Array.isArray(list)) continue;
      for (const s of list) voices.push({ id: String(s.id), name: s.name ?? String(s.id), language: s.lang?.[0] });
    }
    return voices;
  }

  async generate(
    text: string,
    voiceId: string,
    opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      text,
      id: Number(voiceId) || 0,
      format: opts.format ?? 'wav',
      lang: 'auto',
      length: 1.0,
    };
    if (opts.extra) Object.assign(body, opts.extra);

    const { url, init } = await this.applyScript(`${this.baseUrl}/voice/vits`, {
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
    const contentType = res.headers.get('content-type') ?? 'audio/wav';
    const audio = new Uint8Array(await res.arrayBuffer());
    return { audio, contentType };
  }
}
