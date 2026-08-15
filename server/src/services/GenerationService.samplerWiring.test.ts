import { describe, it, expect } from 'vitest';
import { buildBackendSettings, paramsKeyForProvider } from '../backends/buildBackendSettings.js';
import type { BackendConfig, GenerationMode } from '@tamari/types';

function makeConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    id: 'cfg-1',
    name: 'Test',
    description: '',
    backendProvider: 'openai',
    generationMode: 'chat',
    model: 'gpt-4o',
    apiUrl: null,
    apiKey: null,
    temperature: 1,
    maxTokens: 300,
    topP: 1,
    topK: null,
    minP: null,
    topA: null,
    repetitionPenalty: null,
    frequencyPenalty: null,
    presencePenalty: null,
    instructTemplate: '',
    contextLength: 4096,
    promptHistoryLimit: 50,
    providerParams: {},
    stopStrings: [],
    openrouterProvider: null,
    logitBias: null,
    supportsImages: true,
    supportsAudio: true,
    supportsVideo: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('paramsKeyForProvider', () => {
  it.each<[string, GenerationMode, string]>([
    ['openai', 'chat', 'openai.params'],
    ['openrouter', 'chat', 'openai.params'],
    ['claude', 'chat', 'claude.params'],
    ['gemini', 'chat', 'gemini.params'],
    ['moonshot', 'chat', 'openai.params'],
    ['llamacpp', 'text', 'textgen.params'],
    ['tabbyapi', 'text', 'textgen.params'],
    ['koboldcpp', 'text', 'koboldcpp.params'],
    ['openai', 'text', 'textgen.params'],
  ])('routes %s/%s -> %s', (provider, mode, expected) => {
    expect(paramsKeyForProvider(provider, mode)).toBe(expected);
  });
});

