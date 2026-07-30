/**
 * Non-reentrant async mutex. `lock()` queues waiters FIFO; `unlock()` hands off
 * to the next waiter WITHOUT clearing `locked`, so a concurrent `tryLock()`
 * can't steal the lock in the gap before the waiter resumes. `lock()` races a
 * 30s timeout so a wedged holder can't hang queued waiters indefinitely (a
 * stop-gap until `lock()` accepts an AbortSignal wired from handleStop).
 *
 * Moved verbatim from GenerationService.ts as part of the generation-runner
 * migration (docs/design/generation-runner.md).
 */
export class AsyncMutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async lock(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Chat lock acquisition timeout')),
        30_000,
      );
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Ownership was transferred by the prior unlock(); `locked` is already true.
  }

  tryLock(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  /**
   * Release. Returns false if the mutex was not held (an unbalanced release —
   * the bug class that used to leak the per-chat lock). `unlock()` in a
   * `finally` must not throw, so callers warn on the false return rather than
   * this method throwing.
   */
  unlock(): boolean {
    if (!this.locked) return false;
    const next = this.waiters.shift();
    if (next) next(); // hand off; `locked` stays true (no race window)
    else this.locked = false;
    return true;
  }
}

/**
 * A held chat-mutex tenure. Created by GenerationRunner on acquisition and
 * passed into nested runs (sub-agents inside tool calls, group-chat member
 * sequences, auto-continue). Presence of a lock means "nested": skip
 * acquisition and lifecycle callbacks. The chatId is asserted on nested runs —
 * cross-chat lock passing is forbidden.
 */
export interface ChatLock {
  readonly chatId: string;
}
