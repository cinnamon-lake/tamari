import { describe, it, expect } from 'vitest';
import { extractReasoning, reconstructWithReasoning } from './ReasoningEngine.js';

describe('extractReasoning', () => {
  it('extracts reasoning when model re-emits opening tag', () => {
    const text = '<think>Let me think about this</think>Hello!';
    const result = extractReasoning(text, '(.*?<\\/think>\\s*)?(.*)', '<think>', '</think>');
    expect(result.reasoning).toBe('Let me think about this');
    expect(result.content).toBe('Hello!');
  });

  it('extracts reasoning when opening tag was in responsePrefix', () => {
    // Model was primed with <think> in prompt, so output starts with reasoning content
    const text = 'Let me think about this</think>Hello!';
    const result = extractReasoning(text, '(.*?<\\/think>\\s*)?(.*)', '<think>', '</think>');
    expect(result.reasoning).toBe('Let me think about this');
    expect(result.content).toBe('Hello!');
  });

  it('handles leading and trailing whitespace', () => {
    const text = '  <think>  thinking  </think>  Content here  ';
    const result = extractReasoning(text, '(.*?<\\/think>\\s*)?(.*)', '<think>', '</think>');
    expect(result.reasoning).toBe('thinking');
    expect(result.content).toBe('Content here');
  });

  it('returns empty reasoning when no closing tag present', () => {
    const text = 'Just regular content';
    const result = extractReasoning(text, '(.*?<\\/think>\\s*)?(.*)', '<think>', '</think>');
    expect(result.reasoning).toBe('');
    expect(result.content).toBe('Just regular content');
  });

  it('parses deepseek format with newlines', () => {
    const text = '<think>\nDeep reasoning\n</think>\n\nFinal answer';
    const result = extractReasoning(text, '(.*?<\\/think>\\s*)?(.*)', '<think>\n', '\n</think>');
    expect(result.reasoning).toBe('Deep reasoning');
    expect(result.content).toBe('Final answer');
  });

  it('parses mistral format with brackets', () => {
    const text = '[THINK]thinking[/THINK]content';
    const result = extractReasoning(text, '(.*?\\[/THINK\\]\\s*)?(.*)', '[THINK]', '[/THINK]');
    expect(result.reasoning).toBe('thinking');
    expect(result.content).toBe('content');
  });

  it('parses when opening tag was consumed by responsePrefix (mistral)', () => {
    const text = 'thinking[/THINK]content';
    const result = extractReasoning(text, '(.*?\\[/THINK\\]\\s*)?(.*)', '[THINK]', '[/THINK]');
    expect(result.reasoning).toBe('thinking');
    expect(result.content).toBe('content');
  });
});

describe('reconstructWithReasoning', () => {
  it('wraps reasoning with delimiters', () => {
    const result = reconstructWithReasoning('Hello', 'I think', '<think>', '</think>', '\n');
    expect(result).toBe('<think>I think</think>\nHello');
  });

  it('returns content only when reasoning is empty', () => {
    const result = reconstructWithReasoning('Hello', '', '<think>', '</think>', '\n');
    expect(result).toBe('Hello');
  });

  it('uses deepseek separator', () => {
    const result = reconstructWithReasoning('Answer', 'Reasoning', '<think>\n', '\n</think>', '\n\n');
    expect(result).toBe('<think>\nReasoning\n</think>\n\nAnswer');
  });
});
