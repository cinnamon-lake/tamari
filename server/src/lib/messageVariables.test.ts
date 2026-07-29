import { describe, it, expect } from 'vitest';
import { extractMessageVariables } from './messageVariables.js';

describe('extractMessageVariables', () => {
  it('returns empty object when no setvar macros exist', () => {
    expect(extractMessageVariables('hello world')).toEqual({});
  });

  it('extracts a single setvar assignment', () => {
    const result = extractMessageVariables('{{setvar::x::hello}}');
    expect(result).toEqual({ x: 'hello' });
  });

  it('extracts multiple setvar assignments', () => {
    const result = extractMessageVariables('{{setvar::a::1}}{{setvar::b::2}}');
    expect(result).toEqual({ a: '1', b: '2' });
  });

  it('resolves nested macros in setvar values', () => {
    const result = extractMessageVariables('{{setvar::greeting::hello {{user}}}}', 'Alice', 'Bob');
    expect(result).toEqual({ greeting: 'hello Alice' });
  });

  it('setvar returns empty string and does not pollute output', () => {
    const result = extractMessageVariables('before{{setvar::x::val}}after');
    expect(result).toEqual({ x: 'val' });
  });
});
