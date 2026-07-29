import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SileroAdapter } from './SileroAdapter.js';

describe('SileroAdapter', () => {
  let adapter: SileroAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new SileroAdapter({ baseUrl: 'http://127.0.0.1:8001' });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/wav']]),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue([{ name: 'en_0', voice_id: 'en_0' }, { name: 'en_1', voice_id: 'en_1' }]),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error restore global fetch
    globalThis.fetch = undefined;
  });

  it('has correct id and name', () => {
    expect(adapter.id).toBe('silero');
    expect(adapter.name).toBe('Silero');
  });

  it('sends speaker + session body to /tts/generate', async () => {
    await adapter.generate('Hello', 'en_5');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8001/tts/generate');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ speaker: 'en_5', text: 'Hello', session: 'tamari' });
  });

  it('defaults the speaker when none given', async () => {
    await adapter.generate('Hi', '');
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.speaker).toBe('en_0');
  });

  it('lists speakers from the wrapper', async () => {
    const voices = await adapter.listVoices();
    expect(voices.map((v) => v.id)).toEqual(['en_0', 'en_1']);
  });

  it('throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('boom') });
    await expect(adapter.generate('Hi', 'en_0')).rejects.toThrow('TTS generation failed');
  });

  it('healthCheck returns true on ok', async () => {
    expect(await adapter.healthCheck()).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8001/tts/speakers');
  });

  it('healthCheck returns false on non-ok', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 });
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('healthCheck returns false on fetch error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('throws when listing voices fails', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('no model loaded') });
    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices: HTTP 500 - no model loaded');
  });

  it('throws "Unknown error" when the voices error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices: HTTP 500 - Unknown error');
  });

  it('throws "Unknown error" when the generate error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.generate('Hi', 'en_0')).rejects.toThrow('TTS generation failed: HTTP 500 - Unknown error');
  });

  it('applies requestScript to mutate request', async () => {
    const scripted = new SileroAdapter({
      baseUrl: 'http://1.1.1.1:8001',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    await scripted.generate('Hi', 'en_0');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });

  it('maps speakers with missing fields to fallbacks', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue([{ name: 'spk_a' }, { voice_id: 'v9' }, {}]),
    });
    const voices = await adapter.listVoices();
    expect(voices).toEqual([
      { id: 'spk_a', name: 'spk_a', previewUrl: undefined },
      { id: 'v9', name: 'v9', previewUrl: undefined },
      { id: '', name: '', previewUrl: undefined },
    ]);
  });

  it('falls back to audio/wav when the response has no content-type', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    });
    const result = await adapter.generate('Hi', 'en_0');
    expect(result.contentType).toBe('audio/wav');
  });
});
