import { describe, it, expect } from 'vitest';
import { createTtsAdapter } from './factory.js';
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

describe('createTtsAdapter', () => {
  it('returns null when provider is empty', () => {
    expect(createTtsAdapter({})).toBeNull();
    expect(createTtsAdapter({ 'tts.provider': '' })).toBeNull();
  });

  it('returns null for unknown provider', () => {
    expect(createTtsAdapter({ 'tts.provider': 'definitely-not-a-real-provider' })).toBeNull();
  });

  it('creates FishAudioS2Adapter with defaults', () => {
    const adapter = createTtsAdapter({ 'tts.provider': 'fishaudio' });
    expect(adapter).toBeInstanceOf(FishAudioS2Adapter);
    expect(adapter!.id).toBe('fishaudio');
  });

  it('creates KokoroFastApiAdapter with defaults', () => {
    const adapter = createTtsAdapter({ 'tts.provider': 'kokoro' });
    expect(adapter).toBeInstanceOf(KokoroFastApiAdapter);
    expect(adapter!.id).toBe('kokoro');
  });

  it.each<[string, new (config: never) => TtsAdapter]>([
    ['elevenlabs', ElevenLabsAdapter],
    ['openai', OpenAITtsAdapter],
    ['azure', AzureTtsAdapter],
    ['minimax', MiniMaxAdapter],
    ['volcengine', VolcEngineAdapter],
    ['alltalk', AllTalkAdapter],
    ['vits', VitsSimpleApiAdapter],
    ['silero', SileroAdapter],
    ['gptsovits', GptSoVitsAdapter],
  ])('creates the %s adapter and wires its id', (provider, Klass) => {
    const adapter = createTtsAdapter({ 'tts.provider': provider });
    expect(adapter).toBeInstanceOf(Klass);
    expect(adapter!.id).toBe(provider);
  });

  it('reads per-provider settings (volcengine appId/model)', () => {
    const adapter = createTtsAdapter({
      'tts.provider': 'volcengine',
      'tts.volcengine.appId': '123456',
      'tts.volcengine.cluster': 'volcano_tts',
    });
    expect(adapter).toBeInstanceOf(VolcEngineAdapter);
  });
});
