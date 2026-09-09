import { describe, it, expect } from 'vitest';
import type { PipelineMessage } from '@tamari/types';
import { whitespace } from './whitespace.js';
import type { TransformerContext } from '../types.js';

const ctx: TransformerContext = { userName: 'User' };

const user = (text: string): PipelineMessage => ({ role: 'user', content: [{ type: 'text', text }] });

describe('whitespace builtin', () => {
  it("mode 'none' leaves messages untouched", () => {
    const input = [user('  hello  world  ')];
    expect(whitespace.apply(input, { mode: 'none' }, ctx)).toEqual(input);
  });

  it("mode 'trim' strips leading/trailing whitespace only", () => {
    const out = whitespace.apply([user('  hello  world\n\n')], { mode: 'trim' }, ctx);
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'hello  world' }]);
  });

  it("mode 'full' collapses space runs to ' ' and newline runs to '\\n\\n'", () => {
    const out = whitespace.apply([user('Hello  world.\nNext   \n \n line')], { mode: 'full' }, ctx);
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'Hello world.\n\nNext\n\nline' }]);
  });

  it('applies to text parts of parts-content messages, leaving other parts alone', () => {
    const msg: PipelineMessage = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '  keep reasoning verbatim  ' },
        { type: 'text', text: '  answer  ' },
      ],
    };
    const out = whitespace.apply([msg], { mode: 'trim' }, ctx);
    const parts = out[0]!.content as Array<{ type: string; text: string }>;
    expect(parts[0]).toEqual({ type: 'reasoning', text: '  keep reasoning verbatim  ' });
    expect(parts[1]).toEqual({ type: 'text', text: 'answer' });
  });

  it('defaults to mode none when params are absent', () => {
    const input = [user('  hi  ')];
    expect(whitespace.apply(input, undefined, ctx)).toEqual(input);
  });

  it('rejects an unknown mode via the param schema', () => {
    expect(() => whitespace.apply([user('hi')], { mode: 'ludicrous' }, ctx)).toThrow();
  });
});
