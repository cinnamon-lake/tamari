import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MiniMaxAdapter } from './MiniMaxAdapter.js';

describe('MiniMaxAdapter', () => {
  let adapter: MiniMaxAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new MiniMaxAdapter({ baseUrl: 'https://api.minimax.io', apiKey: 'mm-key', model: 'speech-02-hd' });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
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
    expect(adapter.id).toBe('minimax');
    expect(adapter.name).toBe('MiniMax');
  });

  it('decodes hex-encoded audio from data.audio', async () => {
    const sample = Buffer.from([0x01, 0x02, 0xff, 0x00]);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { audio: sample.toString('hex') }, base_resp: { status_code: 0 } }),
    });
    const result = await adapter.generate('Hello', 'English_expressive_narrator');
    expect(Array.from(result.audio)).toEqual([0x01, 0x02, 0xff, 0x00]);
    expect(result.contentType).toBe('audio/mpeg');
  });

  it('sends bearer auth + nested voice_setting/audio_setting', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { audio: '00' }, base_resp: { status_code: 0 } }),
    });
    await adapter.generate('Hi', 'male-qn-qingse');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.minimax.io/v1/t2a_v2');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mm-key');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'speech-02-hd', output_format: 'hex' });
    expect(body.voice_setting.voice_id).toBe('male-qn-qingse');
  });

  it('throws on non-zero base_resp status', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ base_resp: { status_code: 1004, status_msg: 'invalid voice' } }),
    });
    await expect(adapter.generate('Hi', 'nope')).rejects.toThrow('invalid voice');
  });

  it('returns a static voice list', async () => {
    const voices = await adapter.listVoices();
    expect(voices.map((v) => v.id)).toContain('English_expressive_narrator');
  });

  it('healthCheck returns true when the probe synthesis succeeds', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { audio: '00' }, base_resp: { status_code: 0 } }),
    });
    expect(await adapter.healthCheck()).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.minimax.io/v1/t2a_v2');
  });

  it('healthCheck returns false when the probe synthesis fails', async () => {
    // Default mock resolves `{}`, so base_resp.status_code is missing and generate() throws.
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('throws on HTTP error with the response body', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('server down') });
    await expect(adapter.generate('Hi', 'x')).rejects.toThrow('TTS generation failed: HTTP 500 - server down');
  });

  it('throws "Unknown error" when the error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.generate('Hi', 'x')).rejects.toThrow('TTS generation failed: HTTP 500 - Unknown error');
  });

  it('throws "unknown MiniMax error" when no status_msg is given', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ base_resp: { status_code: 2049 } }),
    });
    await expect(adapter.generate('Hi', 'x')).rejects.toThrow('unknown MiniMax error');
  });

  it('throws when MiniMax returns no audio data', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: {}, base_resp: { status_code: 0 } }),
    });
    await expect(adapter.generate('Hi', 'x')).rejects.toThrow('MiniMax returned no audio data');
  });

  it('omits the Authorization header without an apiKey', async () => {
    const keyless = new MiniMaxAdapter({ baseUrl: 'https://api.minimax.io' });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { audio: '00' }, base_resp: { status_code: 0 } }),
    });
    await keyless.generate('Hi', 'x');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('applies requestScript to mutate request', async () => {
    const scripted = new MiniMaxAdapter({
      baseUrl: 'http://1.1.1.1:9000',
      apiKey: 'mm-key',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { audio: '00' }, base_resp: { status_code: 0 } }),
    });
    await scripted.generate('Hi', 'x');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });

  it('defaults the voice when none given', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { audio: '00' }, base_resp: { status_code: 0 } }),
    });
    await adapter.generate('Hi', '');
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.voice_setting.voice_id).toBe('English_expressive_narrator');
  });

  it('merges opts.extra into the request body', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { audio: '00' }, base_resp: { status_code: 0 } }),
    });
    await adapter.generate('Hi', 'x', { extra: { subtitle_enable: true } });
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.subtitle_enable).toBe(true);
  });
});
