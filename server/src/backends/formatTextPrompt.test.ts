import { describe, it, expect } from 'vitest';
import { formatTextPrompt } from './formatTextPrompt.js';
import { getInstructTemplate } from './InstructTemplate.js';
import { extractReasoning } from '../services/ReasoningEngine.js';
import type { PipelineMessage } from './BackendAdapter.js';

const msg = (role: PipelineMessage['role'], content: PipelineMessage['content']): PipelineMessage => ({
  role,
  content,
});

const noReasoning = { includeReasoning: false };
const withReasoning = { includeReasoning: true };

describe('formatTextPrompt', () => {
  it('flattens messages with the none template', () => {
    const text = formatTextPrompt(
      [msg('system', 'A friendly bot.'), msg('user', 'Hello'), msg('assistant', 'Hi there'), msg('user', 'Bye')],
      getInstructTemplate('none'),
      noReasoning,
    );

    expect(text).toContain('A friendly bot.');
    expect(text).toContain('Hello');
    expect(text).toContain('Hi there');
  });

  it('wraps content with the alpaca template', () => {
    const text = formatTextPrompt([msg('user', 'Hello')], getInstructTemplate('alpaca'), noReasoning);

    expect(text).toContain('### Instruction:');
    expect(text).toContain('### Response:');
  });

  it('wraps content with the chatml template', () => {
    const text = formatTextPrompt([msg('user', 'Hello')], getInstructTemplate('chatml'), noReasoning);

    expect(text).toContain('<|im_start|>');
    expect(text).toContain('<|im_end|>');
  });

  it('adds BOS with the llama3 template', () => {
    const text = formatTextPrompt([], getInstructTemplate('llama3'), noReasoning);

    expect(text.startsWith('<|begin_of_text|>')).toBe(true);
  });

  it('wraps content with the kimi-k3 XTML format', () => {
    const text = formatTextPrompt([msg('user', 'Hello')], getInstructTemplate('kimi-k3'), noReasoning);

    // Each message is an XTML block; the response prefix opens the <response>
    // channel (no <think> channel in non-thinking mode).
    expect(text).toContain('<|open|>message role="user"<|sep|>Hello<|close|>message<|sep|><|end_of_msg|>');
    expect(text).toContain('<|open|>message role="assistant"<|sep|><|open|>response<|sep|>');
    // No separator between messages: the assistant block directly follows the user's end_of_msg.
    expect(text).toContain('<|end_of_msg|><|open|>message role="assistant"<|sep|>');
  });

  it('opens the think channel for kimi-k3-thinking', () => {
    const text = formatTextPrompt([msg('user', 'Hello')], getInstructTemplate('kimi-k3-thinking'), noReasoning);

    expect(text.endsWith('<|open|>message role="assistant"<|sep|><|open|>think<|sep|>')).toBe(true);
  });

  it('emits an empty think channel for kimi-k3-thinking assistant turns', () => {
    const text = formatTextPrompt(
      [msg('user', 'Hello'), msg('assistant', 'Hi there'), msg('user', 'Bye')],
      getInstructTemplate('kimi-k3-thinking'),
      noReasoning,
    );

    // The structural <think> channel is present (empty) even with no stored reasoning.
    expect(text).toContain(
      '<|open|>message role="assistant"<|sep|><|open|>think<|sep|><|close|>think<|sep|><|open|>response<|sep|>Hi there<|close|>response<|sep|><|close|>message<|sep|><|end_of_msg|>',
    );
  });

  it('extracts kimi-k3-thinking reasoning from model output', () => {
    const template = getInstructTemplate('kimi-k3-thinking');
    const r = template.reasoning!;
    const parsed = extractReasoning(
      'Let me consider.<|close|>think<|sep|><|open|>response<|sep|>Final answer.',
      r.pattern,
      r.prefix,
      r.suffix,
    );
    expect(parsed.reasoning).toBe('Let me consider.');
    expect(parsed.content).toBe('Final answer.');
  });

  it('appends the response prefix when the last message is not an assistant prefill', () => {
    const text = formatTextPrompt([msg('user', 'Hello')], getInstructTemplate('alpaca'), noReasoning);

    expect(text).toContain('### Response:');
  });

  it('prefills assistant content raw when the last message is assistant (continue/regenerate)', () => {
    const text = formatTextPrompt(
      [msg('user', 'Hello'), msg('assistant', 'Hi there')],
      getInstructTemplate('alpaca'),
      noReasoning,
    );

    // The assistant message content is appended raw (unwrapped) at the end.
    expect(text.endsWith('Hi there')).toBe(true);
    // The earlier user message is still wrapped normally.
    expect(text).toContain('### Instruction:\nHello');
    // The prefill must NOT get the assistant wrapper.
    expect(text).not.toContain('### Response:\nHi there');
  });

  it('drops a trailing empty assistant placeholder, then prefills from the previous assistant message', () => {
    const text = formatTextPrompt(
      [msg('user', 'Hello'), msg('assistant', 'Partial answer'), msg('assistant', '')],
      getInstructTemplate('alpaca'),
      noReasoning,
    );

    expect(text.endsWith('Partial answer')).toBe(true);
  });

  it('ignores reasoning parts when includeReasoning is false', () => {
    const text = formatTextPrompt(
      [
        msg('user', 'Hello'),
        msg('assistant', [
          { type: 'reasoning', text: 'secret thoughts' },
          { type: 'text', text: 'Visible answer' },
        ]),
        msg('user', 'Bye'),
      ],
      getInstructTemplate('kimi-k3-thinking'),
      noReasoning,
    );

    expect(text).not.toContain('secret thoughts');
    expect(text).toContain('Visible answer');
  });

  it('inlines reasoning parts with template delimiters when includeReasoning is true', () => {
    const text = formatTextPrompt(
      [
        msg('user', 'Hello'),
        msg('assistant', [
          { type: 'reasoning', text: 'I pondered' },
          { type: 'text', text: 'Visible answer' },
        ]),
        msg('user', 'Bye'),
      ],
      getInstructTemplate('none'),
      withReasoning,
    );

    // The 'none' template has no reasoning block → reasoning stays out.
    expect(text).not.toContain('I pondered');

    const kimi = formatTextPrompt(
      [
        msg('user', 'Hello'),
        msg('assistant', [
          { type: 'reasoning', text: 'I pondered' },
          { type: 'text', text: 'Visible answer' },
        ]),
        msg('user', 'Bye'),
      ],
      getInstructTemplate('kimi-k3-thinking'),
      withReasoning,
    );

    expect(kimi).toContain('<|open|>think<|sep|>I pondered<|close|>think<|sep|><|open|>response<|sep|>Visible answer');
  });

  it('inlines reasoning into the prefill when includeReasoning is true', () => {
    const text = formatTextPrompt(
      [
        msg('user', 'Hello'),
        msg('assistant', [
          { type: 'reasoning', text: 'drafting' },
          { type: 'text', text: 'Partial' },
        ]),
      ],
      getInstructTemplate('kimi-k3-thinking'),
      withReasoning,
    );

    // Response prefix opens the think channel, then the raw prefill carries
    // the reconstructed reasoning + partial content.
    expect(text.endsWith('<|open|>think<|sep|>drafting<|close|>think<|sep|><|open|>response<|sep|>Partial')).toBe(true);
  });

  it('ignores non-text media parts', () => {
    const text = formatTextPrompt(
      [
        msg('user', [
          { type: 'text', text: 'Look at this' },
          { type: 'image', source: 'data:image/png;base64,AAA' },
        ]),
      ],
      getInstructTemplate('none'),
      noReasoning,
    );

    expect(text).toContain('Look at this');
    expect(text).not.toContain('data:image');
  });
});
