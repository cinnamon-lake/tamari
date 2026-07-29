/**
 * Fish Audio S2 Pro TTS adapter.
 *
 * Targets the local `tools/api_server.py` or SGLang deployment.
 * Endpoints: GET /health, POST /tts, POST /references/add,
 *            GET /references/list, DELETE /references/delete
 */

import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult, TtsVoiceCloneInput } from './TtsAdapter.js';

export interface FishAudioS2Config {
  baseUrl: string;
  apiKey?: string;
  requestScript?: string;
}

export class FishAudioS2Adapter implements TtsAdapter {
  readonly id = 'fishaudio';
  readonly name = 'Fish Audio S2 Pro';

  constructor(private config: FishAudioS2Config) {}

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
      const { url, init } = await this.applyScript(`${this.baseUrl}/health`, { signal });
      const res = await fetch(url, init);
      if (!res.ok) return false;
      const data = (await res.json().catch((err) => {
        logger.debug({ err }, 'FishAudio healthCheck JSON parse failed');
        return {};
      })) as { status?: string };
      return data.status === 'ok';
    } catch (err) {
      logger.debug({ err }, 'FishAudio healthCheck failed');
      return false;
    }
  }

  async listVoices(signal?: AbortSignal): Promise<TtsVoice[]> {
    const { url, init } = await this.applyScript(`${this.baseUrl}/references/list`, {
      headers: this.headers,
      signal,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`Failed to list voices: HTTP ${res.status} - ${text}`);
    }
    const data = (await res.json()) as { reference_ids?: string[] };
    const ids = data.reference_ids ?? [];
    return ids.map((id) => ({ id, name: id }));
  }

  async generate(
    text: string,
    voiceId: string,
    opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      text,
      format: opts.format ?? 'wav',
      chunk_length: opts.chunkLength ?? 200,
      temperature: opts.temperature ?? 0.8,
      top_p: opts.topP ?? 0.8,
      repetition_penalty: opts.repetitionPenalty ?? 1.1,
      max_new_tokens: opts.maxNewTokens ?? 1024,
    };
    if (voiceId) {
      body.reference_id = voiceId;
    }
    if (opts.streaming !== undefined) {
      body.streaming = opts.streaming;
    }
    if (opts.seed !== undefined) {
      body.seed = opts.seed;
    }
    if (opts.extra) {
      Object.assign(body, opts.extra);
    }

    const { url, init } = await this.applyScript(`${this.baseUrl}/tts`, {
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

  async addVoice(input: TtsVoiceCloneInput, signal?: AbortSignal): Promise<void> {
    const formData = new FormData();
    formData.append('id', input.id);
    formData.append('text', input.text);
    const blob = new Blob([input.audio as Uint8Array<ArrayBuffer>], { type: input.mimeType ?? 'audio/wav' });
    formData.append('audio', blob, 'reference.wav');

    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const res = await fetch(`${this.baseUrl}/references/add`, {
      method: 'POST',
      headers,
      body: formData,
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`Failed to add voice: HTTP ${res.status} - ${text}`);
    }

    const data = (await res.json()) as { success?: boolean };
    if (data.success !== true) {
      throw new Error('Failed to add voice: server returned success=false');
    }
  }

  async deleteVoice(voiceId: string, signal?: AbortSignal): Promise<void> {
    const { url, init } = await this.applyScript(`${this.baseUrl}/references/delete`, {
      method: 'DELETE',
      headers: this.headers,
      body: JSON.stringify({ reference_id: voiceId }),
      signal,
    });
    const res = await fetch(url, init);

    if (!res.ok) {
      const text = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`Failed to delete voice: HTTP ${res.status} - ${text}`);
    }
  }
}
