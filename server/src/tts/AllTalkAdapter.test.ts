import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AllTalkAdapter } from './AllTalkAdapter.js';

describe('AllTalkAdapter', () => {
  let adapter: AllTalkAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new AllTalkAdapter({ baseUrl: 'http://127.0.0.1:7851/' });
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
    expect(adapter.id).toBe('alltalk');
    expect(adapter.name).toBe('AllTalk');
  });

  it('sends the OpenAI-compatible payload with no auth header', async () => {
    await adapter.generate('Hello', 'nova', { format: 'mp3', extra: { speed: 1.1 } });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:7851/v1/audio/speech');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: 'tts-1', input: 'Hello', voice: 'nova', response_format: 'mp3', speed: 1.1 });
  });

  it('returns the 6 accepted OpenAI voice names', async () => {
    const voices = await adapter.listVoices();
    expect(voices.map((v) => v.id).sort()).toEqual(['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer']);
  });

  it('throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 400, text: vi.fn().mockResolvedValue('bad voice') });
    await expect(adapter.generate('Hi', 'unknown-voice')).rejects.toThrow('TTS generation failed');
  });

  it('healthCheck returns true on ok', async () => {
    expect(await adapter.healthCheck()).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:7851/api/ready');
  });

  it('healthCheck returns false on non-ok', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 });
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('healthCheck returns false on fetch error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('applies requestScript to mutate request', async () => {
    const scripted = new AllTalkAdapter({
      baseUrl: 'http://1.1.1.1:7851',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    await scripted.generate('Hi', 'nova');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });

  it('throws "Unknown error" when the error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.generate('Hi', 'nova')).rejects.toThrow('TTS generation failed: HTTP 500 - Unknown error');
  });

  it('defaults the voice to alloy when none given', async () => {
    await adapter.generate('Hi', '');
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.voice).toBe('alloy');
  });

  it('falls back to audio/mpeg when the response has no content-type', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    });
    const result = await adapter.generate('Hi', 'nova');
    expect(result.contentType).toBe('audio/mpeg');
  });
});
