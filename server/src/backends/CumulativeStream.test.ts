/**
 * Regression tests for the Fireworks-style cumulative-content defense.
 *
 * Some providers (Fireworks, etc.) send CUMULATIVE content in each SSE chunk
 * (the full text so far) instead of incremental deltas. OpenAIBackendAdapter
 * defends against this by tracking `lastContent` and emitting only the net-new
 * text (OpenAIBackendAdapter.ts `parseStream`). OpenRouterBackendAdapter used
 * to copy-paste `parseStream` and silently dropped that defense, so a
 * cumulative stream routed through OpenRouter produced duplicated text
 * (audit: docs/quality/audits/interface-audit-2026-07-20.md, bug #6).
 *
 * OpenRouter now inherits the parent's `parseStream` and only overrides the
 * `parseStreamChunk` validation hook, so both cases below must pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIBackendAdapter } from './OpenAIBackendAdapter.js';
import { OpenRouterBackendAdapter } from './OpenRouterBackendAdapter.js';
import { consumeStream, type BackendAdapter } from './BackendAdapter.js';

/**
 * SSE lines for a Fireworks-style stream where every chunk's `content` is the
 * full text so far, not a delta.
 */
const CUMULATIVE_SSE_LINES = [
  'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{"content":"Hello world"},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{"content":"Hello world!"},"finish_reason":"stop"}]}',
  'data: [DONE]',
];

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

async function streamCumulativeChunks(adapter: BackendAdapter) {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValueOnce({
    ok: true,
    body: createMockStream(CUMULATIVE_SSE_LINES),
  } as Response);
  try {
    const { items, result } = await consumeStream(adapter.stream(
      { messages: [{ role: 'user', content: 'Say hello' }], tokenUsage: { prompt: 5, completion: 50 } },
      new AbortController().signal,
    ));
    return { tokens: items.filter((i) => i.type === 'text').map((i) => i.token), result };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('cumulative (Fireworks-style) content streams', () => {
  beforeEach(() => {
    // each helper stubs its own fetch; nothing global needed here
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('OpenAIBackendAdapter emits only net-new text (control: passes)', async () => {
    const adapter = new OpenAIBackendAdapter({
      baseUrl: 'https://fireworks.example/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });

    const { tokens, result } = await streamCumulativeChunks(adapter);

    expect(tokens).toEqual(['Hello', ' world', '!']);
    expect(tokens.join('')).toBe('Hello world!');
    expect(result.finishReason).toBe('stop');
  });

  it('OpenRouterBackendAdapter emits only net-new text (BUG: duplicates content)', async () => {
    const adapter = new OpenRouterBackendAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'fireworks/llama-v3-70b',
    });

    const { tokens, result } = await streamCumulativeChunks(adapter);

    // The adapter must slice each cumulative chunk down to the incremental
    // delta, exactly like the parent OpenAI adapter does. Today it re-emits
    // the full cumulative content of every chunk, duplicating text.
    expect(tokens).toEqual(['Hello', ' world', '!']);
    expect(tokens.join('')).toBe('Hello world!');
    expect(result.finishReason).toBe('stop');
  });
});
