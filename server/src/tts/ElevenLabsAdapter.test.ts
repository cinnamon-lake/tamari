import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElevenLabsAdapter } from './ElevenLabsAdapter.js';

describe('ElevenLabsAdapter', () => {
  let adapter: ElevenLabsAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new ElevenLabsAdapter({ baseUrl: 'https://api.elevenlabs.io/', apiKey: 'xi-key' });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/mpeg']]),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({ voices: [{ voice_id: 'v1', name: 'Rachel' }] }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error restore global fetch
    globalThis.fetch = undefined;
  });

  it('has correct id and name', () => {
    expect(adapter.id).toBe('elevenlabs');
    expect(adapter.name).toBe('ElevenLabs');
  });

  it('sends xi-api-key, voice in path, output_format query, and JSON body', async () => {
    await adapter.generate('Hello', '21m00Tcm4TlvDq8ikWAM');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('xi-key');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ text: 'Hello', model_id: 'eleven_multilingual_v2' });
    expect(body.voice_settings).toMatchObject({ stability: 0.5, similarity_boost: 0.75 });
  });

  it('defaults the voice when none given', async () => {
    await adapter.generate('Hi', '');
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?');
  });

  it('maps listed voices', async () => {
    const voices = await adapter.listVoices();
    expect(voices).toEqual([{ id: 'v1', name: 'Rachel', description: undefined }]);
  });

  it('throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: vi.fn().mockResolvedValue('unauthorized') });
    await expect(adapter.generate('Hi', 'v1')).rejects.toThrow('TTS generation failed');
  });

  it('healthCheck returns true on ok', async () => {
    expect(await adapter.healthCheck()).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/voices');
  });

  it('healthCheck returns false on non-ok', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('healthCheck returns false on fetch error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('throws when listing voices fails', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: vi.fn().mockResolvedValue('bad key') });
    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices: HTTP 401 - bad key');
  });

  it('throws "Unknown error" when the voices error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices: HTTP 500 - Unknown error');
  });

  it('throws "Unknown error" when the generate error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.generate('Hi', 'v1')).rejects.toThrow('TTS generation failed: HTTP 500 - Unknown error');
  });

  it('applies requestScript to mutate request', async () => {
    const scripted = new ElevenLabsAdapter({
      baseUrl: 'http://1.1.1.1:9000',
      apiKey: 'xi-key',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    await scripted.generate('Hi', 'v1');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });

  it('sends no xi-api-key header when no apiKey is configured', async () => {
    const keyless = new ElevenLabsAdapter({ baseUrl: 'https://api.elevenlabs.io' });
    await keyless.generate('Hi', 'v1');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['xi-api-key']).toBeUndefined();
  });

  it('merges opts.extra into the request body', async () => {
    await adapter.generate('Hi', 'v1', { extra: { seed: 42 } });
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.seed).toBe(42);
  });

  it('returns an empty list when the response has no voices field', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({}) });
    expect(await adapter.listVoices()).toEqual([]);
  });

  it('falls back to voice_id and category when name and labels are missing', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        voices: [
          { voice_id: 'v2', category: 'premade' },
          { voice_id: 'v3', name: 'Adam', labels: { description: 'deep' } },
        ],
      }),
    });
    const voices = await adapter.listVoices();
    expect(voices).toEqual([
      { id: 'v2', name: 'v2', description: 'premade' },
      { id: 'v3', name: 'Adam', description: 'deep' },
    ]);
  });

  it('falls back to audio/mpeg when the response has no content-type', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    });
    const result = await adapter.generate('Hi', 'v1');
    expect(result.contentType).toBe('audio/mpeg');
  });
});
