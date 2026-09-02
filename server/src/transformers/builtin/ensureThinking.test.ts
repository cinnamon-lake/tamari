import { describe, it, expect } from 'vitest';
import type { PipelineMessage } from '@tamari/types';
import { ensureThinking } from './ensureThinking.js';
import type { TransformerContext } from '../types.js';

const ctx: TransformerContext = { userName: 'User' };

describe('ensure-thinking builtin', () => {
  it('prepends a placeholder reasoning part to string-content assistant messages', () => {
    const out = ensureThinking.apply([{ role: 'assistant', content: 'Hello' }], { placeholder: '…' }, ctx);
    expect(out[0]!.content).toEqual([
      { type: 'reasoning', text: '…' },
      { type: 'text', text: 'Hello' },
    ]);
  });

  it('leaves assistant messages that already have a reasoning part alone', () => {
    const msg: PipelineMessage = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'real thinking', signature: 'sig' },
        { type: 'text', text: 'answer' },
      ],
    };
    expect(ensureThinking.apply([msg], { placeholder: '…' }, ctx)).toEqual([msg]);
  });

  it('skips assistant messages with no text (the empty stream target)', () => {
    const msg: PipelineMessage = { role: 'assistant', content: '' };
    expect(ensureThinking.apply([msg], { placeholder: '…' }, ctx)).toEqual([msg]);
  });

  it('does not touch user or system messages', () => {
    const messages: PipelineMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    expect(ensureThinking.apply(messages, {}, ctx)).toEqual(messages);
  });

  it('defaults the placeholder to an empty string', () => {
    const out = ensureThinking.apply([{ role: 'assistant', content: 'Hi' }], undefined, ctx);
    const parts = out[0]!.content as Array<{ type: string; text: string }>;
    expect(parts[0]).toEqual({ type: 'reasoning', text: '' });
  });
});
