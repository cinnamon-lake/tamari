import { describe, it, expect } from 'vitest';
import { str } from './coerce.js';

describe('coerce.str', () => {
  it('passes strings through unchanged', () => {
    expect(str('hello')).toBe('hello');
    expect(str('')).toBe('');
  });

  it('stringifies numbers', () => {
    expect(str(42)).toBe('42');
    expect(str(0)).toBe('0');
    expect(str(-1.5)).toBe('-1.5');
    expect(str(NaN)).toBe('NaN');
  });

  it('stringifies bigints', () => {
    expect(str(123n)).toBe('123');
  });

  it('stringifies booleans', () => {
    expect(str(true)).toBe('true');
    expect(str(false)).toBe('false');
  });

  it('returns the default fallback for non-primitives', () => {
    expect(str(undefined)).toBe('');
    expect(str(null)).toBe('');
    expect(str({})).toBe('');
    expect(str({ toString: () => 'custom' })).toBe('');
    expect(str(['a', 'b'])).toBe('');
    expect(str(() => 'fn')).toBe('');
    expect(str(Symbol('s'))).toBe('');
  });

  it('returns a custom fallback for non-primitives', () => {
    expect(str(undefined, 'fallback')).toBe('fallback');
    expect(str(null, 'n/a')).toBe('n/a');
    expect(str({}, '0')).toBe('0');
  });

  it('ignores the fallback for safe primitives', () => {
    expect(str('value', 'fallback')).toBe('value');
    expect(str(0, 'fallback')).toBe('0');
    expect(str(false, 'fallback')).toBe('false');
  });
});
