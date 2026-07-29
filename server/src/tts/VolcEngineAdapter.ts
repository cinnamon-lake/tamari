/**
 * VolcEngine (ByteDance 火山引擎) TTS adapter — native OpenSpeech HTTP API.
 *
 * Endpoint: POST /api/v1/tts  (openspeech.bytedance.com)
 * Auth:     `Authorization: Bearer;<token>` — note the **semicolon** (no space),
 *           using a static Access Token from the OpenSpeech console.
 * Body:     deeply nested {app, user, audio, request}; appid + cluster come from
 *           config (cluster defaults to the standard "volcano_tts").
 * Response: JSON with **base64-encoded** audio in `data`.
 *
 * Docs: https://www.volcengine.com/docs/6561/1257584
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface VolcEngineConfig {
  baseUrl: string;
  apiKey?: string; // OpenSpeech Access Token
  appId?: string;
  cluster?: string;
  requestScript?: string;
}

const DEFAULT_VOICE = 'zh_female_wanwanxiaohe';
const DEFAULT_CLUSTER = 'volcano_tts';

interface VolcEngineResponse {
  code?: number; // 3000 = success
  message?: string;
  data?: string; // base64 audio
}

export class VolcEngineAdapter implements TtsAdapter {
  readonly id = 'volcengine';
  readonly name = 'VolcEngine';

  constructor(private config: VolcEngineConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    // VolcEngine uses a semicolon between "Bearer" and the token — not a space.
    return { 'Content-Type': 'application/json', Authorization: `Bearer;${this.config.apiKey ?? ''}` };
  }

  private async applyScript(url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    if (!this.config.requestScript) return { url, init };
    return applyRequestScript(url, init, this.config.requestScript);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    // No free GET endpoint; probe with a one-character synthesis.
    try {
      await this.generate('.', DEFAULT_VOICE, {}, signal);
      return true;
    } catch (err) {
      logger.debug({ err }, 'VolcEngine healthCheck failed');
      return false;
    }
  }

  async listVoices(_signal?: AbortSignal): Promise<TtsVoice[]> {
    // Voice catalog is docs-only; the user supplies a voice_type.
    return [];
  }

  async generate(
    text: string,
    voiceId: string,
    opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      app: { appid: this.config.appId ?? '', token: 'access_token', cluster: this.config.cluster || DEFAULT_CLUSTER },
      user: { uid: 'tamari' },
      audio: {
        voice_type: voiceId || DEFAULT_VOICE,
        encoding: 'mp3',
        rate: 24000,
        speed_ratio: 1,
        volume_ratio: 1,
        pitch_ratio: 1,
      },
      request: { reqid: randomUUID(), text, text_type: 'plain', operation: 'query' },
    };
    if (opts.extra) Object.assign(body, opts.extra);

    const { url, init } = await this.applyScript(`${this.baseUrl}/api/v1/tts`, {
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
    const json = (await res.json()) as VolcEngineResponse;
    if (json.code !== 3000) {
      throw new Error(`TTS generation failed: ${json.message ?? `VolcEngine code ${json.code ?? 'unknown'}`}`);
    }
    if (!json.data) throw new Error('TTS generation failed: VolcEngine returned no audio data');
    return { audio: Buffer.from(json.data, 'base64'), contentType: 'audio/mpeg' };
  }
}
