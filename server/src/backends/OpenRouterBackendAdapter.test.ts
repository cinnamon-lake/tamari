import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterBackendAdapter } from './OpenRouterBackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';

describe('OpenRouterBackendAdapter', () => {
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

  it('sends OpenRouter-specific headers', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'anthropic/claude-3.5-sonnet',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['HTTP-Referer']).toBe('https://github.com/cinnamon-lake/tamari');
    expect(headers['X-Title']).toBe('tamari');
  });

  it('includes provider routing in request body', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
      providerOrder: ['Anthropic', 'OpenAI'],
      allowFallbacks: false,
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.provider).toEqual({
      order: ['Anthropic', 'OpenAI'],
      allow_fallbacks: false,
    });
  });

  it('streams tokens and extracts reasoning text', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'deepseek-r1',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"choices":[{"delta":{"reasoning":"Let me think","content":""},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"reasoning":"...","content":"Hello"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const emitted = items.filter((i) => i.type === 'text').map((i) => i.token);
    expect(emitted).toEqual(['Hello', ' world']);
    expect(result.reasoningText).toBe('Let me think...');
    expect(result.finishReason).toBe('stop');
  });

  it('returns error on HTTP failure', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'bad-key',
      model: 'gpt-4o',
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Invalid credentials',
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('401');
  });

  it('applies OpenRouter-specific sampling params from the params blob', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
      // Sampler knobs reach the wire through the params blob (snake-cased by
      // the inherited OpenAI buildRequest): minP → min_p, topA → top_a, …
      params: { minP: 0.05, topA: 0.5, repetitionPenalty: 1.1 },
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.min_p).toBe(0.05);
    expect(body.top_a).toBe(0.5);
    expect(body.repetition_penalty).toBe(1.1);
  });

  it('sends reasoning effort and summary in request body', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'deepseek-r1',
      reasoningEffort: 'high',
      reasoningSummary: 'concise',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'concise' });
  });

  it('omits reasoning body when no effort or summary is set', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'deepseek-r1',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.reasoning).toBeUndefined();
  });

  it('injects cache_control for Claude models when cacheDepth is set', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'anthropic/claude-3.5-sonnet',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'How are you?' },
        ],
        tokenUsage: { prompt: 10, completion: 100 },
        cacheDepth: 0,
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    // System prompt cached
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral' } },
    ]);

    // Depth cache at first non-system role transition from end
    // Skipping assistant prefill (index 2), then user at index 1 is depth 0
    expect(body.messages[1].content).toEqual([{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }]);
  });

  it('injects cache TTL when cacheTTL is configured', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'anthropic/claude-3.5-sonnet',
      cacheTTL: '1h',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'How are you?' },
        ],
        tokenUsage: { prompt: 10, completion: 100 },
        cacheDepth: 0,
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
  });

  it('accumulates streaming tool calls', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'anthropic/claude-opus-4',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"choices":[{"delta":{"content":null,"role":"assistant","tool_calls":[{"index":0,"id":"toolu_01","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\": \\"Pa"}}]},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ris\\"}"}}]},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"","role":"assistant"},"finish_reason":"tool_calls","native_finish_reason":"tool_use"}]}',
        'data: [DONE]',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [{ role: 'user', content: 'Weather in Paris?' }],
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
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({
      id: 'toolu_01',
      name: 'get_weather',
      arguments: { city: 'Paris' },
    });
  });

  it('does not inject cache_control for non-Claude models even when cacheTTL is set', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
      cacheTTL: '1h',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'Hello' },
        ],
        tokenUsage: { prompt: 10, completion: 100 },
        cacheDepth: 0,
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toBe('Be helpful.');
    expect(body.messages[1].content).toBe('Hello');
  });
});