describe('buildBackendSettings sampler wiring', () => {
  it('merges typed + advanced samplers into openai.params for an openai chat config', () => {
    const cfg = makeConfig({
      backendProvider: 'openai',
      generationMode: 'chat',
      temperature: 0.8,
      topP: 0.9,
      providerParams: { seed: 42, requestScript: '-- lua' },
    });
    const out = buildBackendSettings({}, cfg);
    expect(out['openai.params']).toMatchObject({ temperature: 0.8, topP: 0.9, seed: 42 });
    // requestScript stays top-level (factory.ts reads it there), not in the params blob
    expect(out['requestScript']).toBe('-- lua');
    expect((out['openai.params'] as Record<string, unknown>).requestScript).toBeUndefined();
  });

  it('merges into textgen.params for llamacpp with provider-native wire names', () => {
    const cfg = makeConfig({
      backendProvider: 'llamacpp',
      generationMode: 'text',
      temperature: 0.6,
      topP: 0.95,
      providerParams: { typical_p: 0.9, tfs_z: 0.8, mirostat_mode: 2 },
    });
    const out = buildBackendSettings({}, cfg);
    expect(out['textgen.params']).toMatchObject({
      temperature: 0.6,
      topP: 0.95,
      typical_p: 0.9,
      tfs_z: 0.8,
      mirostat_mode: 2,
    });
    expect(out['openai.params']).toBeUndefined();
  });

  it('merges into koboldcpp.params with kobold-native wire names (not the llamacpp/text ones)', () => {
    const cfg = makeConfig({
      backendProvider: 'koboldcpp',
      generationMode: 'text',
      temperature: 0.7,
      providerParams: { mirostat: 2, typical: 0.9, sampler_seed: 123 },
    });
    const out = buildBackendSettings({}, cfg);
    const params = out['koboldcpp.params'] as Record<string, unknown>;
    expect(params).toMatchObject({ temperature: 0.7, mirostat: 2, typical: 0.9, sampler_seed: 123 });
    expect(params.mirostat_mode).toBeUndefined();
    expect(params.typical_p).toBeUndefined();
  });

  it('strips null typed knobs and excludes requestScript from the params blob', () => {
    const cfg = makeConfig({
      backendProvider: 'openai',
      generationMode: 'chat',
      temperature: 0.8,
      topK: null,
      minP: null,
      providerParams: { requestScript: '-- lua', mirostat_mode: 2 },
    });
    const out = buildBackendSettings({}, cfg);
    const params = out['openai.params'] as Record<string, unknown>;
    expect(params.temperature).toBe(0.8);
    expect(params.topK).toBeUndefined();
    expect(params.minP).toBeUndefined();
    expect(params.mirostat_mode).toBe(2);
    expect(params.requestScript).toBeUndefined();
    expect(out['requestScript']).toBe('-- lua');
  });

  it('merges logitBias into both openai.params and textgen.params', () => {
    const cfg = makeConfig({
      backendProvider: 'openai',
      generationMode: 'chat',
      temperature: 0.5,
      logitBias: { '123': 5 },
    });
    const out = buildBackendSettings({}, cfg);
    expect((out['openai.params'] as Record<string, unknown>).logitBias).toEqual({ '123': 5 });
    expect((out['textgen.params'] as Record<string, unknown>).logitBias).toEqual({ '123': 5 });
  });

  it('returns allSettings unchanged when backendConfig is null', () => {
    const out = buildBackendSettings({ foo: 'bar', 'openai.params': { temperature: 0.1 } }, null);
    expect(out.foo).toBe('bar');
    expect((out['openai.params'] as Record<string, unknown>).temperature).toBe(0.1);
  });

  it('preserves non-sampler keys in an existing global params blob while applying per-config samplers', () => {
    const cfg = makeConfig({ backendProvider: 'openai', generationMode: 'chat', temperature: 0.8 });
    const out = buildBackendSettings({ 'openai.params': { existingKey: true } }, cfg);
    const params = out['openai.params'] as Record<string, unknown>;
    expect(params.existingKey).toBe(true);
    expect(params.temperature).toBe(0.8);
  });

  it('routes openrouter provider order and requestScript top-level', () => {
    const cfg = makeConfig({
      backendProvider: 'openrouter',
      generationMode: 'chat',
      openrouterProvider: 'Anthropic',
      providerParams: { requestScript: '-- lua', seed: 7 },
    });
    const out = buildBackendSettings({}, cfg);
    expect(out['openrouter.providerOrder']).toEqual(['Anthropic']);
    expect(out['requestScript']).toBe('-- lua');
    expect((out['openai.params'] as Record<string, unknown>).seed).toBe(7);
  });

  it('omits a disabled typed knob from the params blob while keeping enabled ones', () => {
    const cfg = makeConfig({
      backendProvider: 'openai',
      generationMode: 'chat',
      temperature: 0.8,
      topK: 40,
      providerParams: { samplerDisabled: { topK: true } },
    });
    const out = buildBackendSettings({}, cfg);
    const params = out['openai.params'] as Record<string, unknown>;
    expect(params.temperature).toBe(0.8);
    expect(params.topK).toBeUndefined(); // disabled → not sent
    expect(params.top_k).toBeUndefined();
    // the disable record itself never leaks into the request
    expect(params.samplerDisabled).toBeUndefined();
  });

  it('omits a disabled advanced knob (keyed by provider wire name)', () => {
    const cfg = makeConfig({
      backendProvider: 'llamacpp',
      generationMode: 'text',
      providerParams: { typical_p: 0.9, mirostat_mode: 2, samplerDisabled: { mirostat_mode: true } },
    });
    const out = buildBackendSettings({}, cfg);
    const params = out['textgen.params'] as Record<string, unknown>;
    expect(params.typical_p).toBe(0.9);
    expect(params.mirostat_mode).toBeUndefined(); // disabled → not sent
    expect(params.samplerDisabled).toBeUndefined();
  });

  it('sends all knobs when samplerDisabled is absent', () => {
    const cfg = makeConfig({
      backendProvider: 'openai',
      generationMode: 'chat',
      temperature: 0.8,
      topK: 40,
    });
    const out = buildBackendSettings({}, cfg);
    const params = out['openai.params'] as Record<string, unknown>;
    expect(params.temperature).toBe(0.8);
    expect(params.topK).toBe(40);
  });

  it('drops undeclared keys from the params blob while keeping declared wire knobs', () => {
    const cfg = makeConfig({
      backendProvider: 'openai',
      generationMode: 'chat',
      providerParams: {
        // A migrated v1 dump — none of these are declared providerParams keys.
        groq_model: 'llama-3.3-70b-versatile',
        proxy_password: 'super-secret',
        reverse_proxy: 'https://proxy.example.com',
        scenario_format: '{{scenario}}',
        custom_include_body: '',
        openrouter_sort_models: 'alphabetically',
        squash_system_messages: true,
        stream_openai: true,
        reasoning_effort: 'auto', // a wire param on some providers, but NOT a declared v2 knob
        extensions: {},
        // Declared knobs — must pass through.
        seed: 42,
        mirostat_mode: 2,
        typical_p: 0.9,
        cacheTTL: '5m',
      },
    });
    const out = buildBackendSettings({}, cfg);
    const params = out['openai.params'] as Record<string, unknown>;
    expect(params.seed).toBe(42);
    expect(params.mirostat_mode).toBe(2);
    expect(params.typical_p).toBe(0.9);
    expect(params.cacheTTL).toBe('5m');
    for (const junk of [
      'groq_model', 'proxy_password', 'reverse_proxy', 'scenario_format', 'custom_include_body',
      'openrouter_sort_models', 'squash_system_messages', 'stream_openai', 'reasoning_effort', 'extensions',
    ]) {
      expect(params[junk], `${junk} must not reach the request body`).toBeUndefined();
    }
  });

  it('keeps cacheMode/cacheDepth out of the params blob (assembly-level, never wire params)', () => {
    const cfg = makeConfig({
      backendProvider: 'claude',
      generationMode: 'chat',
      providerParams: {
        cacheMode: 'manual',
        cacheDepth: 2,
        // The adapter-side sibling DOES ride in the params blob.
        cacheTTL: '1h',
      },
    });
    const out = buildBackendSettings({}, cfg);
    const params = out['claude.params'] as Record<string, unknown>;
    expect(params.cacheTTL).toBe('1h');
    expect(params.cacheMode, 'cacheMode must not reach the request body').toBeUndefined();
    expect(params.cacheDepth, 'cacheDepth must not reach the request body').toBeUndefined();
  });
});
