import { describe, it, expect } from 'vitest';
import type { PipelineMessage } from '@tamari/types';
import { runLuaTransformer } from './luaRunner.js';
import type { TransformerContext } from './types.js';

const ctx: TransformerContext = { userName: 'Alice', charName: 'Bob', model: 'm1', backendProvider: 'openai' };

const base: PipelineMessage[] = [
  { role: 'system', content: [{ type: 'text', text: 'sys' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
];

describe('runLuaTransformer', () => {
  it('returns a rebuilt array from handle()', async () => {
    const { messages, note } = await runLuaTransformer(
      `function handle(messages, ctx)
        local out = {}
        for i = 2, #messages do out[#out + 1] = messages[i] end  -- Lua arrays are 1-based
        return out
      end`,
      base,
      ctx,
    );
    expect(note).toBeUndefined();
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  });

  it('may mutate the argument in place and return it', async () => {
    const { messages, note } = await runLuaTransformer(
      `function handle(messages, ctx)
        messages[2].content[1].text = messages[2].content[1].text .. ' world'
        return messages
      end`,
      base,
      ctx,
    );
    expect(note).toBeUndefined();
    expect(messages[1]!.content).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('accepts a freshly built array literal and normalizes bare-string content', async () => {
    const { messages, note } = await runLuaTransformer(
      `function handle(messages, ctx)
        return { { role = 'user', content = 'replacement' } }
      end`,
      base,
      ctx,
    );
    expect(note).toBeUndefined();
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'replacement' }] }]);
  });

  it('passes ctx to handle()', async () => {
    const { messages, note } = await runLuaTransformer(
      `function handle(messages, ctx)
        messages[2].content = ctx.userName .. '/' .. ctx.charName .. '/' .. ctx.model .. '/' .. ctx.backendProvider
        return messages
      end`,
      base,
      ctx,
    );
    expect(note).toBeUndefined();
    expect(messages[1]!.content).toEqual([{ type: 'text', text: 'Alice/Bob/m1/openai' }]);
  });

  it('keeps pre-step messages when handle() is missing', async () => {
    const { messages, note } = await runLuaTransformer(`local x = 1`, base, ctx);
    expect(messages).toEqual(base);
    expect(note).toContain('must define handle(messages, ctx)');
  });

  it('keeps pre-step messages when the script errors during load', async () => {
    const { messages, note } = await runLuaTransformer(`error('boom')`, base, ctx);
    expect(messages).toEqual(base);
    expect(note).toContain('boom');
  });

  it('keeps pre-step messages when handle() throws', async () => {
    const { messages, note } = await runLuaTransformer(`function handle(messages, ctx) error('boom') end`, base, ctx);
    expect(messages).toEqual(base);
    expect(note).toContain('boom');
  });

  it('keeps pre-step messages when the result is malformed', async () => {
    const { messages, note } = await runLuaTransformer(
      `function handle(messages, ctx) return { { role = 'nope', content = 'x' } } end`,
      base,
      ctx,
    );
    expect(messages).toEqual(base);
    expect(note).toContain('malformed');
  });

  it('keeps pre-step messages when handle() returns nothing', async () => {
    const { messages, note } = await runLuaTransformer(`function handle(messages, ctx) end`, base, ctx);
    expect(messages).toEqual(base);
    expect(note).toContain('malformed');
  });

  it('denies io/os/debug/package/require/load', async () => {
    const { note } = await runLuaTransformer(
      `function handle(messages, ctx)
        assert(io == nil and os == nil and debug == nil and package == nil and require == nil and load == nil)
        return messages
      end`,
      base,
      ctx,
    );
    expect(note).toBeUndefined();
  });

  it('kills a runaway script at the deadline and keeps pre-step messages', async () => {
    const start = Date.now();
    const { messages, note } = await runLuaTransformer(
      'function handle(messages, ctx) while true do end end',
      base,
      ctx,
      { timeoutMs: 250 },
    );
    expect(Date.now() - start).toBeLessThan(5000);
    expect(messages).toEqual(base);
    expect(note).toBeDefined();
  });

  it('rejects a memory bomb at the heap cap', async () => {
    const { messages, note } = await runLuaTransformer(
      `
      function handle(messages, ctx)
        local chunks = {}
        local i = 0
        while true do
          i = i + 1
          chunks[i] = string.rep('x', 65536)
        end
        return messages
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
    const input: PipelineMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'original' }] }];
    const { messages, note } = await runLuaTransformer(
      `
      function handle(messages, ctx)
        messages[1].content = 'mutated'
        error('late failure')
      end
      `,
      input,
      ctx,
    );
    expect(note).toBeDefined();
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'original' }]);
    expect(input[0]!.content).toEqual([{ type: 'text', text: 'original' }]);
  });
});
