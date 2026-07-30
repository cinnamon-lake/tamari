import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBackendAdapter, buildAdapterFactoryInput } from './factory.js';
import { consumeStream } from './BackendAdapter.js';

describe('createBackendAdapter', () => {
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

  it('passes openai.params to the OpenRouter adapter so per-config samplers reach the body', async () => {
    const adapter = createBackendAdapter(
      buildAdapterFactoryInput({
        backendProvider: 'openrouter',
        apiKey: 'test-key',
        model: 'gpt-4o',
        'openai.params': { temperature: 0.7, seed: 42 },
      }),
    );
    expect(adapter).not.toBeNull();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: createMockStream(['data: [DONE]']),
    } as Response);

    await consumeStream(
      adapter!.stream(
        { messages: [], tokenUsage: { prompt: 10, completion: 100 } },
        new AbortController().signal,
      ),
    );

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.7);
    expect(body.seed).toBe(42);
  });

  it('returns null for a cloud provider with no api key (non-listing mode)', () => {
    const adapter = createBackendAdapter(
      buildAdapterFactoryInput({
        backendProvider: 'openrouter',
        apiKey: '',
        model: 'gpt-4o',
      }),
    );
    expect(adapter).toBeNull();
  });

  it('builds a local llamacpp adapter without an api key', () => {
    const adapter = createBackendAdapter(
      buildAdapterFactoryInput({
        backendProvider: 'llamacpp',
        apiUrl: 'http://localhost:8080',
        model: 'test',
        'textgen.params': { temperature: 0.5 },
      }),
    );
    expect(adapter).not.toBeNull();
  });

  it('throws a loud error for an unknown provider (no silent OpenAI fallback)', () => {
    expect(() =>
      createBackendAdapter(
        buildAdapterFactoryInput({
          backendProvider: 'not-a-provider',
          apiKey: 'test-key',
          model: 'gpt-4o',
        }),
      ),
    ).toThrow(/Unknown backend provider "not-a-provider"/);
  });

  it('still maps an unknown provider to text completion in text mode (legacy order)', () => {
    const adapter = createBackendAdapter(
      buildAdapterFactoryInput({
        backendProvider: 'not-a-provider',
        apiKey: 'test-key',
        model: 'test',
        generationMode: 'text',
      }),
    );
    expect(adapter).not.toBeNull();
  });

  it('text-completion mode still wins over the koboldcpp adapter (legacy order)', () => {
    const adapter = createBackendAdapter(
      buildAdapterFactoryInput({
        backendProvider: 'koboldcpp',
        apiKey: '',
        model: 'test',
        generationMode: 'text',
      }),
    );
    expect(adapter).not.toBeNull();
    expect(adapter!.supportsTools).toBe(false);
  });
});
