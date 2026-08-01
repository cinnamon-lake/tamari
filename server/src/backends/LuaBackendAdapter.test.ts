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

  describe('trace errors (debug traces)', () => {
    it('layers a script error as LUA_ERROR with the adapter name', async () => {
      const adapter = makeAdapter('function generate(prompt, ctx) error("boom") end');
      const { result } = await run(adapter);
      expect(result.traceError).toEqual({ code: 'LUA_ERROR', layer: 'Test Backend', message: expect.stringContaining('boom') });
    });

    it('layers a timeout as LUA_TIMEOUT', async () => {
      const adapter = new LuaBackendAdapter({
        id: 'custom:test',
        name: 'Test Backend',
        luaSource: 'function generate(prompt, ctx) while true do end end',
        runtime: new LuaRuntime(),
        delegate: makeDelegate(),
        generateTimeoutMs: 250,
      });
      const { result } = await run(adapter);
      expect(result.traceError?.code).toBe('LUA_TIMEOUT');
      expect(result.traceError?.layer).toBe('Test Backend');
    });

    it('layers a script-returned { error } as UNKNOWN with the layer', async () => {
      const adapter = makeAdapter('function generate(prompt, ctx) return { error = "model exploded" } end');
      const { result } = await run(adapter);
      expect(result.traceError).toEqual({ code: 'UNKNOWN', layer: 'Test Backend', message: 'model exploded' });
    });

    it('throws the rendered delegate chain into Lua (delegate traceError as cause)', async () => {
      const delegate = makeDelegate({
        generate: vi.fn(async (): Promise<DelegatedGenerateResult> => ({
          text: '',
          finishReason: 'error',
          error: 'boom',
          usage: { promptTokens: 0, completionTokens: 0 },
          traceError: { code: 'LUA_ERROR', layer: 'inner-lua', message: 'inner boom' },
        })),
      });
      // The script does NOT pcall — the thrown chain becomes the script's error.
      const adapter = makeAdapter(`
        function generate(prompt, ctx)
          local res = backends.generate(prompt):await()
          return res.text
        end
      `, delegate);
      const { result } = await run(adapter);
      expect(result.traceError?.code).toBe('LUA_ERROR');
      expect(result.traceError?.layer).toBe('Test Backend');
      // wasmoon appends a stack traceback after the thrown message.
      expect(result.traceError?.message).toContain('delegate(default) → inner-lua: LUA_ERROR: inner boom');
    });

    it('a pcall-ing script still sees the rendered chain as the thrown message', async () => {
      const delegate = makeDelegate({
        generate: vi.fn(async (): Promise<DelegatedGenerateResult> => ({
          text: '',
          finishReason: 'error',
          error: 'kaboom',
          usage: { promptTokens: 0, completionTokens: 0 },
        })),
      });
      const adapter = makeAdapter(`
        function generate(prompt, ctx)
          local ok, err = pcall(function() return backends.generate("cfg-9", prompt):await() end)
          if not ok then return { error = tostring(err) } end
          return "unreachable"
        end
      `, delegate);
      const { result } = await run(adapter);
      expect(result.error).toContain('delegate(cfg-9): DELEGATE_ERROR: kaboom');
      expect(result.traceError?.code).toBe('UNKNOWN');
    });

    it('layers a passthrough resolveAdapter failure as DELEGATE_ERROR', async () => {
      const delegate = makeDelegate({
        resolveAdapter: vi.fn(async () => {
          throw new Error('backend config "nope" not found');
        }),
      });
      const adapter = makeAdapter(`
        function generate(prompt, ctx)
          return { __passthrough = "nope" }
        end
      `, delegate);
      const { result } = await run(adapter);
      expect(result.traceError?.code).toBe('DELEGATE_ERROR');
      expect(result.traceError?.layer).toBe('Test Backend');
      expect(result.traceError?.message).toContain('not found');
    });
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

  it('surfaces delegate toolCalls to the script', async () => {
    const delegate = makeDelegate({
      generate: vi.fn(async (): Promise<DelegatedGenerateResult> => ({
        text: '',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: { sides: 20 } }],
      })),
    });
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        local res = backends.generate(prompt):await()
        if res.toolCalls and #res.toolCalls > 0 then
          local call = res.toolCalls[1]
          return call.id .. "|" .. call.name .. "|" .. tostring(call.arguments.sides)
        end
        return "no-calls"
      end
    `, delegate);
    const { items } = await run(adapter);
    expect(items).toEqual([{ type: 'text', token: 'call_1|roll_dice|20' }]);
  });

  it('round-trips a script-owned tool loop through the delegate', async () => {
    const seen: Prompt[] = [];
    const delegate = makeDelegate({
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        seen.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        if (seen.length === 1) {
          return {
            text: '',
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
            toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: { sides: 20 } }],
          };
        }
        return { text: 'You rolled 17.', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    });
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        local sub = {}
        for k, v in pairs(prompt) do sub[k] = v end
        sub.tools = { { type = "function", ["function"] = { name = "roll_dice", description = "Roll dice", parameters = { type = "object" } } } }
        local res = backends.generate(sub):await()
        while res.toolCalls and #res.toolCalls > 0 do
          local content = {}
          for _, call in ipairs(res.toolCalls) do
            content[#content + 1] = { type = "tool_use", id = call.id, name = call.name, input = call.arguments }
            content[#content + 1] = { type = "tool_result", toolUseId = call.id, name = call.name, content = "17" }
          end
          sub.messages[#sub.messages + 1] = { role = "assistant", content = content }
          res = backends.generate(sub):await()
        end
        return res.text
      end
    `, delegate);
    const { items } = await run(adapter);
    expect(items).toEqual([{ type: 'text', token: 'You rolled 17.' }]);
    expect(seen).toHaveLength(2);
    // Script-defined tool schemas cross as ToolDefinition[].
    expect(seen[0]!.tools).toEqual([
      { type: 'function', function: { name: 'roll_dice', description: 'Roll dice', parameters: { type: 'object' } } },
    ]);
    // The continuation message carries tool_use + tool_result parts (camelCase keys).
    const messages = seen[1]!.messages;
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'roll_dice', input: { sides: 20 } },
      { type: 'tool_result', toolUseId: 'call_1', name: 'roll_dice', content: '17' },
    ]);
  });

  it('exposes full branch history via the chat global (lazy, memoized)', async () => {
    const branch = [
      { id: '1', role: 'user', content: 'hello there' },
      { id: '2', role: 'assistant', content: 'five goblins attack' },
      { id: '3', role: 'user', content: 'I fight the goblins' },
    ];
    const branchHistory = vi.fn(async () => branch);
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        local n = chat.count():await()
        local m2 = chat.get(2):await()
        local missing = chat.get(99):await()
        local hits = chat.find("GOBLINS"):await()
        return table.concat({ tostring(n), m2.content, tostring(missing), tostring(#hits), tostring(hits[1].index), tostring(hits[2].index) }, "|")
      end
    `);
    const { items } = await consumeStream(
      adapter.stream(makePrompt(), new AbortController().signal, { chatId: 'chat1', generationType: 'normal', branchHistory }),
    );
    expect(items).toEqual([{ type: 'text', token: '3|five goblins attack|nil|2|3|2' }]);
    expect(branchHistory).toHaveBeenCalledTimes(1);
  });

  it('leaves chat nil when no branchHistory is provided', async () => {
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        if chat then return "present" end
        return "absent"
      end
    `);
    const { items } = await run(adapter);
    expect(items).toEqual([{ type: 'text', token: 'absent' }]);
  });

  it('normalizes response_format to responseFormat on delegate calls', async () => {
    const delegate = makeDelegate();
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        prompt.response_format = { type = 'json_schema', schema = { type = 'object' } }
        local res = backends.generate(prompt):await()
        return res.text
      end
    `, delegate);
    await run(adapter);
    const calledPrompt = vi.mocked(delegate.generate).mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(calledPrompt['responseFormat']).toEqual({ type: 'json_schema', schema: { type: 'object' } });
    expect(calledPrompt['response_format']).toBeUndefined();
  });

  it('keeps an explicit responseFormat over a snake_case duplicate', async () => {
    const delegate = makeDelegate();
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        prompt.responseFormat = { type = 'text' }
        prompt.response_format = { type = 'json_object' }
        local res = backends.generate(prompt):await()
        return res.text
      end
    `, delegate);
    await run(adapter);
    const calledPrompt = vi.mocked(delegate.generate).mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(calledPrompt['responseFormat']).toEqual({ type: 'text' });
  });

  it('normalizes response_format on the passthrough path', async () => {
    let seen: Prompt | undefined;
    const recordingAdapter: BackendAdapter = {
      id: 'mock',
      supportsStreaming: true,
      supportsTools: false,
      // Records the outgoing prompt; no chunks needed for this assertion.
      // eslint-disable-next-line require-yield
      async *stream(prompt: Prompt): AsyncGenerator<BackendStreamItem, GenerationResult> {
        seen = prompt;
        return { finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } };
      },
      listModels: async () => [],
    };
    const delegate = makeDelegate({ resolveAdapter: vi.fn(async () => recordingAdapter) });
    const adapter = makeAdapter(`
      function generate(prompt, ctx)
        prompt.response_format = { type = 'json_object' }
        return { __passthrough = true, prompt = prompt }
      end
    `, delegate);
    await run(adapter);
    expect((seen as unknown as Record<string, unknown>)['responseFormat']).toEqual({ type: 'json_object' });
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
