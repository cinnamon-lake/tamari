/**
 * Azure Cognitive Services Speech (text-to-speech REST) adapter.
 *
 * Endpoint: POST {region-host}/cognitiveservices/v1
 * Auth:     Ocp-Apim-Subscription-Key header.
 * Body:     SSML (application/ssml+xml); voice chosen via <voice name="ShortName">.
 * Format:   X-Microsoft-OutputFormat header (default mp3).
 * Response: raw audio bytes.
 *
 * The user sets `baseUrl` to their regional host, e.g.
 *   https://eastus.tts.speech.microsoft.com
 * Docs: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
 */

import { logger } from '../lib/logger.js';
import { applyRequestScript } from '../backends/RequestScript.js';
import type { TtsAdapter, TtsVoice, TtsGenerateOptions, TtsResult } from './TtsAdapter.js';

export interface AzureTtsConfig {
  baseUrl: string;
  apiKey?: string;
  requestScript?: string;
}

const DEFAULT_VOICE = 'en-US-JennyNeural';
const OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Derive an SSML xml:lang ("en-US") from a voice ShortName ("en-US-JennyNeural"). */
function langFromVoice(voice: string): string {
  const parts = voice.split('-');
  return parts[0] && parts[1] ? `${parts[0]}-${parts[1]}` : 'en-US';
}

export class AzureTtsAdapter implements TtsAdapter {
  readonly id = 'azure';
  readonly name = 'Azure Speech';

  constructor(private config: AzureTtsConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    return {
      'Ocp-Apim-Subscription-Key': this.config.apiKey ?? '',
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
      'User-Agent': 'tamari',
    };
  }

  private async applyScript(url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    if (!this.config.requestScript) return { url, init };
    return applyRequestScript(url, init, this.config.requestScript);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      const { url, init } = await this.applyScript(`${this.baseUrl}/cognitiveservices/voices/list`, {
        headers: this.headers,
        signal,
      });
      const res = await fetch(url, init);
      return res.ok;
    } catch (err) {
      logger.debug({ err }, 'Azure healthCheck failed');
      return false;
    }
  }

  async listVoices(signal?: AbortSignal): Promise<TtsVoice[]> {
    const { url, init } = await this.applyScript(`${this.baseUrl}/cognitiveservices/voices/list`, {
      headers: this.headers,
      signal,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch((err) => { logger.debug({ err }, 'TTS error body read failed'); return 'Unknown error'; });
      throw new Error(`Failed to list voices: HTTP ${res.status} - ${text}`);
    }
    const data = (await res.json()) as Array<{
      ShortName: string;
      DisplayName?: string;
      Locale?: string;
      Gender?: string;
    }>;
    return data.map((v) => ({
      id: v.ShortName,
      name: v.DisplayName ?? v.ShortName,
      language: v.Locale,
      description: v.Gender,
    }));
  }

  async generate(
    text: string,
    voiceId: string,
    _opts: TtsGenerateOptions = {},
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const voice = voiceId || DEFAULT_VOICE;
    const lang = langFromVoice(voice);
    const ssml = `<speak version="1.0" xml:lang="${lang}"><voice name="${voice}">${escapeXml(text)}</voice></speak>`;

    const { url, init } = await this.applyScript(`${this.baseUrl}/cognitiveservices/v1`, {
      method: 'POST',
      headers: this.headers,
      body: ssml,
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
