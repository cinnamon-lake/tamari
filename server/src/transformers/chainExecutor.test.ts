import { describe, it, expect } from 'vitest';
import type { PipelineMessage, TransformerStep } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import { executeChain } from './chainExecutor.js';
import type { TransformerContext } from './types.js';

const ctx: TransformerContext = { userName: 'Alice', charName: 'Bob' };

const user = (text: string): PipelineMessage => ({ role: 'user', content: [{ type: 'text', text }] });

describe('executeChain', () => {
  it('runs steps in order, feeding each the previous output', async () => {
    const steps: TransformerStep[] = [
      { kind: 'builtin', id: 'whitespace', enabled: true, params: { mode: 'trim' } },
      { kind: 'builtin', id: 'history-squash', enabled: true },
    ];
    const { messages, trace } = await executeChain(
      [
        { role: 'system', content: [{ type: 'text', text: 'pre' }] },
        user('  hello  '),
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      ],
      steps,
      ctx,
    );
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]!.content).toEqual([
      { type: 'text', text: 'Alice: hello' },
      { type: 'text', text: 'Bob: hi' },
    ]);
    expect(trace).toEqual([]);
  });

  it('skips disabled steps without a trace note', async () => {
    const steps: TransformerStep[] = [{ kind: 'builtin', id: 'whitespace', enabled: false, params: { mode: 'full' } }];
    const { messages, trace } = await executeChain([user('a  b')], steps, ctx);
    expect(getMessageText(messages[0]!.content)).toBe('a  b');
    expect(trace).toEqual([]);
  });

  it('skips a builtin step with invalid params and records a trace note', async () => {
    const steps: TransformerStep[] = [
      { kind: 'builtin', id: 'whitespace', enabled: true, params: { mode: 'ludicrous' } },
      { kind: 'builtin', id: 'whitespace', enabled: true, params: { mode: 'trim' } },
    ];
    const { messages, trace } = await executeChain([user('  hi  ')], steps, ctx);
    expect(getMessageText(messages[0]!.content)).toBe('hi');
    expect(trace.length).toBe(1);
    expect(trace[0]).toContain('whitespace');
    expect(trace[0]).toContain('invalid params');
  });

  it('records a trace note for an unknown builtin id', async () => {
    const steps = [{ kind: 'builtin', id: 'nope', enabled: true }] as unknown as TransformerStep[];
    const { messages, trace } = await executeChain([user('hi')], steps, ctx);
    expect(getMessageText(messages[0]!.content)).toBe('hi');
    expect(trace[0]).toContain('unknown transformer id');
  });

  it('records a trace note when a lua step has no source', async () => {
    const steps: TransformerStep[] = [{ kind: 'lua', scriptId: 'missing', enabled: true }];
    const { messages, trace } = await executeChain([user('hi')], steps, ctx, new Map());
    expect(getMessageText(messages[0]!.content)).toBe('hi');
    expect(trace[0]).toContain('script not found');
  });

  it('runs a lua step against its source', async () => {
    const steps: TransformerStep[] = [{ kind: 'lua', scriptId: 's1', enabled: true }];
    const luaSources = new Map([
      [
        's1',
        'function handle(messages, ctx) messages[#messages + 1] = { role = "user", content = "from lua" } return messages end',
      ],
    ]);
    const { messages, trace } = await executeChain([user('hi')], steps, ctx, luaSources);
    expect(messages.map((m) => m.content)).toEqual([
      [{ type: 'text', text: 'hi' }],
      [{ type: 'text', text: 'from lua' }],
    ]);
    expect(trace).toEqual([]);
  });

  it('collects lua step print() output into debug, prefixed with the step id', async () => {
    const steps: TransformerStep[] = [{ kind: 'lua', scriptId: 's1', enabled: true }];
    const luaSources = new Map([
      ['s1', 'function handle(messages, ctx) print("squashed", #messages) return messages end'],
    ]);
    const { debug } = await executeChain([user('hi')], steps, ctx, luaSources);
    expect(debug).toEqual(['[s1] squashed\t1']);
  });

  it('keeps print() output when the lua step fails', async () => {
    const steps: TransformerStep[] = [{ kind: 'lua', scriptId: 's1', enabled: true }];
    const luaSources = new Map([['s1', 'function handle(messages, ctx) print("before") error("boom") end']]);
    const { trace, debug } = await executeChain([user('hi')], steps, ctx, luaSources);
    expect(trace[0]).toContain('script failed');
    expect(debug).toEqual(['[s1] before']);
  });
});
