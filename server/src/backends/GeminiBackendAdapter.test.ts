import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiBackendAdapter } from './GeminiBackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';

describe('GeminiBackendAdapter', () => {
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

  it('sends correct URL and body', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [{ role: 'user', content: 'Hello' }], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=gemini-key',
    );
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
    expect(body.generationConfig.maxOutputTokens).toBe(100);
  });

  it('prefixes model with models/ if missing', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/models/gemini-2.0-flash:streamGenerateContent');
  });

  it('extracts system messages to systemInstruction', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'Hello' },
        ],
        tokenUsage: { prompt: 10, completion: 100 },
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be helpful.' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
  });

  it('streams text tokens and captures usage', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}',
        'data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    const emitted = items.filter((i) => i.type === 'text').map((i) => i.token);

    expect(emitted).toEqual(['Hello', ' world']);
    expect(result.finishReason).toBe('stop');
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(2);
  });

  it('converts image parts to inlineData', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe:' },
              { type: 'image', source: 'data:image/png;base64,ABC123' },
              { type: 'image', source: 'https://example.com/img.png' },
            ],
          },
        ],
        tokenUsage: { prompt: 10, completion: 100 },
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts).toEqual([
      { text: 'Describe:' },
      { inlineData: { mimeType: 'image/png', data: 'ABC123' } },
      { fileData: { mimeType: 'image/png', fileUri: 'https://example.com/img.png' } },
    ]);
  });

  it('converts tool definitions to functionDeclarations', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [],
        tokenUsage: { prompt: 10, completion: 100 },
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      },
    ]);
  });

  it('converts tool_use and tool_result content parts', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'tu_1', name: 'get_weather', content: 'Sunny' }],
          },
        ],
        tokenUsage: { prompt: 10, completion: 100 },
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts).toEqual([{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }]);
    expect(body.contents[1].parts).toEqual([
      { functionResponse: { name: 'get_weather', response: { result: 'Sunny' } } },
    ]);
  });

  it('applies responseFormat as generationConfig responseMimeType and responseSchema', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [],
        tokenUsage: { prompt: 10, completion: 100 },
        responseFormat: { type: 'json_schema', schema: { type: 'object', properties: { name: { type: 'string' } } } },
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
  });

  it('merges params into generationConfig', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
      params: { temperature: 0.5 },
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 }, params: { topK: 5 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.temperature).toBe(0.5);
    expect(body.generationConfig.topK).toBe(5);
  });

  it('returns error on HTTP failure', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'bad-key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Invalid API key',
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('400');
  });

  it('lists built-in models', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'key',
      model: 'gemini-2.0-flash',
    });

    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!).toHaveProperty('contextLength');
  });

  it('returns error when no response body', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: null,
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('No response body');
  });

  it('returns requestScript error without leaking SSRF details', async () => {
    // Cloud-configured backend: a script redirecting to a private address must
    // still be SSRF-blocked (loopback is only allowed for loopback-configured
    // backends).
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'key',
      model: 'gemini-2.0-flash',
      requestScript: 'request.url = "http://10.0.0.5/internal"',
    });

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('Request script error');
  });

  it('streams reasoning tokens for thought parts', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'key',
      model: 'gemini-2.5-pro',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}],"role":"model"}}]}',
        'data: {"candidates":[{"content":{"parts":[{"text":"answer"}],"role":"model"},"finishReason":"STOP"}]}',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    const reasoning = items.filter((i) => i.type === 'reasoning').map((i) => i.token);
    const text = items.filter((i) => i.type === 'text').map((i) => i.token);
    expect(reasoning).toEqual(['thinking...']);
    expect(text).toEqual(['answer']);
    expect(result.finishReason).toBe('stop');
  });

  it('aborts streaming when signal is aborted', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'key',
      model: 'gemini-2.0-flash',
    });

    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return {
        ok: true,
        body: new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n'));
            controller.close();
          },
        }),
      } as Response;
    });

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 1, completion: 10 } },
      controller.signal,
    ));
    expect(result.finishReason).toBe('error');
    expect(result.error).toBe('Aborted');
  });

  it('ignores malformed SSE lines', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'not a data line',
        'data: not-json',
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 1, completion: 10 } },
      new AbortController().signal,
    ));
    expect(items.filter((i) => i.type === 'text').map((i) => i.token)).toEqual(['ok']);
    expect(result.finishReason).toBe('stop');
  });

  it('canonicalizes Gemini finish reasons', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'key',
      model: 'gemini-2.0-flash',
    });

    for (const [raw, expected] of [['MAX_TOKENS', 'length'], ['SAFETY', 'content_filter'], ['RECITATION', 'content_filter'], ['OTHER', 'error']] as const) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        body: createMockStream([
          `data: {"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"${raw}"}]}`,
        ]),
      } as Response);

      const { result } = await consumeStream(adapter.stream(
        { messages: [], tokenUsage: { prompt: 1, completion: 10 } },
        new AbortController().signal,
      ));
      expect(result.finishReason).toBe(expected);
    }
  });

  it('parses streaming functionCall parts', async () => {
    const adapter = new GeminiBackendAdapter({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.id).toBe('get_weather');
    expect(result.toolCalls![0]!.name).toBe('get_weather');
    expect(result.toolCalls![0]!.arguments).toEqual({ city: 'Paris' });
  });
});
