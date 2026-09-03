import { describe, expect, it } from 'vitest';
import { newId } from './id.js';
import { words } from './wordlist.js';

describe('wordlist', () => {
  it('contains only unique lowercase alpha words', () => {
    expect(new Set(words).size).toBe(words.length);
    for (const w of words) {
      expect(w).toMatch(/^[a-z]+$/);
    }
  });
});

describe('newId', () => {
  it('returns four lowercase words joined by dashes', () => {
    for (let i = 0; i < 100; i++) {
      expect(newId()).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/);
    }
  });

  it('produces distinct IDs', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId()));
    expect(ids.size).toBe(10_000);
  });
});
