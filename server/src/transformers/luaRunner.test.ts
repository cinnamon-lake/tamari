import { describe, it, expect } from 'vitest';
import type { PipelineMessage } from '@tamari/types';
import { runLuaTransformer } from './luaRunner.js';
import type { TransformerContext } from './types.js';

const ctx: TransformerContext = { userName: 'Alice', charName: 'Bob', model: 'm1', backendProvider: 'openai' };

const base: PipelineMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hello' },
];

describe('runLuaTransformer', () => {
  it('applies in-place mutation of the messages table', async () => {
    const { messages, note } = await runLuaTransformer(
      `table.remove(messages, 1)  -- Lua arrays are 1-based`,
      base,
      ctx,
    );
    expect(note).toBeUndefined();
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('mutates message content in place', async () => {
    const { messages, note } = await runLuaTransformer(
      `messages[2].content = messages[2].content .. ' world'`,
      base,
      ctx,
    );
    expect(note).toBeUndefined();
    expect(messages[1]!.content).toBe('hello world');
  });

  it('accepts a returned new array', async () => {
    const { messages, note } = await runLuaTransformer(
      `return { { role = 'user', content = 'replacement' } }`,
      base,
      ctx,
    );
    expect(note).toBeUndefined();
    expect(messages).toEqual([{ role: 'user', content: 'replacement' }]);
  });

  it('exposes ctx to the script', async () => {
    const { messages, note } = await runLuaTransformer(
      `messages[2].content = ctx.userName .. '/' .. ctx.charName .. '/' .. ctx.model .. '/' .. ctx.backendProvider`,
      base,
      ctx,
    );
    expect(note).toBeUndefined();
    expect(messages[1]!.content).toBe('Alice/Bob/m1/openai');
  });

  it('keeps pre-step messages when the script errors', async () => {
    const { messages, note } = await runLuaTransformer(`error('boom')`, base, ctx);
    expect(messages).toEqual(base);
    expect(note).toContain('boom');
  });

  it('keeps pre-step messages when the result is malformed', async () => {
    const { messages, note } = await runLuaTransformer(`return { { role = 'nope', content = 'x' } }`, base, ctx);
    expect(messages).toEqual(base);
    expect(note).toContain('malformed');
  });

  it('denies io/os/debug/package/require/load', async () => {
    const { note } = await runLuaTransformer(
      `assert(io == nil and os == nil and debug == nil and package == nil and require == nil and load == nil)`,
      base,
      ctx,
    );
    expect(note).toBeUndefined();
  });

  it('kills a runaway script at the deadline and keeps pre-step messages', async () => {
    const start = Date.now();
    const { messages, note } = await runLuaTransformer('while true do end', base, ctx, { timeoutMs: 250 });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(messages).toEqual(base);
    expect(note).toBeDefined();
  });

  it('rejects a memory bomb at the heap cap', async () => {
    const { messages, note } = await runLuaTransformer(
      `
      local chunks = {}
      local i = 0
      while true do
        i = i + 1
        chunks[i] = string.rep('x', 65536)
      end
      `,
      base,
      ctx,
      { maxMemoryBytes: 1024 * 1024 },
    );
    expect(messages).toEqual(base);
    expect(note).toBeDefined();
  });

  it('does not alias the input array on failure after partial mutation', async () => {
    const input: PipelineMessage[] = [{ role: 'user', content: 'original' }];
    const { messages, note } = await runLuaTransformer(
      `
      messages[1].content = 'mutated'
      error('late failure')
      `,
      input,
      ctx,
    );
    expect(note).toBeDefined();
    expect(messages[0]!.content).toBe('original');
    expect(input[0]!.content).toBe('original');
  });
});
