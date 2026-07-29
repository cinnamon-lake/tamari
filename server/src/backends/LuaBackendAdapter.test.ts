import { describe, expect, it, vi } from 'vitest';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import {
  LuaBackendAdapter,
  runAdapterBlocking,
  type CustomBackendDelegate,
  type DelegatedGenerateResult,
} from './LuaBackendAdapter.js';
import type { BackendAdapter, BackendStreamItem, GenerationResult, Prompt } from './BackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';

function makePrompt(): Prompt {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    tokenUsage: { prompt: 10, completion: 5 },
  };
}

function makeDelegate(overrides: Partial<CustomBackendDelegate> = {}): CustomBackendDelegate {
  return {
    generate: vi.fn(async (configId: string | null): Promise<DelegatedGenerateResult> => ({
      text: `delegated:${configId ?? 'default'}`,
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 7 },
    })),
    resolveAdapter: vi.fn(async () => {
      throw new Error('resolveAdapter not expected');
    }),
    ...overrides,
  };
}

function makeAdapter(luaSource: string, delegate = makeDelegate()): LuaBackendAdapter {
  return new LuaBackendAdapter({
    id: 'custom:test',
    name: 'Test Backend',
    luaSource,
    runtime: new LuaRuntime(),
    delegate,
  });
}

async function run(adapter: LuaBackendAdapter) {
  return consumeStream(adapter.stream(makePrompt(), new AbortController().signal, { chatId: 'chat1', generationType: 'normal' }));
}

