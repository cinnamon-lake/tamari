import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAITtsAdapter } from './OpenAITtsAdapter.js';

describe('OpenAITtsAdapter', () => {
  let adapter: OpenAITtsAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new OpenAITtsAdapter({ baseUrl: 'https://api.openai.com', apiKey: 'sk-test', model: 'gpt-4o-mini-tts' });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/mpeg']]),
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
    expect(adapter.id).toBe('openai');
    expect(adapter.name).toBe('OpenAI');
  });

  it('sends OpenAI speech payload with bearer auth', async () => {
    await adapter.generate('Hello', 'coral', { format: 'mp3', extra: { speed: 1.25 } });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: 'gpt-4o-mini-tts', input: 'Hello', voice: 'coral', response_format: 'mp3', speed: 1.25 });
  });

  it('returns the built-in voice enum (no network call)', async () => {
    const voices = await adapter.listVoices();
    expect(voices.map((v) => v.id)).toContain('coral');
    expect(voices).toHaveLength(13);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 429, text: vi.fn().mockResolvedValue('rate limited') });
    await expect(adapter.generate('Hi', 'alloy')).rejects.toThrow('TTS generation failed');
  });

  it('healthCheck returns true on ok', async () => {
    expect(await adapter.healthCheck()).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
  });

  it('healthCheck returns false on non-ok', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('healthCheck returns false on fetch error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('applies requestScript to mutate request', async () => {
    const scripted = new OpenAITtsAdapter({
      baseUrl: 'http://1.1.1.1:9000',
      apiKey: 'sk-test',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    await scripted.generate('Hi', 'alloy');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });

  it('throws "Unknown error" when the error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.generate('Hi', 'alloy')).rejects.toThrow('TTS generation failed: HTTP 500 - Unknown error');
  });

  it('defaults the voice to alloy when none given', async () => {
    await adapter.generate('Hi', '');
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.voice).toBe('alloy');
  });

  it('omits the Authorization header without an apiKey', async () => {
    const keyless = new OpenAITtsAdapter({ baseUrl: 'https://api.openai.com' });
    await keyless.generate('Hi', 'alloy');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('falls back to audio/mpeg when the response has no content-type', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    });
    const result = await adapter.generate('Hi', 'alloy');
    expect(result.contentType).toBe('audio/mpeg');
  });
});
