import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VitsSimpleApiAdapter } from './VitsSimpleApiAdapter.js';

describe('VitsSimpleApiAdapter', () => {
  let adapter: VitsSimpleApiAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new VitsSimpleApiAdapter({ baseUrl: 'http://127.0.0.1:23456', apiKey: 'k' });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/wav']]),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({}),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error restore global fetch
    globalThis.fetch = undefined;
  });

  it('has correct id and name', () => {
    expect(adapter.id).toBe('vits');
    expect(adapter.name).toBe('VITS (simple-api)');
  });

  it('sends numeric speaker id + optional X-API-KEY', async () => {
    await adapter.generate('Hello', '142', { format: 'wav' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:23456/voice/vits');
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('k');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ text: 'Hello', id: 142, format: 'wav', lang: 'auto' });
  });

  it('flattens the model-type-bucketed speakers list', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ VITS: [{ id: 0, name: 'A' }, { id: 1, name: 'B' }], 'BERT-VITS2': [{ id: 9, name: 'C' }] }),
    });
    const voices = await adapter.listVoices();
    expect(voices.map((v) => v.id)).toEqual(['0', '1', '9']);
  });

  it('throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 400, text: vi.fn().mockResolvedValue('bad id') });
    await expect(adapter.generate('Hi', '999')).rejects.toThrow('TTS generation failed');
  });

  it('healthCheck returns true on ok', async () => {
    expect(await adapter.healthCheck()).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:23456/voice/speakers');
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
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: vi.fn().mockResolvedValue('bad key') });
    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices: HTTP 401 - bad key');
  });

  it('throws "Unknown error" when the voices error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices: HTTP 500 - Unknown error');
  });

  it('throws "Unknown error" when the generate error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.generate('Hi', '0')).rejects.toThrow('TTS generation failed: HTTP 500 - Unknown error');
  });

  it('applies requestScript to mutate request', async () => {
    const scripted = new VitsSimpleApiAdapter({
      baseUrl: 'http://1.1.1.1:23456',
      apiKey: 'k',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    await scripted.generate('Hi', '0');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });

  it('omits the X-API-KEY header without an apiKey', async () => {
    const keyless = new VitsSimpleApiAdapter({ baseUrl: 'http://127.0.0.1:23456' });
    await keyless.generate('Hi', '0');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBeUndefined();
  });

  it('skips non-array buckets and falls back for missing speaker fields', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        VITS: [{ id: 3 }, { id: 4, name: 'D', lang: ['zh'] }],
        BROKEN: 'not-an-array',
        EMPTY: undefined,
      }),
    });
    const voices = await adapter.listVoices();
    expect(voices).toEqual([
      { id: '3', name: '3', language: undefined },
      { id: '4', name: 'D', language: 'zh' },
    ]);
  });

  it('merges opts.extra into the request body', async () => {
    await adapter.generate('Hi', '0', { extra: { noise: 0.5 } });
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.noise).toBe(0.5);
  });

  it('falls back to audio/wav when the response has no content-type', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    });
    const result = await adapter.generate('Hi', '0');
    expect(result.contentType).toBe('audio/wav');
  });
});
