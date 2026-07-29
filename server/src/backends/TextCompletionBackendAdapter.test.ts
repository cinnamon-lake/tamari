import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TextCompletionBackendAdapter } from './TextCompletionBackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';

describe('TextCompletionBackendAdapter', () => {
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

  it('sends correct headers and body', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://localhost:5000/v1',
      apiKey: 'test-key',
      model: 'llama-3-8b',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Once upon a time', tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:5000/v1/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('llama-3-8b');
    expect(body.stream).toBe(true);
    expect(body.prompt).toBe('Once upon a time');
    expect(body.max_tokens).toBe(100);
  });

  it('streams tokens', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://localhost:5000',
      apiKey: '',
      model: 'test-model',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"choices":[{"text":"Hello","finish_reason":null}]}',
        'data: {"choices":[{"text":" world","finish_reason":null}]}',
        'data: {"choices":[{"text":"!","finish_reason":"stop"}]}',
        'data: [DONE]',
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
  });

  it('handles delta.text format (some APIs)', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://localhost:5000',
      apiKey: '',
      model: 'test-model',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"choices":[{"delta":{"text":"Hi"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"text":" there"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Greet me', tokenUsage: { prompt: 5, completion: 50 } },
      new AbortController().signal,
    ));
    const tokens = items.filter((i) => i.type === 'text').map((i) => i.token);

    expect(tokens).toEqual(['Hi', ' there']);
    expect(result.finishReason).toBe('stop');
  });

  it('returns error on HTTP failure', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://localhost:5000',
      apiKey: '',
      model: 'test-model',
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('500');
  });

  it('lists models', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://1.1.1.1:5000',
      apiKey: 'key',
      model: 'test-model',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ object: 'list', data: [{ id: 'model-a' }, { id: 'model-b' }] }),
    } as Response);

    const models = await adapter.listModels();
    expect(models).toEqual([
      { id: 'model-a', name: 'model-a' },
      { id: 'model-b', name: 'model-b' },
    ]);
  });

  it('listModels returns empty on error', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://1.1.1.1:5000',
      apiKey: '',
      model: 'test-model',
    });

    fetchMock.mockRejectedValueOnce(new Error('fail'));
    expect(await adapter.listModels()).toEqual([]);
  });

  it('returns error when no response body', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://1.1.1.1:5000',
      apiKey: '',
      model: 'test-model',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: null,
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('No response body');
  });

  it('returns requestScript error without leaking SSRF details', async () => {
    // Non-loopback backend: a script redirecting to a private address must
    // still be SSRF-blocked (loopback is only allowed for loopback-configured
    // backends).
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://1.1.1.1:5000',
      apiKey: '',
      model: 'test-model',
      requestScript: 'request.url = "http://10.0.0.5/internal"',
    });

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('Request script error');
  });

  it('aborts streaming when signal is aborted', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://1.1.1.1:5000',
      apiKey: '',
      model: 'test-model',
    });

    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return {
        ok: true,
        body: new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"x"}]}\n'));
            controller.close();
          },
        }),
      } as Response;
    });

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
      controller.signal,
    ));
    expect(result.finishReason).toBe('error');
    expect(result.error).toBe('Aborted');
  });

  it('ignores malformed SSE lines', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://1.1.1.1:5000',
      apiKey: '',
      model: 'test-model',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'not a data line',
        'data: not-json',
        'data: {"choices":[{"text":"ok"}]}',
        'data: [DONE]',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(items.filter((i) => i.type === 'text').map((i) => i.token)).toEqual(['ok']);
    expect(result.finishReason).toBe('stop');
  });

  it('canonicalizes finish reasons', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://1.1.1.1:5000',
      apiKey: '',
      model: 'test-model',
    });

    for (const [raw, expected] of [['length', 'length'], ['content_filter', 'content_filter'], ['unknown', 'error']] as const) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        body: createMockStream([
          `data: {"choices":[{"text":"x","finish_reason":"${raw}"}]}`,
        ]),
      } as Response);

      const { result } = await consumeStream(adapter.stream(
        { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
        new AbortController().signal,
      ));
      expect(result.finishReason).toBe(expected);
    }
  });

  it('passes through provider-specific params', async () => {
    const adapter = new TextCompletionBackendAdapter({
      baseUrl: 'http://localhost:5000',
      apiKey: '',
      model: 'test-model',
      params: { topK: 40, repetitionPenalty: 1.1 },
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], text: 'Test', tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.top_k).toBe(40);
    expect(body.repetition_penalty).toBe(1.1);
  });
});
