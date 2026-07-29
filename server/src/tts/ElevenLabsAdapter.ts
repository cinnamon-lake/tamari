/**
 * ElevenLabs TTS adapter.
 *
 * Endpoint: POST /v1/text-to-speech/{voice_id}?output_format=...
 * Auth:     xi-api-key header.
 * Response: raw audio bytes.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 */

import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface ElevenLabsConfig {
  baseUrl: string;
  apiKey?: string;
  requestScript?: string;
  model?: string;
}

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // "Rachel"
const DEFAULT_MODEL = 'eleven_multilingual_v2';

export class ElevenLabsAdapter implements TtsAdapter {
  readonly id = 'elevenlabs';
  readonly name = 'ElevenLabs';

  constructor(private config: ElevenLabsConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private get model(): string {
    return this.config.model || DEFAULT_MODEL;
  }

  private authHeaders(): Record<string, string> {
    return this.config.apiKey ? { 'xi-api-key': this.config.apiKey } : {};
  }

  private async applyScript(url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    if (!this.config.requestScript) return { url, init };
    return applyRequestScript(url, init, this.config.requestScript);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      const { url, init } = await this.applyScript(`${this.baseUrl}/v1/voices`, {
        headers: this.authHeaders(),
        signal,
      });
      const res = await fetch(url, init);
      return res.ok;
    } catch (err) {
      logger.debug({ err }, 'ElevenLabs healthCheck failed');
      return false;
    }
  }

  async listVoices(signal?: AbortSignal): Promise<TtsVoice[]> {
    const { url, init } = await this.applyScript(`${this.baseUrl}/v1/voices`, {
      headers: this.authHeaders(),
      signal,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`Failed to list voices: HTTP ${res.status} - ${text}`);
    }
    const data = (await res.json()) as {
      voices?: Array<{ voice_id: string; name?: string; category?: string; labels?: Record<string, string> }>;
    };
    return (data.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name ?? v.voice_id,
      description: v.labels?.description ?? v.category,
    }));
  }

  async generate(
    text: string,
    voiceId: string,
    opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const voice = voiceId || DEFAULT_VOICE_ID;
    const body: Record<string, unknown> = {
      text,
      model_id: this.model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
    };
    if (opts.extra) Object.assign(body, opts.extra);

    const { url, init } = await this.applyScript(
      `${this.baseUrl}/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(body),
        signal,
      },
    );
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
