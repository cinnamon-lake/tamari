import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QwenTtsAdapter, QwenTtsError } from './QwenTtsAdapter.js';

function ttsResponse(overrides: Record<string, unknown> = {}, audioUrl = 'http://qwen.local/audio/audio_123.wav') {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      status_code: 200,
      request_id: 'req-1',
      code: '',
      message: '',
      output: {
        text: null,
        choices: null,
        finish_reason: 'stop',
        audio: { data: '', url: audioUrl, id: 'audio_123', expires_at: 0 },
      },
      usage: { characters: 5 },
      ...overrides,
    }),
    text: vi.fn().mockResolvedValue(''),
  };
}

function wavResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'audio/wav']]),
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    text: vi.fn().mockResolvedValue(''),
  };
}

describe('QwenTtsAdapter', () => {
  let adapter: QwenTtsAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new QwenTtsAdapter({
      baseUrl: 'http://qwen.local',
      apiKey: 'sk-test',
      model: 'qwen3-tts-vd-2026-01-26',
      language: 'English',
    });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error restore global fetch
    globalThis.fetch = undefined;
  });

  it('has correct id and name', () => {
    expect(adapter.id).toBe('qwen');
    expect(adapter.name).toBe('Qwen');
  });

  it('sends the DashScope generation payload with bearer auth, then fetches the audio url', async () => {
    fetchSpy.mockResolvedValueOnce(ttsResponse()).mockResolvedValueOnce(wavResponse());

    const result = await adapter.generate('Hello', 'qwen-tts-vd-announcer-voice-1-a1b2');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://qwen.local/api/v1/services/aigc/multimodal-generation/generation');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'qwen3-tts-vd-2026-01-26',
      input: { text: 'Hello', voice: 'qwen-tts-vd-announcer-voice-1-a1b2', language_type: 'English' },
    });

    // The audio URL is fetched with the same bearer token (local servers auth /audio/*).
    const [audioUrl, audioInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(audioUrl).toBe('http://qwen.local/audio/audio_123.wav');
    expect(((audioInit.headers ?? {}) as Record<string, string>).Authorization).toBe('Bearer sk-test');

    expect(result.contentType).toBe('audio/wav');
    expect(result.audio).toHaveLength(4);
  });

  it('omits language_type when not configured and defaults model and voice', async () => {
    const bare = new QwenTtsAdapter({ baseUrl: 'http://qwen.local' });
    fetchSpy.mockResolvedValueOnce(ttsResponse()).mockResolvedValueOnce(wavResponse());

    await bare.generate('Hi', '');

    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('qwen3-tts-flash');
    expect(body.input.voice).toBe('Cherry');
    expect(body.input.language_type).toBeUndefined();
  });

  it('passes instructions through from opts.extra', async () => {
    fetchSpy.mockResolvedValueOnce(ttsResponse()).mockResolvedValueOnce(wavResponse());

    await adapter.generate('Hi', 'v1', { extra: { instructions: 'Speak softly.' } });

    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.input.instructions).toBe('Speak softly.');
  });

  it('decodes base64 audio data when no url is returned', async () => {
    const clip = Buffer.from('RIFF....');
    fetchSpy.mockResolvedValueOnce(
      ttsResponse({
        output: { audio: { data: clip.toString('base64'), url: '', id: 'a', expires_at: 0 } },
      }),
    );

    const result = await adapter.generate('Hi', 'v1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Buffer.from(result.audio).equals(clip)).toBe(true);
    expect(result.contentType).toBe('audio/wav');
  });

  it('throws on HTTP error with the response body', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: vi.fn().mockResolvedValue('bad key') });
    await expect(adapter.generate('Hi', 'v1')).rejects.toThrow('TTS generation failed: HTTP 401 - bad key');
  });

  it('attaches the envelope error code to thrown errors', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ status_code: 400, code: 'BadRequest.VoiceNotFound', message: 'gone' })),
    });
    const err: unknown = await adapter.generate('Hi', 'v1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QwenTtsError);
    expect((err as QwenTtsError).code).toBe('BadRequest.VoiceNotFound');
  });

  it('throws on an error envelope in a 200 response', async () => {
    fetchSpy.mockResolvedValueOnce(ttsResponse({ code: 'BadRequest.VoiceNotFound', message: 'Voice not found: v1' }));
    await expect(adapter.generate('Hi', 'v1')).rejects.toThrow('BadRequest.VoiceNotFound');
  });

  it('throws when the response has neither audio url nor data', async () => {
    fetchSpy.mockResolvedValueOnce(ttsResponse({ output: { audio: { data: '', url: '', id: 'a', expires_at: 0 } } }));
    await expect(adapter.generate('Hi', 'v1')).rejects.toThrow('no audio url or data');
  });

  it('throws when the audio url fetch fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(ttsResponse())
      .mockResolvedValueOnce({ ok: false, status: 404, text: vi.fn().mockResolvedValue('expired') });
    await expect(adapter.generate('Hi', 'v1')).rejects.toThrow('TTS audio fetch failed: HTTP 404 - expired');
  });

  it('resolves relative audio urls against the base URL', async () => {
    fetchSpy.mockResolvedValueOnce(
      ttsResponse({ output: { audio: { data: '', url: '/audio/audio_9.wav', id: 'a', expires_at: 0 } } }),
    );
    fetchSpy.mockResolvedValueOnce(wavResponse());

    await adapter.generate('Hi', 'v1');
    expect((fetchSpy.mock.calls[1] as [string])[0]).toBe('http://qwen.local/audio/audio_9.wav');
  });

  it('listVoices maps the designed-voice list', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        voices: [
          {
            voice: 'qwen-tts-vd-announcer-voice-1-a1b2',
            voice_prompt: 'A composed announcer.',
            language: 'en',
            target_model: 'qwen3-tts-vd-2026-01-26',
          },
        ],
        request_id: 'req-2',
      }),
      text: vi.fn().mockResolvedValue(''),
    });

    const voices = await adapter.listVoices();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://qwen.local/api/v1/services/audio/tts/customization');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(voices).toEqual([
      {
        id: 'qwen-tts-vd-announcer-voice-1-a1b2',
        name: 'qwen-tts-vd-announcer-voice-1-a1b2',
        description: 'A composed announcer.',
        language: 'en',
      },
    ]);
  });

  it('listVoices throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: vi.fn().mockResolvedValue('bad key') });
    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices: HTTP 401 - bad key');
  });

  it('deleteVoice sends a DELETE to the customization route', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue('') });

    await adapter.deleteVoice('qwen-tts-vd-x');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://qwen.local/api/v1/services/audio/tts/customization/qwen-tts-vd-x');
    expect(init.method).toBe('DELETE');
  });

  it('designVoice posts the voice-design payload and decodes the preview', async () => {
    const preview = Buffer.from('RIFF-preview');
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        output: {
          voice: 'qwen-tts-vd-announcer-voice-20260904-a1b2',
          preview_audio: { data: preview.toString('base64'), sample_rate: 24000, response_format: 'wav' },
          target_model: 'qwen3-tts-vd-2026-01-26',
        },
        usage: { count: 1 },
        request_id: 'req-3',
      }),
      text: vi.fn().mockResolvedValue(''),
    });

    const result = await adapter.designVoice({
      voicePrompt: 'A composed announcer.',
      previewText: 'Welcome to the news.',
      preferredName: 'announcer',
      language: 'en',
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://qwen.local/api/v1/services/audio/tts/customization');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'qwen-voice-design',
      input: {
        action: 'create',
        target_model: 'qwen3-tts-vd-2026-01-26', // falls back to the adapter model
        voice_prompt: 'A composed announcer.',
        preview_text: 'Welcome to the news.',
        preferred_name: 'announcer',
        language: 'en',
      },
    });

    expect(result.voice).toBe('qwen-tts-vd-announcer-voice-20260904-a1b2');
    expect(result.targetModel).toBe('qwen3-tts-vd-2026-01-26');
    expect(Buffer.from(result.previewAudio).equals(preview)).toBe(true);
    expect(result.previewContentType).toBe('audio/wav');
  });

  it('designVoice throws on an error envelope', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('{"request_id":"r","code":"BadRequest","message":"voice_prompt too long"}'),
    });
    await expect(adapter.designVoice({ voicePrompt: 'x', previewText: 'y' })).rejects.toThrow(
      'Voice design failed: HTTP 400',
    );
  });

  it('healthCheck returns true when /healthz is ok', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
    expect(await adapter.healthCheck()).toBe(true);
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe('http://qwen.local/healthz');
  });

  it('healthCheck falls back to the voice list and returns false on failure', async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 401, text: vi.fn().mockResolvedValue('') });
    expect(await adapter.healthCheck()).toBe(false);
    expect((fetchSpy.mock.calls[1] as [string])[0]).toBe('http://qwen.local/api/v1/services/audio/tts/customization');
  });

  it('healthCheck returns false on fetch error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('applies requestScript to the generation request', async () => {
    const scripted = new QwenTtsAdapter({
      baseUrl: 'http://1.1.1.1:9000',
      apiKey: 'sk-test',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    fetchSpy
      .mockResolvedValueOnce(ttsResponse({}, 'http://1.1.1.1:9000/audio/audio_123.wav'))
      .mockResolvedValueOnce(wavResponse());

    await scripted.generate('Hi', 'v1');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });
});
