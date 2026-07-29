import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FishAudioS2Adapter } from './FishAudioS2Adapter.js';

describe('FishAudioS2Adapter', () => {
  let adapter: FishAudioS2Adapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new FishAudioS2Adapter({ baseUrl: 'http://localhost:8080/v1', apiKey: 'test-key' });
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/wav']]),
      json: vi.fn().mockResolvedValue({ status: 'ok' }),
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
    expect(adapter.id).toBe('fishaudio');
    expect(adapter.name).toBe('Fish Audio S2 Pro');
  });

  it('healthCheck returns true on ok', async () => {
    const result = await adapter.healthCheck();
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:8080/v1/health', { signal: undefined });
  });

  it('healthCheck returns false on non-ok', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('error'),
    });
    const result = await adapter.healthCheck();
    expect(result).toBe(false);
  });

  it('healthCheck returns false on fetch error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await adapter.healthCheck();
    expect(result).toBe(false);
  });

  it('listVoices returns mapped voices', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ reference_ids: ['alice', 'bob'] }),
      text: vi.fn().mockResolvedValue(''),
    });

    const voices = await adapter.listVoices();
    expect(voices).toEqual([
      { id: 'alice', name: 'alice' },
      { id: 'bob', name: 'bob' },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:8080/v1/references/list', {
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      signal: undefined,
    });
  });

  it('listVoices throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('server error'),
    });

    await expect(adapter.listVoices()).rejects.toThrow('Failed to list voices');
  });

  it('generate sends correct payload', async () => {
    const result = await adapter.generate('Hello world', 'alice', { format: 'mp3', temperature: 0.5 });
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(result.contentType).toBe('audio/wav');

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      text: 'Hello world',
      reference_id: 'alice',
      format: 'mp3',
      temperature: 0.5,
      top_p: 0.8,
      repetition_penalty: 1.1,
      max_new_tokens: 1024,
      chunk_length: 200,
    });
    expect(body.streaming).toBeUndefined();
  });

  it('generate includes streaming when explicitly set', async () => {
    await adapter.generate('Hello', 'alice', { streaming: true });
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.streaming).toBe(true);
  });

  it('generate works without voiceId', async () => {
    await adapter.generate('Hello', '');
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reference_id).toBeUndefined();
  });

  it('generate throws on error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: vi.fn().mockResolvedValue('validation error'),
    });

    await expect(adapter.generate('test', 'alice')).rejects.toThrow('TTS generation failed');
  });

  it('addVoice sends multipart form data', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ success: true }),
      text: vi.fn().mockResolvedValue(''),
    });

    await adapter.addVoice({ id: 'custom', text: 'Hello', audio: new Uint8Array([1, 2, 3]) });

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = (init as RequestInit).body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('id')).toBe('custom');
    expect(body.get('text')).toBe('Hello');
    const audio = body.get('audio');
    expect(audio).toBeInstanceOf(Blob);
    expect((init as RequestInit).headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer test-key',
    }));
    expect((init as RequestInit).headers).not.toEqual(expect.objectContaining({
      'Content-Type': 'application/json',
    }));
  });

  it('addVoice throws when server returns success=false', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ success: false }),
      text: vi.fn().mockResolvedValue(''),
    });

    await expect(adapter.addVoice({ id: 'x', text: 't', audio: new Uint8Array([0]) })).rejects.toThrow('success=false');
  });

  it('deleteVoice sends DELETE request', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(''),
    });

    await adapter.deleteVoice('alice');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:8080/v1/references/delete');
    expect((init as RequestInit).method).toBe('DELETE');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reference_id).toBe('alice');
  });

  it('works without apiKey', async () => {
    const noKeyAdapter = new FishAudioS2Adapter({ baseUrl: 'http://localhost:8080/v1' });
    await noKeyAdapter.healthCheck();
    const [, init] = fetchSpy.mock.calls[0]!;
    // healthCheck doesn't pass headers in the init object
    expect((init as RequestInit).headers).toBeUndefined();
  });
});
