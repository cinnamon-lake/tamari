import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeBackendAdapter } from './ClaudeBackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';

describe('ClaudeBackendAdapter', () => {
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
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [{ role: 'user', content: 'Hello' }], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-sonnet-4-20250514');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(100);
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('extracts system messages to top-level system param', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
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
    expect(body.system).toBe('Be helpful.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('includes prompt.systemPrompt in system param', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [{ role: 'user', content: 'Hello' }],
        tokenUsage: { prompt: 10, completion: 100 },
        systemPrompt: 'You are a wizard.',
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('You are a wizard.');
  });

  it('streams text tokens and captures usage', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
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

  it('extracts thinking / reasoning text', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":1}',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 5, completion: 100 } },
      new AbortController().signal,
    ));
    const emitted = items.filter((i) => i.type === 'text').map((i) => i.token);
    expect(result.finishReason).toBe('stop');

    expect(emitted).toEqual(['Answer']);
    expect(result.reasoningText).toBe('Let me think...');
    expect(result.finishReason).toBe('stop');
  });

  it('converts image parts to Claude image blocks', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this:' },
              { type: 'image', source: 'data:image/png;base64,ABC123', mimeType: 'image/png' },
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
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Describe this:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ABC123' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
    ]);
  });

  it('converts tool definitions to Claude format', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
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
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
  });

  it('converts tool_use and tool_result content parts', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
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
            content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'Sunny', isError: false }],
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
      { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
    ]);
    expect(body.messages[1].content).toEqual([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Sunny' }]);
  });

  it('merges params from config and prompt', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
      params: { temperature: 0.5 },
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 }, params: { temperature: 0.8, topK: 5 } },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.8);
    expect(body.top_k).toBe(5);
  });

  it('applies output_config for structured JSON outputs', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
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
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: { type: 'object', properties: { name: { type: 'string' } } } },
    });
  });

  it('adds strict: true to tools when strictTools param is set', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [],
        tokenUsage: { prompt: 10, completion: 100 },
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
          },
        ],
        params: { strictTools: true },
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([
      { name: 'get_weather', description: 'Get weather', input_schema: { type: 'object' }, strict: true },
    ]);
  });

  it('returns error on HTTP failure', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'bad-key',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Invalid API key',
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('401');
  });

  it('injects cache_control and beta headers when cacheDepth is set', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'How are you?' },
        ],
        tokenUsage: { prompt: 10, completion: 100 },
        cacheDepth: 0,
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toContain('prompt-caching-2024-07-31');
    expect(headers['anthropic-beta']).toContain('extended-cache-ttl-2025-04-11');

    const body = JSON.parse(init.body as string);
    // cacheDepth=0 should mark the first non-prefill role transition (user at index 0)
    // After skipping prefill (assistant at index 2), we count:
    // i=2 assistant (skip), i=1 assistant→assistant (same role, no count), i=0 user (depth 0)
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }]);
  });

  it('caches system prompt and tools when cacheDepth is set', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [{ role: 'user', content: 'Hello' }],
        tokenUsage: { prompt: 10, completion: 100 },
        systemPrompt: 'You are a wizard.',
        cacheDepth: 0,
        tools: [
          {
            type: 'function',
            function: { name: 'cast_spell', description: 'Cast a spell', parameters: { type: 'object' } },
          },
        ],
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system).toEqual([{ type: 'text', text: 'You are a wizard.', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools).toEqual([
      {
        name: 'cast_spell',
        description: 'Cast a spell',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('applies cache TTL when configured', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
      cacheTTL: '1h',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      {
        messages: [{ role: 'user', content: 'Hello' }],
        tokenUsage: { prompt: 10, completion: 100 },
        systemPrompt: 'You are a wizard.',
        cacheDepth: 0,
        tools: [
          {
            type: 'function',
            function: { name: 'cast_spell', description: 'Cast a spell', parameters: { type: 'object' } },
          },
        ],
      },
      new AbortController().signal,
    ));
    expect(result.finishReason).toBe('stop');

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system).toEqual([
      { type: 'text', text: 'You are a wizard.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    expect(body.tools).toEqual([
      {
        name: 'cast_spell',
        description: 'Cast a spell',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
  });

  it('parses streaming tool_use blocks', async () => {
    const adapter = new ClaudeBackendAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\": \\"Paris\\"}"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ]),
    } as Response);

    const { result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.id).toBe('tu_1');
    expect(result.toolCalls![0]!.name).toBe('get_weather');
    expect(result.toolCalls![0]!.arguments).toEqual({ city: 'Paris' });
  });
});
