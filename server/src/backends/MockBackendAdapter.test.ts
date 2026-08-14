import { describe, it, expect } from 'vitest';
import { MockBackendAdapter, parseMockScript } from './MockBackendAdapter.js';
import { consumeStream, type BackendStreamItem, type GenerationResult } from './BackendAdapter.js';
import { createBackendAdapter, buildAdapterFactoryInput } from './factory.js';
import type { Prompt } from '@tamari/types';

function prompt(messages: Prompt['messages'] = []): Prompt {
  return { messages, tokenUsage: { prompt: 1, completion: 10 } };
}

function stream(backend: MockBackendAdapter, p: Prompt, signal = new AbortController().signal) {
  return consumeStream(backend.stream(p, signal));
}

function textOf(items: BackendStreamItem[]): string {
  return items
    .filter((i) => i.type === 'text')
    .map((i) => i.token)
    .join('');
}

describe('parseMockScript', () => {
  it('parses respond/seq/tool directives, skipping blanks and comments', () => {
    const directives = parseMockScript(
      [
        '# a comment',
        '',
        'respond: hello there',
        'seq:2:second call',
        'tool:get_weather:{"city":"Paris"}',
        'tool:broken:{not json',
      ].join('\n'),
    );
    expect(directives).toEqual([
      { kind: 'respond', text: 'hello there' },
      { kind: 'seq', call: 2, text: 'second call' },
      { kind: 'tool', name: 'get_weather', args: { city: 'Paris' } },
      // Malformed args degrade to {} (mockLlmServer's parseToolSequence rule).
      { kind: 'tool', name: 'broken', args: {} },
    ]);
  });
});

describe('MockBackendAdapter', () => {
  it('respond: is the canned reply for every call', async () => {
    const backend = new MockBackendAdapter('respond:canned reply');
    const { items, result } = await stream(backend, prompt());
    expect(textOf(items)).toBe('canned reply');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();

    // Still the default on the next call.
    const second = await stream(backend, prompt());
    expect(textOf(second.items)).toBe('canned reply');
  });

  it('seq:<n>: overrides the reply for the nth call only', async () => {
    const backend = new MockBackendAdapter(['respond:default', 'seq:2:second!'].join('\n'));
    expect(textOf((await stream(backend, prompt())).items)).toBe('default');
    expect(textOf((await stream(backend, prompt())).items)).toBe('second!');
    expect(textOf((await stream(backend, prompt())).items)).toBe('default');
  });

  it('falls back to a fixed default when the script matches nothing', async () => {
    const backend = new MockBackendAdapter('');
    const { items, result } = await stream(backend, prompt());
    expect(textOf(items)).toBe('This is a deterministic mock response.');
    expect(result.finishReason).toBe('stop');
  });

  it('tool: emits a tool call, then walks the sequence by tool results in the prompt', async () => {
    const backend = new MockBackendAdapter(
      ['tool:first:{"a":1}', 'tool:second:{"b":2}', 'respond:all done'].join('\n'),
    );

    // No tool results in the prompt → the first tool: directive fires.
    const round1: { items: BackendStreamItem[]; result: GenerationResult } = await stream(backend, prompt());
    expect(round1.result.toolCalls).toEqual([{ id: 'mock-call-1', name: 'first', arguments: { a: 1 } }]);
    const streamed = round1.items.find((i) => i.type === 'toolCall');
    expect(streamed).toEqual({ type: 'toolCall', id: 'mock-call-1', name: 'first', arguments: { a: 1 } });

    // One tool result visible → the second directive fires.
    const withOneResult = prompt([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'mock-call-1', name: 'first', input: { a: 1 } }] },
      { role: 'tool', content: 'result of first' },
    ]);
    const round2 = await stream(backend, withOneResult);
    expect(round2.result.toolCalls).toEqual([{ id: 'mock-call-2', name: 'second', arguments: { b: 2 } }]);

    // Sequence exhausted → falls through to respond:.
    const withTwoResults = prompt([
      { role: 'tool', content: 'result of first' },
      { role: 'tool', content: 'result of second' },
    ]);
    const round3 = await stream(backend, withTwoResults);
    expect(round3.result.toolCalls).toBeUndefined();
    expect(textOf(round3.items)).toBe('all done');
  });

  it('abort mid-stream returns an error result', async () => {
    const backend = new MockBackendAdapter('respond:a much longer canned reply that takes several ticks');
    const controller = new AbortController();
    const gen = backend.stream(prompt(), controller.signal);
    const first = await gen.next();
    expect(first.done).toBe(false);
    controller.abort();
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    expect(next.value.finishReason).toBe('error');
    expect(next.value.error).toBe('Aborted');
  });

  it('captures every prompt on requests', async () => {
    const backend = new MockBackendAdapter('respond:hi');
    await stream(backend, prompt([{ role: 'user', content: 'one' }]));
    await stream(backend, prompt([{ role: 'user', content: 'two' }]));
    expect(backend.requests).toHaveLength(2);
    expect(backend.requests[1]?.messages[0]?.content).toBe('two');
  });
});

describe('mock provider registration', () => {
  it('buildAdapterFactoryInput surfaces providerParams mockScript', () => {
    const input = buildAdapterFactoryInput({
      backendProvider: 'mock',
      model: 'mock-model',
      mockScript: 'respond:hi',
    });
    expect(input.provider).toBe('mock');
    expect(input.mockScript).toBe('respond:hi');
  });

  it('creates the mock adapter without an API key, in chat and text mode', async () => {
    for (const generationMode of ['chat', 'text']) {
      const adapter = createBackendAdapter(
        buildAdapterFactoryInput({
          backendProvider: 'mock',
          model: 'mock-model',
          generationMode,
          mockScript: 'respond:scripted',
        }),
      );
      expect(adapter).not.toBeNull();
      expect(adapter!.id).toBe('mock');
      const { items } = await consumeStream(adapter!.stream(prompt(), new AbortController().signal));
      expect(textOf(items)).toBe('scripted');
    }
  });
});
