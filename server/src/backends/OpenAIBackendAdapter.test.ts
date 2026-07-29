import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIBackendAdapter } from './OpenAIBackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';

vi.mock('dns', () => ({
  default: {
    promises: {
      lookup: vi.fn(async (_hostname: string, _opts: unknown) => {
        return [{ address: '93.184.216.34', family: 4 }];
      }),
    },
  },
}));

describe('OpenAIBackendAdapter', () => {
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
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [{ role: 'user', content: 'Hello' }], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-4o');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('uses max_completion_tokens for reasoning models', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'o3-mini',
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
    expect(body.max_completion_tokens).toBe(100);
    expect(body.max_tokens).toBeUndefined();
  });

  it('streams tokens and returns usage', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    const emitted = items.filter((i) => i.type === 'text').map((i) => i.token);
    expect(emitted).toEqual(['Hello', ' world']);
    expect(result.finishReason).toBe('stop');
    expect(result.usage.completionTokens).toBe(2);
  });

  it('formats tool_calls on assistant messages', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check that.' },
              { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
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
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: 'Let me check that.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ],
    });
  });

  it('formats tool messages with tool_call_id', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          {
            role: 'tool',
            content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'Sunny', isError: false }],
          },
        ],
        tokenUsage: { prompt: 10, completion: 100 },
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0]).toEqual({
      role: 'tool',
      content: 'Sunny',
      tool_call_id: 'call_1',
    });
  });

  it('interleaves assistant and tool messages for multi-round tool calls', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Need weather.' },
              { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
              { type: 'tool_result', toolUseId: 'call_1', name: 'get_weather', content: 'Sunny', isError: false },
              { type: 'reasoning', text: 'Need time.' },
              { type: 'tool_use', id: 'call_2', name: 'get_time', input: { tz: 'CET' } },
              { type: 'tool_result', toolUseId: 'call_2', name: 'get_time', content: '15:00', isError: false },
              { type: 'text', text: 'It is sunny and 15:00.' },
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
    expect(body.messages).toHaveLength(5);
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'Need weather.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ],
    });
    expect(body.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'Sunny',
    });
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'Need time.',
      tool_calls: [
        {
          id: 'call_2',
          type: 'function',
          function: { name: 'get_time', arguments: '{"tz":"CET"}' },
        },
      ],
    });
    expect(body.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_2',
      content: '15:00',
    });
    expect(body.messages[4]).toEqual({
      role: 'assistant',
      content: 'It is sunny and 15:00.',
    });
  });

  it('converts image parts to OpenAI image_url format', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this:' },
              { type: 'image', source: 'https://example.com/img.png', detail: 'high' },
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
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Describe this:' },
      { type: 'image_url', image_url: { url: 'https://example.com/img.png', detail: 'high' } },
    ]);
  });

  it('merges params from config and prompt', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      params: { temperature: 0.5, topP: 0.9 },
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 }, params: { temperature: 0.8 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.8);
    expect(body.top_p).toBe(0.9);
  });

  it('applies responseFormat json_schema', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
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
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { schema: { type: 'object', properties: { name: { type: 'string' } } }, strict: true },
    });
  });

  it('returns error on HTTP failure', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
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

  it('mutates request via Lua script before sending', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      requestScript: `
        request.url = "http://proxy.local/v1/chat/completions"
        request.headers["X-Custom-Auth"] = "my-secret"
        request.body.temperature = 0.5
      `,
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

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://proxy.local/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Custom-Auth']).toBe('my-secret');
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.5);
  });

  it('returns error result when Lua script throws', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      requestScript: `error("bad syntax")`,
    });

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('Request script error');
    expect(result.error).toContain('bad syntax');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses streaming tool calls from deltas', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"index":0}]}',
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather"}}]},"index":0}]}',
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\": \\"Paris\\"}"}}]},"index":0}]}',
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"finish_reason":"tool_calls","index":0}]}',
        'data: [DONE]',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.id).toBe('call_1');
    expect(result.toolCalls![0]!.name).toBe('get_weather');
    expect(result.toolCalls![0]!.arguments).toEqual({ city: 'Paris' });
  });

  it('emits reasoning to emitReasoning for normal providers (content key present)', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"choices":[{"delta":{"content":null,"reasoning_content":"Let me think"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":null,"reasoning_content":"..."},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    const emitted = items.filter((i) => i.type === 'text').map((i) => i.token);
    const reasoning = items.filter((i) => i.type === 'reasoning').map((i) => i.token);
    expect(emitted).toEqual(['Hello']);
    expect(reasoning).toEqual(['Let me think', '...']);
    expect(result.finishReason).toBe('stop');
  });

  it('emits reasoning as message text for Fireworks-style streams (no content key)', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.fireworks.ai/v1',
      apiKey: 'fw-test',
      model: 'glm-5',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"choices":[{"delta":{"reasoning_content":"Hello"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"reasoning_content":" world"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    const emitted = items.filter((i) => i.type === 'text').map((i) => i.token);
    const reasoning = items.filter((i) => i.type === 'reasoning').map((i) => i.token);
    // Buffered reasoning is emitted as a single text block at stream end
    expect(emitted).toEqual(['Hello world']);
    expect(reasoning).toEqual([]);
    expect(result.finishReason).toBe('stop');
  });

  it('handles reasoning then content for normal providers', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'o3-mini',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    const emitted = items.filter((i) => i.type === 'text').map((i) => i.token);
    const reasoning = items.filter((i) => i.type === 'reasoning').map((i) => i.token);
    expect(emitted).toEqual(['Answer']);
    expect(reasoning).toEqual(['Thinking...']);
    expect(result.finishReason).toBe('stop');
  });

  it('handles SSE lines without space after data: (Kimi-style)', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-test',
      model: 'kimi-for-coding',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data:{"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
        'data:{"choices":[{"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}',
        'data:{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
        'data:{"choices":[{"delta":{},"finish_reason":"stop","usage":{"prompt_tokens":10,"completion_tokens":5}}]}',
        'data:{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
        'data: [DONE]',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    const emitted = items.filter((i) => i.type === 'text').map((i) => i.token);
    const reasoning = items.filter((i) => i.type === 'reasoning').map((i) => i.token);
    expect(emitted).toEqual(['Hello']);
    expect(reasoning).toEqual(['Let me think']);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });
});
