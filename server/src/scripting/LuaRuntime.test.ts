import { describe, expect, it } from 'vitest';
import { LuaRuntime } from './LuaRuntime.js';

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
