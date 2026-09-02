import { describe, it, expect } from 'vitest';
import type { PipelineMessage } from '@tamari/types';
import { stripReasoning } from './stripReasoning.js';
import type { TransformerContext } from '../types.js';

const ctx: TransformerContext = { userName: 'User' };

describe('strip-reasoning builtin', () => {
  it('strips reasoning/tool parts from old assistant messages, keeping only their final text', () => {
    const messages: PipelineMessage[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Thinking about greeting' },
          { type: 'text', text: 'Hi there' },
        ],
      },
      { role: 'user', content: 'How are you?' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Checking mood' },
          { type: 'text', text: 'Doing great' },
        ],
      },
      { role: 'assistant', content: '' }, // empty stream target (latest)
    ];

    const out = stripReasoning.apply(messages, {}, ctx);
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBe(3);
    expect(assistants[0]!.content).toBe('Hi there');
    expect(assistants[1]!.content).toBe('Doing great');
    expect(assistants[2]!.content).toBe('');
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
    expect(out[0]!.content).toBe('old text');
    const latest = out[1]!.content as Array<{ type: string }>;
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
      { role: 'assistant', content: 'You are welcome' },
    ];
    const out = stripReasoning.apply(messages, {}, ctx);
    expect(out[0]!.content).toBe('Let me check');
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
      { role: 'assistant', content: 'latest' },
    ];
    const out = stripReasoning.apply(messages, {}, ctx);
    expect(out[0]!.content).toBe('');
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
      { role: 'assistant', content: 'latest' },
    ];
    const out = stripReasoning.apply(messages, {}, ctx);
    expect(out[0]!.content).toBe('second');
  });

  it('leaves string-content and non-assistant messages untouched', () => {
    const messages: PipelineMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'plain' },
    ];
    expect(stripReasoning.apply(messages, {}, ctx)).toEqual(messages);
  });
});
