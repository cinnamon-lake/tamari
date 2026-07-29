import { describe, it, expect } from 'vitest';
import { parseRegexString, compileRule, applyDisplayRules } from './regexDisplay.js';
import type { RegexRule } from '@tamari/types';

describe('parseRegexString', () => {
  it('rejects bare patterns', () => {
    expect(parseRegexString('hello')).toBeNull();
  });

  it('parses /pattern/flags format', () => {
    expect(parseRegexString('/hello/gi')).toEqual({ pattern: 'hello', flags: 'gi' });
  });

  it('defaults flags to g when empty', () => {
    expect(parseRegexString('/hello/')).toEqual({ pattern: 'hello', flags: 'g' });
  });

  it('trims whitespace', () => {
    expect(parseRegexString('  /hello/gi  ')).toEqual({ pattern: 'hello', flags: 'gi' });
  });

  it('handles bare slash', () => {
    expect(parseRegexString('/')).toBeNull();
  });

  it('handles pattern with slashes inside', () => {
    expect(parseRegexString('/a/b/c/g')).toEqual({ pattern: 'a/b/c', flags: 'g' });
  });
});

describe('compileRule', () => {
  it('compiles valid regex', () => {
    const rule: RegexRule = {
      id: 'r1',
      name: '',
      findRegex: '/hello/g',
      replaceString: 'hi',
      display: true,
      disabled: false,
      userInput: false,
      aiOutput: false,
      prompt: false,
    };
    expect(compileRule(rule)).toBeInstanceOf(RegExp);
  });

  it('returns null for invalid regex', () => {
    const rule: RegexRule = {
      id: 'r1',
      name: '',
      findRegex: '/[invalid/g',
      replaceString: '',
      display: true,
      disabled: false,
      userInput: false,
      aiOutput: false,
      prompt: false,
    };
    expect(compileRule(rule)).toBeNull();
  });

  it('returns null for bare patterns', () => {
    const rule: RegexRule = {
      id: 'r1',
      name: '',
      findRegex: 'hello',
      replaceString: '',
      display: true,
      disabled: false,
      userInput: false,
      aiOutput: false,
      prompt: false,
    };
    expect(compileRule(rule)).toBeNull();
  });
});

describe('applyDisplayRules', () => {
  it('applies matching rule', () => {
    const rules: RegexRule[] = [
      { id: 'r1', name: '', findRegex: '/hello/g', replaceString: 'hi', display: true, disabled: false, userInput: false, aiOutput: false, prompt: false },
    ];
    expect(applyDisplayRules('hello world', rules)).toBe('hi world');
  });

  it('applies multiple rules in order', () => {
    const rules: RegexRule[] = [
      { id: 'r1', name: '', findRegex: '/hello/g', replaceString: 'hi', display: true, disabled: false, userInput: false, aiOutput: false, prompt: false },
      { id: 'r2', name: '', findRegex: '/world/g', replaceString: 'earth', display: true, disabled: false, userInput: false, aiOutput: false, prompt: false },
    ];
    expect(applyDisplayRules('hello world', rules)).toBe('hi earth');
  });

  it('skips disabled rules', () => {
    const rules: RegexRule[] = [
      { id: 'r1', name: '', findRegex: '/hello/g', replaceString: 'hi', display: true, disabled: true, userInput: false, aiOutput: false, prompt: false },
    ];
    expect(applyDisplayRules('hello world', rules)).toBe('hello world');
  });

  it('skips rules with display=false', () => {
    const rules: RegexRule[] = [
      { id: 'r1', name: '', findRegex: '/hello/g', replaceString: 'hi', display: false, disabled: false, userInput: false, aiOutput: false, prompt: false },
    ];
    expect(applyDisplayRules('hello world', rules)).toBe('hello world');
  });

  it('skips rules that fail to compile', () => {
    const rules: RegexRule[] = [
      { id: 'r1', name: '', findRegex: '/[invalid/g', replaceString: '', display: true, disabled: false, userInput: false, aiOutput: false, prompt: false },
    ];
    expect(applyDisplayRules('hello world', rules)).toBe('hello world');
  });

  it('skips bare patterns', () => {
    const rules: RegexRule[] = [
      { id: 'r1', name: '', findRegex: 'hello', replaceString: 'hi', display: true, disabled: false, userInput: false, aiOutput: false, prompt: false },
    ];
    expect(applyDisplayRules('hello world', rules)).toBe('hello world');
  });

  it('handles global replacement', () => {
    const rules: RegexRule[] = [
      { id: 'r1', name: '', findRegex: '/a/g', replaceString: 'b', display: true, disabled: false, userInput: false, aiOutput: false, prompt: false },
    ];
    expect(applyDisplayRules('aaa', rules)).toBe('bbb');
  });

  it('returns original text when no rules', () => {
    expect(applyDisplayRules('hello', [])).toBe('hello');
  });
});
