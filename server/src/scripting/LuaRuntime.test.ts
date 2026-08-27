import { describe, expect, it } from 'vitest';
import { LuaRuntime, friendlyLuaError } from './LuaRuntime.js';

describe('LuaRuntime timeout', () => {
  it('lets instruction-heavy scripts complete when under the deadline', async () => {
    // Regression: wasmoon's global.setTimeout takes an ABSOLUTE epoch-ms
    // deadline, not a duration. Passing a duration (e.g. 5000) put the deadline
    // in 1970, so the hook panicked on the first 1000-instruction batch and any
    // non-trivial script died instantly with "error object is not a string".
    const rt = new LuaRuntime();
    const { lua, cleanup } = await rt.createState({}, 5000);
    try {
      const result = await lua.doString(`
        local deck = {}
        for r = 1, 13 do
          for s = 1, 4 do
            deck[#deck + 1] = r .. ":" .. s
          end
        end
        for i = #deck, 2, -1 do
          local j = math.random(i)
          deck[i], deck[j] = deck[j], deck[i]
        end
        local text = table.concat(deck, ",")
        return (text:gsub(",", "|"))
      `);
      expect(typeof result).toBe('string');
      expect(String(result)).toContain('|');
    } finally {
      cleanup();
    }
  });

  it('kills a runaway script at the deadline', async () => {
    const rt = new LuaRuntime();
    const { lua, cleanup } = await rt.createState({}, 250);
    const start = Date.now();
    await expect(lua.doString('while true do end')).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(5000);
    cleanup();
  });
});

describe('wall ceiling with awaited host calls', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('lets a script await a slow host call well past short deadlines', async () => {
    // Waits are free within the wall ceiling: suspending on a host promise
    // consumes no instruction budget, so resuming afterwards is fine as long
    // as the resumed tail stays small (~one 1000-instruction hook batch).
    // This is why media templates can await multi-second APIs and QR scripts
    // can await slow LLM calls under their ceilings.
    const rt = new LuaRuntime();
    const { lua, cleanup } = await rt.createState({}, 250);

    const d = deferred<string>();
    setTimeout(() => d.resolve('done'), 700);
    // Deliver the promise as a host-call result — the same shape st.* / fetch
    // use (raw promises assigned as globals don't marshal into awaitables).
    lua.global.set('slow_op', () => d.promise);

    try {
      const result = await lua.doString(`
        local v = slow_op():await()
        return v .. ':ok'
      `);
      expect(result).toBe('done:ok');
    } finally {
      cleanup();
    }
  }, 10_000);

  it('still kills sustained post-deadline computation (busy loops ride the hook)', async () => {
    // A resumed tail BIGGER than one hook batch cannot hide behind the grace:
    // sustained computation past the armed deadline hard-aborts even when it
    // started life as an innocent await. The JS-side wall race in
    // QuickReplyService/LuaToolExecutor turns this case into a clean message.
    const rt = new LuaRuntime();
    const { lua, cleanup } = await rt.createState({}, 250);

    const d = deferred<string>();
    setTimeout(() => d.resolve('done'), 400);
    lua.global.set('slow_op', () => d.promise);

    try {
      await expect(
        lua.doString(`
          local v = slow_op():await()
          local s = 0
          for i = 1, 5000000 do s = s + i end
          return v .. ':' .. s
        `),
      ).rejects.toThrow(/Aborted\(native code called abort/);
    } finally {
      cleanup();
    }
  }, 10_000);
});

describe('friendlyLuaError', () => {
  it('maps both deadline families and passes other messages through', () => {
    // Yield-boundary family (not reachable via doString child threads today,
    // mapped anyway should upstream surface it)…
    expect(friendlyLuaError(new Error('thread timeout exceeded'), 300_000)).toContain('300s time limit between host calls');
    // …the WASM-hook abort family keeps its legacy wording…
    expect(friendlyLuaError('Aborted(native code called abort())', 5_000)).toBe('script timed out (5s execution limit)');
    // …and everything else passes through untouched.
    expect(friendlyLuaError('st.send: expected string', 5_000)).toBe('st.send: expected string');
  });
});

describe('LuaRuntime memory limit', () => {
  it('fails a memory bomb with "not enough memory" instead of crashing', async () => {
    const rt = new LuaRuntime();
    // 1 MB cap — the loop below would otherwise grow the heap unbounded.
    const { lua, cleanup } = await rt.createState({ maxMemoryBytes: 1024 * 1024 }, 5000);
    try {
      await expect(
        lua.doString(`
          local chunks = {}
          local i = 0
          while true do
            i = i + 1
            chunks[i] = string.rep('x', 65536)
          end
        `),
      ).rejects.toThrow(/memory/i);
    } finally {
      cleanup();
    }
  });

  it('lets scripts under the cap run normally', async () => {
    const rt = new LuaRuntime();
    const { lua, cleanup } = await rt.createState({ maxMemoryBytes: 1024 * 1024 }, 5000);
    try {
      const result = await lua.doString(`
        local t = {}
        for i = 1, 100 do t[i] = string.rep('y', 256) end
        return #table.concat(t)
      `);
      expect(result).toBe(100 * 256);
    } finally {
      cleanup();
    }
  });
});

describe('json.parse_result', () => {
  async function evalLua(source: string): Promise<unknown> {
    const rt = new LuaRuntime();
    const { lua, cleanup } = await rt.createState({}, 5000);
    try {
      return await lua.doString(source);
    } finally {
      cleanup();
    }
  }

  it('returns { value = ... } for valid JSON (objects and non-object roots)', async () => {
    expect(
      await evalLua(`
        local res = json.parse_result('{"a": 1}')
        if res.error then return 'err' end
        return res.value.a
      `),
    ).toBe(1);
    expect(
      await evalLua(`
        local res = json.parse_result('[1, 2, 3]')
        if res.error then return 'err' end
        return res.value[2]
      `),
    ).toBe(2);
    expect(
      await evalLua(`
        local res = json.parse_result('42')
        if res.error then return 'err' end
        return res.value
      `),
    ).toBe(42);
  });

  it('returns { error = ... } for garbage instead of throwing', async () => {
    const res = (await evalLua(`
      local res = json.parse_result('{not json')
      if res.error then return { hadError = true, message = res.error } end
      return { hadError = false }
    `)) as Record<string, unknown>;
    expect(res['hadError']).toBe(true);
    expect(typeof res['message']).toBe('string');
  });

  it('json.decode keeps throwing on garbage', async () => {
    await expect(evalLua(`return json.decode('{not json')`)).rejects.toThrow();
  });
});
