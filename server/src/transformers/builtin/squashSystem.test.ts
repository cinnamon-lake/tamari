import { describe, it, expect } from 'vitest';
import type { PipelineMessage } from '@tamari/types';
import { squashSystem } from './squashSystem.js';
import type { TransformerContext } from '../types.js';

const ctx: TransformerContext = { userName: 'User' };

const sys = (content: string): PipelineMessage => ({ role: 'system', content });

describe('squash-system builtin', () => {
  it('merges consecutive system messages with the prompt separator', () => {
    const out = squashSystem.apply([sys('A'), sys('B'), sys('C')], {}, ctx);
    expect(out).toEqual([{ role: 'system', content: 'A\n\nB\n\nC' }]);
  });

  it('does not merge across non-system messages', () => {
    const out = squashSystem.apply([sys('A'), { role: 'user', content: 'hi' }, sys('B')], {}, ctx);
    expect(out).toEqual([sys('A'), { role: 'user', content: 'hi' }, sys('B')]);
  });

  it('does not merge when either side has parts content', () => {
    const withParts: PipelineMessage = { role: 'system', content: [{ type: 'text', text: 'A' }] };
    const out = squashSystem.apply([withParts, sys('B')], {}, ctx);
    expect(out.length).toBe(2);
  });

  it('does not mutate the input messages', () => {
    const input = [sys('A'), sys('B')];
    squashSystem.apply(input, {}, ctx);
    expect(input[0]!.content).toBe('A');
  });
});
