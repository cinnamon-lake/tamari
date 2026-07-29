/**
 * TTS adapter interface for text-to-speech providers.
 *
 * Designed for local-first TTS servers (Fish Audio S2, etc.)
 * and cloud providers (OpenAI, ElevenLabs, etc.).
 */

export interface TtsVoice {
  id: string;
  name: string;
  description?: string;
  language?: string;
  previewUrl?: string;
}

export interface TtsGenerateOptions {
  /** Output audio format */
  format?: 'wav' | 'mp3' | 'pcm';
  /** Sampling temperature (0.1–1.0) */
  temperature?: number;
  /** Nucleus sampling threshold (0.1–1.0) */
  topP?: number;
  /** Repetition penalty (0.9–2.0) */
  repetitionPenalty?: number;
  /** Chunk length for synthesis (100–300) */
  chunkLength?: number;
  /** Seed for reproducible output */
  seed?: number;
  /** Maximum new tokens */
  maxNewTokens?: number;
  /** Stream audio chunks in real-time */
  streaming?: boolean;
  /** Provider-specific extra parameters */
  extra?: Record<string, unknown>;
}

export interface TtsResult {
  /** Raw audio bytes */
  audio: Uint8Array;
  /** MIME type of the audio */
  contentType: string;
  /** Optional provider-specific metadata */
  meta?: Record<string, unknown>;
}

export interface TtsVoiceCloneInput {
  id: string;
  /** Reference audio bytes */
  audio: Uint8Array;
  /** Transcript of the reference audio */
  text: string;
  /** Optional MIME type of the audio (default: audio/wav) */
  mimeType?: string;
}

export interface TtsAdapter {
  readonly id: string;
  readonly name: string;

  /** Check if the TTS server is reachable. */
  healthCheck(signal?: AbortSignal): Promise<boolean>;

  /** List available voices. */
  listVoices(signal?: AbortSignal): Promise<TtsVoice[]>;

  /** Generate speech from text. */
  generate(text: string, voiceId: string, opts?: TtsGenerateOptions, signal?: AbortSignal): Promise<TtsResult>;

  /** Add a voice clone reference (if supported). */
  addVoice?(input: TtsVoiceCloneInput, signal?: AbortSignal): Promise<void>;

  /** Delete a voice clone reference (if supported). */
  deleteVoice?(voiceId: string, signal?: AbortSignal): Promise<void>;
}
