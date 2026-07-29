/**
 * GPT-SoVITS adapter (RVC-Boss/GPT-SoVITS, `api_v2.py`).
 *
 * Endpoint: POST /tts
 * Auth:     none.
 * Voices:   a "voice" is a reference-audio triple; there is no /speakers route
 *           upstream, so `voiceId` carries the **server-side ref-audio path**
 *           (prompt transcript is read from the tool's referenceText, if given).
 * Response: raw audio bytes (wav).
 *
 * Repo: https://github.com/RVC-Boss/GPT-SoVITS (api_v2.py)
 */

import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface GptSoVitsConfig {
  baseUrl: string;
  requestScript?: string;
}

export class GptSoVitsAdapter implements TtsAdapter {
  readonly id = 'gptsovits';
  readonly name = 'GPT-SoVITS';

  constructor(private config: GptSoVitsConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private async applyScript(url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    if (!this.config.requestScript) return { url, init };
    return applyRequestScript(url, init, this.config.requestScript);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    // GPT-SoVITS has no free probe without a configured ref-audio path; reachability
    // is best validated by generating. Best-effort check via /control.
    try {
      const { url, init } = await this.applyScript(`${this.baseUrl}/control`, { signal });
      const res = await fetch(url, init);
      return res.ok;
    } catch (err) {
      logger.debug({ err }, 'GPT-SoVITS healthCheck failed');
      return false;
    }
  }

  async listVoices(_signal?: AbortSignal): Promise<TtsVoice[]> {
    // No upstream /speakers route; the user supplies a ref-audio path as voiceId.
    return [];
  }

  async generate(
    text: string,
    voiceId: string,
    opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      text,
      text_lang: 'auto',
      // voiceId is the server-side reference audio path.
      ref_audio_path: voiceId,
      prompt_text: '',
      prompt_lang: 'auto',
      speed_factor: 1.0,
      media_type: 'wav',
    };
    if (opts.extra) Object.assign(body, opts.extra);

    const { url, init } = await this.applyScript(`${this.baseUrl}/tts`, {
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
