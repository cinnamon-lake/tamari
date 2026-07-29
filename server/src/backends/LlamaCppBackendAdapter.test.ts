import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlamaCppBackendAdapter } from './LlamaCppBackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';

describe('LlamaCppBackendAdapter', () => {
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

  it('sends correct headers and body to /completion', async () => {
    const adapter = new LlamaCppBackendAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: '',
      model: 'llama-3-8b',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: {"content":"","stop":true}']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Once upon a time', tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/completion');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.prompt).toBe('Once upon a time');
    expect(body.stream).toBe(true);
    expect(body.n_predict).toBe(100);
    expect(body.model).toBeUndefined(); // llama.cpp native doesn't need model
  });

  it('includes Authorization header when apiKey is provided', async () => {
    const adapter = new LlamaCppBackendAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: 'secret-key',
      model: 'test',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: {"content":"","stop":true}']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Hi', tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-key');
  });

  it('streams tokens from content field', async () => {
    const adapter = new LlamaCppBackendAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: '',
      model: 'test-model',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"content":"Hello","stop":false,"tokens_predicted":1,"tokens_evaluated":5}',
        'data: {"content":" world","stop":false,"tokens_predicted":2,"tokens_evaluated":5}',
        'data: {"content":"!","stop":true,"tokens_predicted":3,"tokens_evaluated":5,"stopped_eos":true}',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Say hello', tokenUsage: { prompt: 5, completion: 50 } },
      new AbortController().signal,
    ));
    const tokens = items.filter((i) => i.type === 'text').map((i) => i.token);

    expect(tokens).toEqual(['Hello', ' world', '!']);
    expect(result.finishReason).toBe('stop');
    expect(result.usage.completionTokens).toBe(3);
    expect(result.usage.promptTokens).toBe(5);
  });

  it('detects length finish reason', async () => {
    const adapter = new LlamaCppBackendAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: '',
      model: 'test',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: {"content":"x","stop":true,"stopped_limit":true,"tokens_predicted":1}']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('length');
  });

  it('returns error on HTTP failure', async () => {
    const adapter = new LlamaCppBackendAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: '',
      model: 'test',
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Server busy',
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('503');
    expect(result.error).toContain('Server busy');
  });

  it('passes through provider-specific params', async () => {
    const adapter = new LlamaCppBackendAdapter({
      baseUrl: 'http://localhost:8080',
      apiKey: '',
      model: 'test',
      params: { temperature: 0.8, topK: 40, repeat_penalty: 1.1 },
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: {"content":"","stop":true}']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.8);
    expect(body.top_k).toBe(40);
    expect(body.repeat_penalty).toBe(1.1);
  });

  it('strips trailing slashes from baseUrl', async () => {
    const adapter = new LlamaCppBackendAdapter({
      baseUrl: 'http://localhost:8080/',
      apiKey: '',
      model: 'test',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: {"content":"","stop":true}']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/completion');
  });
});
