import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoonshotBackendAdapter } from './MoonshotBackendAdapter.js';
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

describe('MoonshotBackendAdapter', () => {
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
    const adapter = new MoonshotBackendAdapter({
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-test',
      model: 'kimi-k2.6',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.moonshot.ai/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('kimi-k2.6');
    expect(body.stream).toBe(true);
  });

  it('parses streaming tool calls from deltas', async () => {
    const adapter = new MoonshotBackendAdapter({
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-test',
      model: 'kimi-k2.6',
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

  it('parses reasoning_content deltas', async () => {
    const adapter = new MoonshotBackendAdapter({
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-test',
      model: 'kimi-k2.6',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream([
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"","reasoning_content":"Let me think"},"index":0}]}',
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"","reasoning_content":" about this"},"index":0}]}',
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"index":0}]}',
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
        'data: [DONE]',
      ]),
    } as Response);

    const { items, result } = await consumeStream(adapter.stream(
      { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
      new AbortController().signal,
    ));

    const reasoningChunks = items.filter((i) => i.type === 'reasoning').map((i) => i.token);
    expect(result.finishReason).toBe('stop');
    expect(result.reasoningText).toBe('Let me think about this');
    expect(reasoningChunks).toEqual(['Let me think', ' about this']);
  });

  it('returns model list', async () => {
    const adapter = new MoonshotBackendAdapter({
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-test',
      model: 'kimi-k2.6',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        object: 'list',
        data: [
          { id: 'kimi-k2.6', object: 'model', created: 1698999496, owned_by: 'moonshot', context_length: 256000 },
          { id: 'kimi-k2-thinking', object: 'model', created: 1698999496, owned_by: 'moonshot', context_length: 256000 },
        ],
      }),
    } as Response);

    const models = await adapter.listModels();
    expect(models.some((m) => m.id === 'kimi-k2.6')).toBe(true);
    expect(models.some((m) => m.id === 'kimi-k2-thinking')).toBe(true);
    expect(models[0]!.contextLength).toBe(256000);
  });

  it('falls back to hardcoded list when API fails', async () => {
    const adapter = new MoonshotBackendAdapter({
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-test',
      model: 'kimi-k2.6',
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as Response);

    const models = await adapter.listModels();
    expect(models.some((m) => m.id === 'kimi-k2.6')).toBe(true);
  });
});
