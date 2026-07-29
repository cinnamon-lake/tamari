import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AzureTtsAdapter } from './AzureTtsAdapter.js';

describe('AzureTtsAdapter', () => {
  let adapter: AzureTtsAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new AzureTtsAdapter({ baseUrl: 'https://eastus.tts.speech.microsoft.com', apiKey: 'sub-key' });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/mpeg']]),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue([{ ShortName: 'en-US-JennyNeural', DisplayName: 'Jenny', Locale: 'en-US', Gender: 'Female' }]),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error restore global fetch
    globalThis.fetch = undefined;
  });

  it('has correct id and name', () => {
    expect(adapter.id).toBe('azure');
    expect(adapter.name).toBe('Azure Speech');
  });

  it('sends SSML body with subscription key + output format headers', async () => {
    await adapter.generate('Hello & welcome', 'en-US-ChristopherNeural');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    const headers = init.headers as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('sub-key');
    expect(headers['Content-Type']).toBe('application/ssml+xml');
    expect(headers['X-Microsoft-OutputFormat']).toBe('audio-24khz-96kbitrate-mono-mp3');
    const body = init.body as string;
    expect(body).toContain('<voice name="en-US-ChristopherNeural">');
    expect(body).toContain('xml:lang="en-US"');
    expect(body).toContain('Hello &amp; welcome'); // XML-escaped
  });

  it('lists voices by ShortName', async () => {
    const voices = await adapter.listVoices();
    expect(voices).toEqual([{ id: 'en-US-JennyNeural', name: 'Jenny', language: 'en-US', description: 'Female' }]);
  });

  it('throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: vi.fn().mockResolvedValue('unauthorized') });
    await expect(adapter.generate('Hi', 'en-US-JennyNeural')).rejects.toThrow('TTS generation failed');
  });

  it('healthCheck returns true on ok', async () => {
    expect(await adapter.healthCheck()).toBe(true);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list');
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
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 403, text: vi.fn().mockResolvedValue('forbidden') });
    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices: HTTP 403 - forbidden');
  });

  it('throws "Unknown error" when the voices error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices: HTTP 500 - Unknown error');
  });

  it('throws "Unknown error" when the generate error body cannot be read', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(adapter.generate('Hi', 'en-US-JennyNeural')).rejects.toThrow(
      'TTS generation failed: HTTP 500 - Unknown error',
    );
  });

  it('applies requestScript to mutate request', async () => {
    const scripted = new AzureTtsAdapter({
      baseUrl: 'http://1.1.1.1:5002',
      apiKey: 'sub-key',
      requestScript: 'request.headers["X-Custom"] = "yes"',
    });
    // The SSML generate body is not JSON, so the script hook is exercised via healthCheck (a bodyless GET).
    expect(await scripted.healthCheck()).toBe(true);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Custom': 'yes' }));
  });

  it('defaults the voice when none given', async () => {
    await adapter.generate('Hi', '');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body as string).toContain('<voice name="en-US-JennyNeural">');
  });

  it('derives xml:lang en-US from a voice without a locale prefix', async () => {
    await adapter.generate('Hi', 'JennyNeural');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body as string).toContain('xml:lang="en-US"');
  });

  it('sends an empty subscription key when no apiKey is configured', async () => {
    const keyless = new AzureTtsAdapter({ baseUrl: 'https://eastus.tts.speech.microsoft.com' });
    await keyless.generate('Hi', 'en-US-JennyNeural');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Ocp-Apim-Subscription-Key']).toBe('');
  });

  it('falls back to ShortName when DisplayName is missing', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue([{ ShortName: 'en-US-GuyNeural' }]),
    });
    const voices = await adapter.listVoices();
    expect(voices).toEqual([
      { id: 'en-US-GuyNeural', name: 'en-US-GuyNeural', language: undefined, description: undefined },
    ]);
  });

  it('falls back to audio/mpeg when the response has no content-type', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    });
    const result = await adapter.generate('Hi', 'en-US-JennyNeural');
    expect(result.contentType).toBe('audio/mpeg');
  });
});
