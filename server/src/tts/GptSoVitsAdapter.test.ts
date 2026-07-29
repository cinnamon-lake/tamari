import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GptSoVitsAdapter } from './GptSoVitsAdapter.js';

describe('GptSoVitsAdapter', () => {
  let adapter: GptSoVitsAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new GptSoVitsAdapter({ baseUrl: 'http://127.0.0.1:9880' });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/wav']]),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
      text: vi.fn().mockResolvedValue(''),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error restore global fetch
    globalThis.fetch = undefined;
  });

  it('has correct id and name', () => {
    expect(adapter.id).toBe('gptsovits');
    expect(adapter.name).toBe('GPT-SoVITS');
  });

  it('uses voiceId as the ref_audio_path in the api_v2 body', async () => {
    await adapter.generate('你好', '/data/refs/spk.wav');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9880/tts');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      text: '你好',
      text_lang: 'auto',
      ref_audio_path: '/data/refs/spk.wav',
      prompt_lang: 'auto',
      media_type: 'wav',
    });
  });

  it('returns no voices (no upstream /speakers route)', async () => {
    const voices = await adapter.listVoices();
    expect(voices).toEqual([]);
  });

  it('throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 400, text: vi.fn().mockResolvedValue('ref audio missing') });
    await expect(adapter.generate('Hi', '/bad.wav')).rejects.toThrow('TTS generation failed');
  });

  it('healthCheck returns true on ok', async () => {
    expect(await adapter.healthCheck()).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9880/control');
  });

  it('healthCheck returns false on non-ok', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('healthCheck returns false on fetch error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('applies requestScript to mutate request', async () => {
    const scripted = new GptSoVitsAdapter({
      baseUrl: 'http://1.1.1.1:9880',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    await scripted.generate('Hi', '/data/refs/spk.wav');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });

  it('throws "Unknown error" when the error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.generate('Hi', '/bad.wav')).rejects.toThrow('TTS generation failed: HTTP 500 - Unknown error');
  });

  it('merges opts.extra into the request body (e.g. prompt_text for the ref audio)', async () => {
    await adapter.generate('你好', '/data/refs/spk.wav', { extra: { prompt_text: '参考文本', speed_factor: 2.0 } });
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.prompt_text).toBe('参考文本');
    expect(body.speed_factor).toBe(2.0);
  });

  it('falls back to audio/wav when the response has no content-type', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    });
    const result = await adapter.generate('Hi', '/data/refs/spk.wav');
    expect(result.contentType).toBe('audio/wav');
  });
});
