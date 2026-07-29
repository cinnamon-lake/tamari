/**
 * MiniMax Text-to-Audio (T2A v2) adapter.
 *
 * Endpoint: POST /v1/t2a_v2
 * Auth:     Authorization: Bearer <key>
 * Response: JSON with **hex-encoded** audio in data.audio
 *           (NOT base64 — decode with Buffer.from(hex, 'hex')).
 *
 * Docs: https://platform.minimax.io/docs/api-reference/speech-t2a-http
 */

import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface MiniMaxConfig {
  baseUrl: string;
  apiKey?: string;
  requestScript?: string;
  model?: string;
}

const DEFAULT_MODEL = 'speech-02-hd';
const DEFAULT_VOICE = 'English_expressive_narrator';
// MiniMax exposes no public voice-list endpoint; offer a few documented system voices.
const STATIC_VOICES: TtsVoice[] = [
  { id: 'English_expressive_narrator', name: 'English Expressive Narrator' },
  { id: 'male-qn-qingse', name: 'Male Qingse (青涩)' },
  { id: 'female-shaonv', name: 'Female Shaonv (少女)' },
  { id: 'presenter_male', name: 'Presenter Male' },
  { id: 'presenter_female', name: 'Presenter Female' },
  { id: 'audiobook_male_1', name: 'Audiobook Male 1' },
  { id: 'audiobook_female_1', name: 'Audiobook Female 1' },
];

interface MiniMaxResponse {
  data?: { audio?: string; status?: number };
  base_resp?: { status_code?: number; status_msg?: string };
}

export class MiniMaxAdapter implements TtsAdapter {
  readonly id = 'minimax';
  readonly name = 'MiniMax';

  constructor(private config: MiniMaxConfig) {}

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
    // No free GET endpoint; probe with a one-character synthesis (validates auth + voice).
    try {
      await this.generate('.', DEFAULT_VOICE, {}, signal);
      return true;
    } catch (err) {
      logger.debug({ err }, 'MiniMax healthCheck failed');
      return false;
    }
  }

  async listVoices(_signal?: AbortSignal): Promise<TtsVoice[]> {
    return STATIC_VOICES;
  }

  async generate(
    text: string,
    voiceId: string,
    opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      text,
      output_format: 'hex',
      voice_setting: {
        voice_id: voiceId || DEFAULT_VOICE,
        speed: 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
    };
    if (opts.extra) Object.assign(body, opts.extra);

    const { url, init } = await this.applyScript(`${this.baseUrl}/v1/t2a_v2`, {
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
    const json = (await res.json()) as MiniMaxResponse;
    if (json.base_resp?.status_code !== 0) {
      throw new Error(`TTS generation failed: ${json.base_resp?.status_msg ?? 'unknown MiniMax error'}`);
    }
    const hex = json.data?.audio;
    if (!hex) throw new Error('TTS generation failed: MiniMax returned no audio data');
    return { audio: Buffer.from(hex, 'hex'), contentType: 'audio/mpeg' };
  }
}
