/**
 * AsyncMutex unit tests — FIFO handoff, the 30s acquisition timeout, and the
 * regression guard for the timed-out-waiter leak: a waiter that times out must
 * be REMOVED from the queue, or the next unlock() hands the tenure to a dead
 * waiter and the mutex is wedged forever.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AsyncMutex } from './AsyncMutex.js';

describe('AsyncMutex', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands off to queued waiters in FIFO order', async () => {
    const m = new AsyncMutex();
    await m.lock();
    const order: string[] = [];
    const w1 = m.lock().then(() => order.push('first'));
    const w2 = m.lock().then(() => order.push('second'));
    m.unlock();
    m.unlock();
    await Promise.all([w1, w2]);
    expect(order).toEqual(['first', 'second']);
  });

  it('keeps the lock held across handoff so tryLock cannot steal it', async () => {
    const m = new AsyncMutex();
    await m.lock();
    const waiter = m.lock();
    m.unlock(); // handoff: locked stays true
    expect(m.tryLock()).toBe(false);
    await waiter;
    expect(m.unlock()).toBe(true);
  });

  it('times out a queued acquisition after 30s', async () => {
    vi.useFakeTimers();
    const m = new AsyncMutex();
    await m.lock();
    const attempt = m.lock();
    const rejection = expect(attempt).rejects.toThrow('Chat lock acquisition timeout');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
  });

  it('a timed-out waiter does not wedge the mutex when the holder releases', async () => {
    vi.useFakeTimers();
    const m = new AsyncMutex();
    await m.lock();

    // Waiter 1 times out while the holder never releases.
    const timedOut = m.lock();
    const rejection = expect(timedOut).rejects.toThrow('Chat lock acquisition timeout');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    // Waiter 2 queues after the timeout; the holder then releases — the
    // tenure must reach waiter 2, not the dead waiter 1.
    const survivor = m.lock();
    m.unlock();
    await survivor;
    expect(m.tryLock()).toBe(false); // waiter 2 holds it
    expect(m.unlock()).toBe(true);
    expect(m.idle).toBe(true);
  });

  it('tryLock fails while held and succeeds once idle', async () => {
    const m = new AsyncMutex();
    expect(m.tryLock()).toBe(true);
    expect(m.tryLock()).toBe(false);
    expect(m.idle).toBe(false);
    m.unlock();
    expect(m.idle).toBe(true);
    expect(m.tryLock()).toBe(true);
  });

  it('unlock on an unheld mutex reports the unbalanced release', () => {
    const m = new AsyncMutex();
    expect(m.unlock()).toBe(false);
  });
});
