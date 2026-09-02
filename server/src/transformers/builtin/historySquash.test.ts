import { describe, it, expect } from 'vitest';
import type { PipelineMessage } from '@tamari/types';
import { historySquash } from './historySquash.js';
import type { TransformerContext } from '../types.js';

const ctx: TransformerContext = { userName: 'Alice', charName: 'Bob' };

describe('history-squash builtin', () => {
  it('collapses user/assistant turns into one user message with name prefixes', () => {
    const messages: PipelineMessage[] = [
      { role: 'system', content: 'preamble' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
      { role: 'system', content: 'jailbreak' },
    ];
    const out = historySquash.apply(messages, {}, ctx);
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'system']);
    expect(out[1]!.content).toBe('Alice: Hello\n\nBob: Hi there\n\nAlice: How are you?');
  });

  it("role 'assistant' targets a single assistant message (noass)", () => {
    const messages: PipelineMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const out = historySquash.apply(messages, { role: 'assistant' }, ctx);
    expect(out).toEqual([{ role: 'assistant', content: 'Alice: Hello\n\nBob: Hi' }]);
  });

  it('honors custom prefixes, suffixes, and separator', () => {
    const messages: PipelineMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const out = historySquash.apply(
      messages,
      { userPrefix: '<u>', userSuffix: '</u>', charPrefix: '<c>', charSuffix: '</c>', separator: '|' },
      ctx,
    );
    expect(out[0]!.content).toBe('<u>Hello</u>|<c>Hi</c>');
  });

  it('places the collapsed message at the first collapsed position', () => {
    const messages: PipelineMessage[] = [
      { role: 'system', content: 'pre' },
      { role: 'system', content: 'pre2' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const out = historySquash.apply(messages, {}, ctx);
    expect(out.map((m) => m.role)).toEqual(['system', 'system', 'user']);
  });

  it('uses parts text (reasoning excluded) and leaves textless messages in place', () => {
    const messages: PipelineMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'Answer' },
        ],
      },
      { role: 'assistant', content: '' }, // stream target stays put
    ];
    const out = historySquash.apply(messages, {}, ctx);
    expect(out).toEqual([
      { role: 'user', content: 'Bob: Answer' },
      { role: 'assistant', content: '' },
    ]);
  });

  it('falls back to a default char name when ctx has none', () => {
    const messages: PipelineMessage[] = [{ role: 'assistant', content: 'Hi' }];
    const out = historySquash.apply(messages, {}, { userName: 'Alice' });
    expect(out[0]!.content).toBe('Character: Hi');
  });

  it('is a no-op without collapsible messages', () => {
    const messages: PipelineMessage[] = [{ role: 'system', content: 'only' }];
    expect(historySquash.apply(messages, {}, ctx)).toEqual(messages);
  });
});
