import { describe, it, expect } from 'vitest';
import type { PipelineMessage } from '@tamari/types';
import { stripReasoning } from './stripReasoning.js';
import type { TransformerContext } from '../types.js';

const ctx: TransformerContext = { userName: 'User' };

describe('strip-reasoning builtin', () => {
  it('strips reasoning/tool parts from old assistant messages, keeping only their final text', () => {
    const messages: PipelineMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Thinking about greeting' },
          { type: 'text', text: 'Hi there' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'How are you?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Checking mood' },
          { type: 'text', text: 'Doing great' },
        ],
      },
      { role: 'assistant', content: [] }, // empty stream target (latest)
    ];

    const out = stripReasoning.apply(messages, {}, ctx);
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBe(3);
    expect(assistants[0]!.content).toEqual([{ type: 'text', text: 'Hi there' }]);
    expect(assistants[1]!.content).toEqual([{ type: 'text', text: 'Doing great' }]);
    expect(assistants[2]!.content).toEqual([]);
  });

  it('keeps reasoning on the latest assistant message', () => {
    const messages: PipelineMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'old' },
          { type: 'text', text: 'old text' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'new' },
          { type: 'text', text: 'new text' },
        ],
      },
    ];
    const out = stripReasoning.apply(messages, {}, ctx);
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'old text' }]);
    const latest = out[1]!.content;
    expect(latest.some((p) => p.type === 'reasoning')).toBe(true);
  });

  it('strips tool_use and tool_result from old assistant messages', () => {
    const messages: PipelineMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Need data' },
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'You are welcome' }] },
    ];
    const out = stripReasoning.apply(messages, {}, ctx);
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'Let me check' }]);
  });

  it('falls back to joined text when nothing text-like survives the strip', () => {
    const messages: PipelineMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'only thinking' },
          { type: 'tool_use', id: 'c', name: 't', input: {} },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'latest' }] },
    ];
    const out = stripReasoning.apply(messages, {}, ctx);
    expect(out[0]!.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('keeps the final text part when non-text parts trail it', () => {
    const messages: PipelineMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
          { type: 'reasoning', text: 'afterthought' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'latest' }] },
    ];
    const out = stripReasoning.apply(messages, {}, ctx);
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('leaves plain-text and non-assistant messages untouched', () => {
    const messages: PipelineMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'plain' }] },
    ];
    expect(stripReasoning.apply(messages, {}, ctx)).toEqual(messages);
  });
});
