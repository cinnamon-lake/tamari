import { words } from './wordlist.js';

/**
 * Uniform random index in [0, exclusiveMax) using the Web Crypto API
 * (available as `globalThis.crypto` in Node >= 19 and all browsers).
 * Rejection sampling avoids modulo bias.
 */
function randomIndex(exclusiveMax: number): number {
  const range = 0x1_0000_0000; // 2^32
  const limit = range - (range % exclusiveMax);
  const buf = new Uint32Array(1);
  let x = limit;
  while (x >= limit) {
    globalThis.crypto.getRandomValues(buf);
    x = buf[0] ?? limit;
  }
  return x % exclusiveMax;
}

/**
 * Returns a human-readable ID like "quantum-pixel-buffer-hack".
 * Four words from an 8,803-word list = ~2^52 combinations.
 */
export function newId(): string {
  const picked: string[] = [];
  for (let i = 0; i < 4; i++) {
    const word = words[randomIndex(words.length)];
    if (word === undefined) throw new Error('wordid: wordlist index out of range');
    picked.push(word);
  }
  return picked.join('-');
}
