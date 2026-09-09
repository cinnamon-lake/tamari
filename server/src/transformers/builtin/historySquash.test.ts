import { describe, it, expect } from 'vitest';
import type { PipelineMessage } from '@tamari/types';
import { historySquash } from './historySquash.js';
import type { TransformerContext } from '../types.js';

const ctx: TransformerContext = { userName: 'Alice', charName: 'Bob' };

describe('history-squash builtin', () => {
  it('collapses user/assistant turns into one user message with name prefixes', () => {
    const messages: PipelineMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'preamble' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
      { role: 'user', content: [{ type: 'text', text: 'How are you?' }] },
      { role: 'system', content: [{ type: 'text', text: 'jailbreak' }] },
    ];
    const out = historySquash.apply(messages, {}, ctx);
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'system']);
    expect(out[1]!.content).toEqual([
      { type: 'text', text: 'Alice: Hello' },
      { type: 'text', text: 'Bob: Hi there' },
      { type: 'text', text: 'Alice: How are you?' },
    ]);
  });

  it("role 'assistant' targets a single assistant message (noass)", () => {
    const messages: PipelineMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ];
    const out = historySquash.apply(messages, { role: 'assistant' }, ctx);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Alice: Hello' },
          { type: 'text', text: 'Bob: Hi' },
        ],
      },
    ]);
  });

  it('honors custom prefixes and suffixes', () => {
    const messages: PipelineMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ];
    const out = historySquash.apply(
      messages,
      { userPrefix: '<u>', userSuffix: '</u>', charPrefix: '<c>', charSuffix: '</c>' },
      ctx,
    );
    expect(out[0]!.content).toEqual([
      { type: 'text', text: '<u>Hello</u>' },
      { type: 'text', text: '<c>Hi</c>' },
    ]);
  });

  it('places the collapsed message at the first collapsed position', () => {
    const messages: PipelineMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'pre' }] },
      { role: 'system', content: [{ type: 'text', text: 'pre2' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
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
      { role: 'assistant', content: [{ type: 'text', text: '' }] }, // textless message stays put
    ];
    const out = historySquash.apply(messages, {}, ctx);
    expect(out).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Bob: Answer' }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ]);
  });

  it('falls back to a default char name when ctx has none', () => {
    const messages: PipelineMessage[] = [{ role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }];
    const out = historySquash.apply(messages, {}, { userName: 'Alice' });
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'Character: Hi' }]);
  });

  it('is a no-op without collapsible messages', () => {
    const messages: PipelineMessage[] = [{ role: 'system', content: [{ type: 'text', text: 'only' }] }];
    expect(historySquash.apply(messages, {}, ctx)).toEqual(messages);
  });
});
