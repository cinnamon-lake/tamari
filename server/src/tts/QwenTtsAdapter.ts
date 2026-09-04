/**
 * Qwen TTS adapter (DashScope / Qwen Cloud dialect).
 *
 * Endpoints:
 *   POST /api/v1/services/aigc/multimodal-generation/generation  — synthesize
 *   POST /api/v1/services/audio/tts/customization                — design a voice
 *   GET  /api/v1/services/audio/tts/customization                — list designed voices
 *   DELETE /api/v1/services/audio/tts/customization/{voice}      — delete a voice
 * Auth:     Authorization: Bearer <key>
 * Response: JSON envelope; the audio itself is fetched from `output.audio.url`
 *           (or taken from `output.audio.data` when it is base64-inlined).
 *
 * Works against both Qwen Cloud (dashscope) and local servers that speak the
 * same dialect, e.g. a Qwen3-TTS VoiceDesign checkpoint wrapper — point
 * `baseUrl` at the server. Note the local VoiceDesign servers reject
 * `language_type: "Auto"`, so set `language` explicitly for those.
 *
 * Voice-design voices are bound to their `target_model`; the `model` used for
 * synthesis must match it, exactly like the cloud API enforces.
 * Docs: https://docs.qwencloud.com/api-reference/speech-synthesis/qwen-tts
 *       https://docs.qwencloud.com/api-reference/speech-synthesis/voice-design/qwen/create-voice
 */

import { logger } from '../lib/logger.js';
import { BaseTtsAdapter } from './BaseTtsAdapter.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface QwenTtsConfig {
  baseUrl: string;
  apiKey?: string;
  requestScript?: string;
  /** Synthesis model, e.g. qwen3-tts-flash or a voice-design target model. */
  model?: string;
  /** `language_type` for synthesis (English, Chinese, ...). Empty = omit (cloud: Auto). */
  language?: string;
}

export interface QwenVoiceDesignInput {
  /** Text description of the voice (voice_prompt). */
  voicePrompt: string;
  /** Text spoken in the preview clip. */
  previewText: string;
  /** Keyword embedded in the generated voice name (optional). */
  preferredName?: string;
  /** Language code of the voice: zh, en, de, it, pt, es, ja, ko, fr, ru. */
  language?: string;
  /** Synthesis model the voice is bound to. Defaults to the adapter's model. */
  targetModel?: string;
  sampleRate?: number;
  responseFormat?: 'pcm' | 'wav' | 'mp3' | 'opus';
}

export interface QwenDesignedVoice {
  /** Generated voice name — pass it as `voiceId` to generate(). */
  voice: string;
  targetModel: string;
  previewAudio: Uint8Array;
  previewContentType: string;
}

const DEFAULT_MODEL = 'qwen3-tts-flash';
const DEFAULT_VOICE = 'Cherry';
const GENERATION_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
const CUSTOMIZATION_PATH = '/api/v1/services/audio/tts/customization';

/** Qwen TTS error carrying the envelope `code` (e.g. `BadRequest.VoiceNotFound`), when present. */
export class QwenTtsError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'QwenTtsError';
  }
}

/** Pull the `code` field out of a DashScope error body, if it is one. */
function errorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { code?: string };
    return parsed.code || undefined;
  } catch {
    return undefined;
  }
}

export class QwenTtsAdapter extends BaseTtsAdapter<QwenTtsConfig> implements TtsAdapter {
  readonly id = 'qwen';
  readonly name = 'Qwen';

