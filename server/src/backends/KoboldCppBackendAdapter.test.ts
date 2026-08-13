import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KoboldCppBackendAdapter } from './KoboldCppBackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';

describe('KoboldCppBackendAdapter', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  function createMockStream(lines: string[]) {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < lines.length) {
          controller.enqueue(encoder.encode(lines[index++] + '\n'));
        } else {
          controller.close();
        }
      },
    });
  }

  it('sends request to /api/extra/generate/stream with normalized URL', async () => {
    const adapter = new KoboldCppBackendAdapter({
      baseUrl: 'http://localhost:5001',
      apiKey: '',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: {"token":"Hello"}', 'data: {"token":" world"}']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [{ role: 'user', content: 'Once upon a time' }], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:5001/api/extra/generate/stream');
    const body = JSON.parse(init.body as string);
    expect(body.prompt).toBe('Once upon a time');
    expect(body.max_length).toBe(100);
    expect(body.max_context_length).toBe(4096);
  });

  it('streams tokens from SSE events', async () => {
    const adapter = new KoboldCppBackendAdapter({
      baseUrl: 'http://localhost:5001',
      apiKey: '',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: {"token":"Hello"}', 'data: {"token":" world"}', 'data: {"token":"!"}']),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [{ role: 'user', content: 'Hi' }], tokenUsage: { prompt: 5, completion: 50 } },
      new AbortController().signal,
    ));
    const emitted = items.filter((i) => i.type === 'text').map((i) => i.token);

    expect(emitted).toEqual(['Hello', ' world', '!']);
    expect(result.finishReason).toBe('stop');
    expect(result.usage.completionTokens).toBe(3);
  });

  it('maps standard params to Kobold-native names', async () => {
    const adapter = new KoboldCppBackendAdapter({
      baseUrl: 'http://localhost:5001',
      apiKey: '',
      params: { temperature: 0.7, topP: 0.9, repetitionPenalty: 1.1 },
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: {"token":"x"}']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [{ role: 'user', content: 'Test' }], tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.rep_pen).toBe(1.1);
  });

  it('sends abort request when signal is aborted', async () => {
    const adapter = new KoboldCppBackendAdapter({
      baseUrl: 'http://localhost:5001',
      apiKey: '',
    });

    // First call: the stream request (never resolves — we abort immediately)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: {"token":"x"}']),
    } as Response);

    // Second call: the abort request
    fetchMock.mockResolvedValueOnce({ ok: true } as Response);

    const controller = new AbortController();
    const promise = consumeStream(adapter.stream(
      { messages: [{ role: 'user', content: 'Test' }], tokenUsage: { prompt: 1, completion: 10 } },
      controller.signal,
    ));

    // Abort immediately
    controller.abort();

    const { result } = await promise;
    expect(result.finishReason).toBe('error');
    expect(result.error).toBe('Aborted');

    // Should have called abort endpoint
    const abortCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/extra/abort'));
    expect(abortCall).toBeDefined();
  });

  it('returns error on HTTP failure', async () => {
    const adapter = new KoboldCppBackendAdapter({
      baseUrl: 'http://localhost:5001',
      apiKey: '',
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Server busy',
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [{ role: 'user', content: 'Test' }], tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('503');
  });

  it('preserves existing /api pathname in base URL', async () => {
    const adapter = new KoboldCppBackendAdapter({
      baseUrl: 'http://localhost:5001/api',
      apiKey: '',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: {"token":"x"}']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [{ role: 'user', content: 'Test' }], tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:5001/api/extra/generate/stream');
  });
});
