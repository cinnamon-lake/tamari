import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VolcEngineAdapter } from './VolcEngineAdapter.js';

describe('VolcEngineAdapter', () => {
  let adapter: VolcEngineAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new VolcEngineAdapter({
      baseUrl: 'https://openspeech.bytedance.com',
      apiKey: 'access-token',
      appId: '123456',
    });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue(''), json: vi.fn().mockResolvedValue({}) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error restore global fetch
    globalThis.fetch = undefined;
  });

  it('has correct id and name', () => {
    expect(adapter.id).toBe('volcengine');
    expect(adapter.name).toBe('VolcEngine');
  });

  it('uses the Bearer;<token> semicolon auth and base64-decodes audio', async () => {
    const sample = Buffer.from([0x10, 0x20, 0x30]);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ code: 3000, message: 'Success', data: sample.toString('base64') }),
    });
    const result = await adapter.generate('你好', 'zh_female_wanwanxiaohe');
    expect(Array.from(result.audio)).toEqual([0x10, 0x20, 0x30]);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // NOTE the semicolon, not a space:
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer;access-token');
    const body = JSON.parse(init.body as string);
    expect(body.app).toMatchObject({ appid: '123456', cluster: 'volcano_tts' });
    expect(body.audio.voice_type).toBe('zh_female_wanwanxiaohe');
    expect(body.request.operation).toBe('query');
    expect(typeof body.request.reqid).toBe('string'); // unique per request
  });

  it('throws on non-success code', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ code: 3001, message: 'bad voice' }),
    });
    await expect(adapter.generate('Hi', 'x')).rejects.toThrow('bad voice');
  });

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: vi.fn().mockResolvedValue('no auth') });
    await expect(adapter.generate('Hi', 'x')).rejects.toThrow('TTS generation failed');
  });

  it('healthCheck returns true when the probe synthesis succeeds', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ code: 3000, data: 'AAAA' }),
    });
    expect(await adapter.healthCheck()).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openspeech.bytedance.com/api/v1/tts');
  });

  it('healthCheck returns false when the probe synthesis fails', async () => {
    // Default mock resolves `{}`, so the success code 3000 is missing and generate() throws.
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('returns no voices (voice catalog is docs-only)', async () => {
    expect(await adapter.listVoices()).toEqual([]);
  });

  it('throws the VolcEngine code when no message is given', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ code: 3002 }),
    });
    await expect(adapter.generate('Hi', 'x')).rejects.toThrow('VolcEngine code 3002');
  });

  it('throws when VolcEngine returns no audio data', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ code: 3000, message: 'Success' }),
    });
    await expect(adapter.generate('Hi', 'x')).rejects.toThrow('VolcEngine returned no audio data');
  });

  it('throws "Unknown error" when the HTTP error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.generate('Hi', 'x')).rejects.toThrow('TTS generation failed: HTTP 500 - Unknown error');
  });

  it('applies requestScript to mutate request', async () => {
    const scripted = new VolcEngineAdapter({
      baseUrl: 'http://1.1.1.1:9000',
      apiKey: 'access-token',
      appId: '123456',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ code: 3000, data: 'AAAA' }),
    });
    await scripted.generate('Hi', 'x');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });

  it('defaults appId, cluster, and voice when not configured', async () => {
    const minimal = new VolcEngineAdapter({ baseUrl: 'https://openspeech.bytedance.com', apiKey: 'access-token' });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ code: 3000, data: 'AAAA' }),
    });
    await minimal.generate('Hi', '');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.app).toMatchObject({ appid: '', cluster: 'volcano_tts' });
    expect(body.audio.voice_type).toBe('zh_female_wanwanxiaohe');
  });

  it('uses the configured cluster and merges opts.extra', async () => {
    const clustered = new VolcEngineAdapter({
      baseUrl: 'https://openspeech.bytedance.com',
      apiKey: 'access-token',
      appId: '123456',
      cluster: 'volcano_icl',
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ code: 3000, data: 'AAAA' }),
    });
    await clustered.generate('Hi', 'x', { extra: { debug: true } });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.app.cluster).toBe('volcano_icl');
    expect(body.debug).toBe(true);
  });

  it('sends an empty token when no apiKey is configured', async () => {
    const keyless = new VolcEngineAdapter({ baseUrl: 'https://openspeech.bytedance.com' });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ code: 3000, data: 'AAAA' }),
    });
    await keyless.generate('Hi', 'x');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer;');
  });
});
