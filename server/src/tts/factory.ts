/**
 * TTS adapter factory.
 *
 * Reads the `tts.provider` setting (+ per-provider `tts.<id>.*` keys set by the
 * speak tool's config) and constructs the matching adapter. Add a provider by
 * adding an `if` branch and a `tts.<id>.*` settings block.
 */

import { FishAudioS2Adapter } from './FishAudioS2Adapter.js';
import { KokoroFastApiAdapter } from './KokoroFastApiAdapter.js';
import { ElevenLabsAdapter } from './ElevenLabsAdapter.js';
import { OpenAITtsAdapter } from './OpenAITtsAdapter.js';
import { AzureTtsAdapter } from './AzureTtsAdapter.js';
import { MiniMaxAdapter } from './MiniMaxAdapter.js';
import { VolcEngineAdapter } from './VolcEngineAdapter.js';
import { AllTalkAdapter } from './AllTalkAdapter.js';
import { VitsSimpleApiAdapter } from './VitsSimpleApiAdapter.js';
import { SileroAdapter } from './SileroAdapter.js';
import { GptSoVitsAdapter } from './GptSoVitsAdapter.js';
import type { TtsAdapter } from './TtsAdapter.js';
import { str } from '../lib/coerce.js';

export function createTtsAdapter(settings: Record<string, unknown>): TtsAdapter | null {
  const provider = str(settings['tts.provider']);
  if (!provider) return null;

  if (provider === 'fishaudio') {
    return new FishAudioS2Adapter({
      baseUrl: str(settings['tts.fishaudio.baseUrl'], 'http://127.0.0.1:8080/v1'),
      apiKey: str(settings['tts.fishaudio.apiKey']),
      requestScript: str(settings['tts.fishaudio.requestScript']),
    });
  }

  if (provider === 'kokoro') {
    return new KokoroFastApiAdapter({
      baseUrl: str(settings['tts.kokoro.baseUrl'], 'http://127.0.0.1:8880/v1'),
      apiKey: str(settings['tts.kokoro.apiKey']),
      requestScript: str(settings['tts.kokoro.requestScript']),
    });
  }

  if (provider === 'elevenlabs') {
    return new ElevenLabsAdapter({
      baseUrl: str(settings['tts.elevenlabs.baseUrl'], 'https://api.elevenlabs.io'),
      apiKey: str(settings['tts.elevenlabs.apiKey']),
      requestScript: str(settings['tts.elevenlabs.requestScript']),
      model: str(settings['tts.elevenlabs.model']),
    });
  }

  if (provider === 'openai') {
    return new OpenAITtsAdapter({
      baseUrl: str(settings['tts.openai.baseUrl'], 'https://api.openai.com'),
      apiKey: str(settings['tts.openai.apiKey']),
      requestScript: str(settings['tts.openai.requestScript']),
      model: str(settings['tts.openai.model']),
    });
  }

  if (provider === 'azure') {
    // baseUrl is the regional host, e.g. https://eastus.tts.speech.microsoft.com
    return new AzureTtsAdapter({
      baseUrl: str(settings['tts.azure.baseUrl'], 'https://eastus.tts.speech.microsoft.com'),
      apiKey: str(settings['tts.azure.apiKey']),
      requestScript: str(settings['tts.azure.requestScript']),
    });
  }

  if (provider === 'minimax') {
    return new MiniMaxAdapter({
      baseUrl: str(settings['tts.minimax.baseUrl'], 'https://api.minimax.io'),
      apiKey: str(settings['tts.minimax.apiKey']),
      requestScript: str(settings['tts.minimax.requestScript']),
      model: str(settings['tts.minimax.model']),
    });
  }

  if (provider === 'volcengine') {
    return new VolcEngineAdapter({
      baseUrl: str(settings['tts.volcengine.baseUrl'], 'https://openspeech.bytedance.com'),
      apiKey: str(settings['tts.volcengine.apiKey']), // OpenSpeech Access Token
      appId: str(settings['tts.volcengine.appId']),
      cluster: str(settings['tts.volcengine.cluster']),
      requestScript: str(settings['tts.volcengine.requestScript']),
    });
  }

  if (provider === 'alltalk') {
    return new AllTalkAdapter({
      baseUrl: str(settings['tts.alltalk.baseUrl'], 'http://127.0.0.1:7851'),
      requestScript: str(settings['tts.alltalk.requestScript']),
    });
  }

  if (provider === 'vits') {
    return new VitsSimpleApiAdapter({
      baseUrl: str(settings['tts.vits.baseUrl'], 'http://127.0.0.1:23456'),
      apiKey: str(settings['tts.vits.apiKey']),
      requestScript: str(settings['tts.vits.requestScript']),
    });
  }

  if (provider === 'silero') {
    return new SileroAdapter({
      baseUrl: str(settings['tts.silero.baseUrl'], 'http://127.0.0.1:8001'),
      requestScript: str(settings['tts.silero.requestScript']),
    });
  }

  if (provider === 'gptsovits') {
    return new GptSoVitsAdapter({
      baseUrl: str(settings['tts.gptsovits.baseUrl'], 'http://127.0.0.1:9880'),
      requestScript: str(settings['tts.gptsovits.requestScript']),
    });
  }

  return null;
}