describe('LuaBackendAdapter', () => {
  it('streams a plain string result as one text chunk', async () => {
    const adapter = makeAdapter('function generate(prompt, ctx) return "Hello, world" end');
    const { items, result } = await run(adapter);
    expect(items).toEqual([{ type: 'text', token: 'Hello, world' }]);
    expect(result.finishReason).toBe('stop');
    expect(result.error).toBeUndefined();
  });

  it('accepts a table result with text, reasoning, and usage', async () => {
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        return { text = "answer", reasoning = "thoughts", usage = { promptTokens = 11, completionTokens = 13 } }
      end
    `);
    const { items, result } = await run(adapter);
    expect(items).toEqual([
      { type: 'reasoning', token: 'thoughts' },
      { type: 'text', token: 'answer' },
    ]);
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 13 });
    expect(result.reasoningText).toBe('thoughts');
  });

  it('surfaces a script-reported error', async () => {
    const adapter = makeAdapter('function generate(prompt, ctx) return { error = "model exploded" } end');
    const { result } = await run(adapter);
    expect(result.finishReason).toBe('error');
    expect(result.error).toBe('model exploded');
  });

  it('errors when the script does not define generate', async () => {
    const adapter = makeAdapter('local x = 1');
    const { result } = await run(adapter);
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('does not define generate');
  });

  it('errors on an unusable return value', async () => {
    const adapter = makeAdapter('function generate(prompt, ctx) return nil end');
    const { result } = await run(adapter);
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('must return a string');
  });

  it('errors when the script throws', async () => {
    const adapter = makeAdapter('function generate(prompt, ctx) error("boom") end');
    const { result } = await run(adapter);
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('boom');
  });

  it('maps a runaway script to a clean timeout error', async () => {
    const adapter = new LuaBackendAdapter({
      id: 'custom:test',
      name: 'Test Backend',
      luaSource: 'function generate(prompt, ctx) while true do end end',
      runtime: new LuaRuntime(),
      delegate: makeDelegate(),
      generateTimeoutMs: 250,
    });
    const { result } = await run(adapter);
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('timed out');
    expect(result.error).not.toContain('Aborted');
  });

  it('exposes ctx and a mutable prompt to the script', async () => {
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        local first = prompt.messages[1]
        return ctx.chatId .. "|" .. ctx.generationType .. "|" .. first.role .. "|" .. first.content
      end
    `);
    const { items } = await run(adapter);
    expect(items).toEqual([{ type: 'text', token: 'chat1|normal|user|Hello' }]);
  });

  it('delegates via backends.generate and aggregates usage', async () => {
    const delegate = makeDelegate();
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        local a = backends.generate(prompt):await()            -- default delegate
        local b = backends.generate("cfg-1", prompt):await()   -- explicit by id
        return a.text .. " & " .. b.text
      end
    `, delegate);
    const { items, result } = await run(adapter);
    expect(delegate.generate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(delegate.generate).mock.calls[0]![0]).toBeNull();
    expect(vi.mocked(delegate.generate).mock.calls[1]![0]).toBe('cfg-1');
    expect(items).toEqual([{ type: 'text', token: 'delegated:default & delegated:cfg-1' }]);
    expect(result.usage).toEqual({ promptTokens: 6, completionTokens: 14 });
  });

  it('errors when delegation fails', async () => {
    const delegate = makeDelegate({
      generate: vi.fn(async () => {
        throw new Error('backend "nope" not found');
      }),
    });
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        local res = backends.generate("nope", prompt):await()
        return res.text
      end
    `, delegate);
    const { result } = await run(adapter);
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('not found');
  });

  it('passthrough mode streams natively from the resolved adapter', async () => {
    const passthroughAdapter: BackendAdapter = {
      id: 'mock',
      supportsStreaming: true,
      supportsTools: false,
      async *stream(): AsyncGenerator<BackendStreamItem, GenerationResult> {
        yield { type: 'text', token: 'tok1 ' };
        yield { type: 'text', token: 'tok2' };
        return { finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 } };
      },
      listModels: async () => [],
    };
    const delegate = makeDelegate({ resolveAdapter: vi.fn(async () => passthroughAdapter) });
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        return { __passthrough = true }
      end
    `, delegate);
    const { items, result } = await run(adapter);
    expect(delegate.resolveAdapter).toHaveBeenCalledWith(null);
    expect(items).toEqual([
      { type: 'text', token: 'tok1 ' },
      { type: 'text', token: 'tok2' },
    ]);
    expect(result.usage).toEqual({ promptTokens: 1, completionTokens: 2 });
  });

  it('listModels proxies the script list_models()', async () => {
    const adapter = makeAdapter(`
      function generate(prompt, ctx) return "x" end
      function list_models()
        return { { id = "m1", name = "Model One" }, { id = "m2" } }
      end
    `);
    expect(await adapter.listModels()).toEqual([
      { id: 'm1', name: 'Model One' },
      { id: 'm2', name: 'm2' },
    ]);
  });

  it('listModels returns [] when the script has no list_models', async () => {
    const adapter = makeAdapter('function generate(prompt, ctx) return "x" end');
    expect(await adapter.listModels()).toEqual([]);
  });

  it('maps a toolCalls return into GenerationResult.toolCalls', async () => {
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        return {
          toolCalls = {
            { name = "speak", arguments = { text = "hi there", voice = "anna" } },
            { id = "custom-id", name = "forge_image", arguments = { prompt = "a dragon" } },
          },
        }
      end
    `);
    const { items, result } = await run(adapter);
    expect(items).toEqual([]);
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([
      { id: 'lua_call_1', name: 'speak', arguments: { text: 'hi there', voice: 'anna' } },
      { id: 'custom-id', name: 'forge_image', arguments: { prompt: 'a dragon' } },
    ]);
  });

  it('allows text alongside toolCalls', async () => {
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        return { text = "Let me say that out loud.", toolCalls = { { name = "speak" } } }
      end
    `);
    const { items, result } = await run(adapter);
    expect(items).toEqual([{ type: 'text', token: 'Let me say that out loud.' }]);
    expect(result.toolCalls).toEqual([{ id: 'lua_call_1', name: 'speak', arguments: {} }]);
  });

  it('skips malformed toolCall entries and errors when none are usable', async () => {
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        return { toolCalls = { { arguments = {} }, "not a table", { name = 42 } } }
      end
    `);
    const { result } = await run(adapter);
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('must return a string');
  });
});

describe('runAdapterBlocking', () => {
  it('collects text and usage from an adapter stream', async () => {
    const adapter: BackendAdapter = {
      id: 'mock',
      supportsStreaming: true,
      supportsTools: false,
      async *stream(): AsyncGenerator<BackendStreamItem, GenerationResult> {
        yield { type: 'reasoning', token: 'r' };
        yield { type: 'text', token: 'a' };
        yield { type: 'text', token: 'b' };
        return { finishReason: 'stop', usage: { promptTokens: 4, completionTokens: 2 }, reasoningText: 'r' };
      },
      listModels: async () => [],
    };
    const result = await runAdapterBlocking(adapter, makePrompt(), new AbortController().signal);
    expect(result).toEqual({
      text: 'ab',
      reasoning: 'r',
      finishReason: 'stop',
      error: undefined,
      usage: { promptTokens: 4, completionTokens: 2 },
    });
  });
});
