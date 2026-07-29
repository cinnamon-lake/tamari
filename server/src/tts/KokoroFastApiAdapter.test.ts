import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KokoroFastApiAdapter } from './KokoroFastApiAdapter.js';

describe('KokoroFastApiAdapter', () => {
  let adapter: KokoroFastApiAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new KokoroFastApiAdapter({ baseUrl: 'http://localhost:8880/v1/', apiKey: 'test-key' });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/wav']]),
      json: vi.fn().mockResolvedValue({ voices: [{ id: 'af_heart', name: 'Heart' }] }),
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
    expect(adapter.id).toBe('kokoro');
    expect(adapter.name).toBe('Kokoro (FastAPI)');
  });

  it('strips trailing slash from baseUrl', async () => {
    await adapter.healthCheck();
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:8880/v1/audio/voices');
  });

  it('healthCheck returns true on ok', async () => {
    const result = await adapter.healthCheck();
    expect(result).toBe(true);
  });

  it('healthCheck returns false on non-ok', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('error'),
    });
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('healthCheck returns false on fetch error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('listVoices returns mapped voices', async () => {
    const voices = await adapter.listVoices();
    expect(voices).toEqual([{ id: 'af_heart', name: 'Heart' }]);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).headers).toEqual(expect.objectContaining({ Authorization: 'Bearer test-key' }));
  });

  it('listVoices throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('boom'),
    });
    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices');
  });

  it('generate sends OpenAI-compatible payload', async () => {
    const result = await adapter.generate('Hello', 'af_bella', { format: 'mp3', extra: { speed: 1.2 } });
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(result.contentType).toBe('audio/wav');

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      model: 'kokoro',
      input: 'Hello',
      voice: 'af_bella',
      response_format: 'mp3',
      speed: 1.2,
    });
  });

  it('generate defaults voice and format', async () => {
    await adapter.generate('Hello', '');
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.voice).toBe('af_heart');
    expect(body.response_format).toBe('wav');
    expect(body.speed).toBe(1.0);
  });

  it('generate throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: vi.fn().mockResolvedValue('validation error'),
    });
    await expect(adapter.generate('test', 'voice')).rejects.toThrow('TTS generation failed');
  });

  it('generate passes abort signal', async () => {
    const controller = new AbortController();
    await adapter.generate('Hello', 'voice', {}, controller.signal);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).signal).toBe(controller.signal);
  });

  it('works without apiKey', async () => {
    const noKeyAdapter = new KokoroFastApiAdapter({ baseUrl: 'http://localhost:8880/v1' });
    await noKeyAdapter.healthCheck();
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).headers).toBeUndefined();
  });

  it('applies requestScript to mutate request', async () => {
    const scripted = new KokoroFastApiAdapter({
      baseUrl: 'http://1.1.1.1:8880/v1',
      apiKey: 'key',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    await scripted.generate('Hi', 'voice');
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });
});