  private get model(): string {
    return this.config.model || DEFAULT_MODEL;
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      // Local VoiceDesign servers expose a public /healthz; the cloud API has
      // no liveness route, so fall back to an authenticated probe.
      const probe = await this.applyScript(`${this.baseUrl}/healthz`, { signal });
      const res = await fetch(probe.url, probe.init);
      if (res.ok) return true;
      const { url, init } = await this.applyScript(`${this.baseUrl}${CUSTOMIZATION_PATH}`, {
        headers: this.headers,
        signal,
      });
      const list = await fetch(url, init);
      return list.ok;
    } catch (err) {
      logger.debug({ err }, 'Qwen TTS healthCheck failed');
      return false;
    }
  }

  async listVoices(signal?: AbortSignal): Promise<TtsVoice[]> {
    const { url, init } = await this.applyScript(`${this.baseUrl}${CUSTOMIZATION_PATH}`, {
      headers: this.headers,
      signal,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`Failed to list voices: HTTP ${res.status} - ${await this.errorBody(res)}`);
    }
    const data = (await res.json()) as {
      voices?: Array<{ voice: string; voice_prompt?: string; language?: string }>;
    };
    return (data.voices ?? []).map((v) => ({
      id: v.voice,
      name: v.voice,
      description: v.voice_prompt,
      language: v.language,
    }));
  }

  async deleteVoice(voiceId: string, signal?: AbortSignal): Promise<void> {
    const { url, init } = await this.applyScript(
      `${this.baseUrl}${CUSTOMIZATION_PATH}/${encodeURIComponent(voiceId)}`,
      { method: 'DELETE', headers: this.headers, signal },
    );
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`Failed to delete voice: HTTP ${res.status} - ${await this.errorBody(res)}`);
    }
  }

  async generate(
    text: string,
    voiceId: string,
    opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const input: Record<string, unknown> = {
      text,
      voice: voiceId || DEFAULT_VOICE,
    };
    if (this.config.language) input.language_type = this.config.language;
    // Provider-specific extras (e.g. `instructions` for instruct models) pass through.
    if (opts.extra) Object.assign(input, opts.extra);

    const { url, init } = await this.applyScript(`${this.baseUrl}${GENERATION_PATH}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ model: this.model, input }),
      signal,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await this.errorBody(res);
      throw new QwenTtsError(`TTS generation failed: HTTP ${res.status} - ${body}`, errorCode(body));
    }
    const data = (await res.json()) as {
      code?: string;
      message?: string;
      output?: { audio?: { url?: string; data?: string } };
    };
    if (data.code) {
      throw new QwenTtsError(`TTS generation failed: ${data.code} - ${data.message ?? 'Unknown error'}`, data.code);
    }
    const audio = data.output?.audio;
    if (audio?.data) {
      return { audio: new Uint8Array(Buffer.from(audio.data, 'base64')), contentType: 'audio/wav' };
    }
    if (!audio?.url) {
      throw new Error('TTS generation failed: response contains no audio url or data');
    }
    return this.fetchAudio(audio.url, signal);
  }

  /** Design a voice from a text description (voice-design / customization API). */
  async designVoice(input: QwenVoiceDesignInput, signal?: AbortSignal): Promise<QwenDesignedVoice> {
    const body: Record<string, unknown> = {
      model: 'qwen-voice-design',
      input: {
        action: 'create',
        target_model: input.targetModel || this.model,
        voice_prompt: input.voicePrompt,
        preview_text: input.previewText,
      },
    };
    const inputBody = body.input as Record<string, unknown>;
    if (input.preferredName) inputBody.preferred_name = input.preferredName;
    if (input.language) inputBody.language = input.language;
    if (input.sampleRate || input.responseFormat) {
      body.parameters = {
        ...(input.sampleRate ? { sample_rate: input.sampleRate } : {}),
        ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
      };
    }

    const { url, init } = await this.applyScript(`${this.baseUrl}${CUSTOMIZATION_PATH}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`Voice design failed: HTTP ${res.status} - ${await this.errorBody(res)}`);
    }
    const data = (await res.json()) as {
      code?: string;
      message?: string;
      output?: {
        voice?: string;
        target_model?: string;
        preview_audio?: { data?: string; response_format?: string };
      };
    };
    if (data.code) {
      throw new Error(`Voice design failed: ${data.code} - ${data.message ?? 'Unknown error'}`);
    }
    const output = data.output;
    if (!output?.voice || !output.preview_audio?.data) {
      throw new Error('Voice design failed: response contains no voice or preview audio');
    }
    return {
      voice: output.voice,
      targetModel: output.target_model ?? input.targetModel ?? this.model,
      previewAudio: new Uint8Array(Buffer.from(output.preview_audio.data, 'base64')),
      previewContentType: formatToMime(output.preview_audio.response_format ?? 'wav'),
    };
  }

  /** Fetch the generated clip. Audio routes require the same bearer token on local servers. */
  private async fetchAudio(audioUrl: string, signal?: AbortSignal): Promise<TtsResult> {
    const absolute = audioUrl.startsWith('http') ? audioUrl : `${this.baseUrl}${audioUrl}`;
    const { url, init } = await this.applyScript(absolute, { headers: this.headers, signal });
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`TTS audio fetch failed: HTTP ${res.status} - ${await this.errorBody(res)}`);
    }
    const contentType = res.headers.get('content-type') ?? 'audio/wav';
    return { audio: new Uint8Array(await res.arrayBuffer()), contentType };
  }

  private async errorBody(res: Response): Promise<string> {
    return res.text().catch((err) => {
      logger.debug({ err }, 'TTS error body read failed');
      return 'Unknown error';
    });
  }
}

function formatToMime(format: string): string {
  if (format === 'mp3') return 'audio/mpeg';
  if (format === 'opus') return 'audio/opus';
  if (format === 'pcm') return 'audio/pcm';
  return 'audio/wav';
}
