import { describe, it, expect } from 'vitest';
import type { PipelineMessage } from '@tamari/types';
import { squashSystem } from './squashSystem.js';
import type { TransformerContext } from '../types.js';

const ctx: TransformerContext = { userName: 'User' };

const sys = (text: string): PipelineMessage => ({ role: 'system', content: [{ type: 'text', text }] });

describe('squash-system builtin', () => {
  it('merges consecutive system messages with the prompt separator', () => {
    const out = squashSystem.apply([sys('A'), sys('B'), sys('C')], {}, ctx);
    expect(out).toEqual([{ role: 'system', content: [{ type: 'text', text: 'A\n\nB\n\nC' }] }]);
  });

  it('does not merge across non-system messages', () => {
    const userMsg: PipelineMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    const out = squashSystem.apply([sys('A'), userMsg, sys('B')], {}, ctx);
    expect(out).toEqual([sys('A'), userMsg, sys('B')]);
  });

  it('does not merge when either side has non-text parts', () => {
    const withParts: PipelineMessage = { role: 'system', content: [{ type: 'reasoning', text: 'A' }] };
    const out = squashSystem.apply([withParts, sys('B')], {}, ctx);
    expect(out.length).toBe(2);
  });

  it('does not mutate the input messages', () => {
    const input = [sys('A'), sys('B')];
    squashSystem.apply(input, {}, ctx);
    expect(input[0]!.content).toEqual([{ type: 'text', text: 'A' }]);
  });
});
