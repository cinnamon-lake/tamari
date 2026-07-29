import { describe, it, expect } from 'vitest';
import { SlidingWindowRateLimiter } from './RateLimiter.js';

describe('SlidingWindowRateLimiter', () => {
  it('allows up to the limit within the window', () => {
    const limiter = new SlidingWindowRateLimiter(3, 10_000);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(true);
  });

  it('blocks after exceeding the limit', () => {
    const limiter = new SlidingWindowRateLimiter(2, 10_000);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    expect(limiter.check('a')).toBe(false);
  });

  it('tracks keys independently', () => {
    const limiter = new SlidingWindowRateLimiter(1, 10_000);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('b')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    expect(limiter.check('b')).toBe(false);
  });

  it('resets after the window expires', async () => {
    const limiter = new SlidingWindowRateLimiter(1, 50);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(limiter.check('a')).toBe(true);
  });
});
