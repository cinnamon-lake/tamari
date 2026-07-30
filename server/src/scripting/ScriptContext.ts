/**
 * Execution context for a Lua script.
 *
 * Acquires the chat lock (fail-fast via tryLock) for the script's duration so
 * concurrent generations/scripts don't interleave. Service calls made from
 * within the script (st.send, etc.) receive a ChatLock for this tenure (via
 * `heldLockFor`), which tells GenerationService/the runner the lock is
 * already held and to skip re-acquiring — so the script and its nested
 * service calls share one lock tenure without deadlocking.
 */

import { randomUUID } from 'node:crypto';

export interface Lockable {
  tryLockChat(chatId: string): boolean;
  unlockChat(chatId: string): void;
}

export class ScriptContext {
  readonly id: string;
  readonly chatId: string;
  private lockable: Lockable;
  private locked = false;
  private abortController: AbortController;

  constructor(chatId: string, lockable: Lockable) {
    this.id = randomUUID();
    this.chatId = chatId;
    this.lockable = lockable;
    this.abortController = new AbortController();
  }

  acquireLock(): boolean {
    if (this.locked) return true;
    const acquired = this.lockable.tryLockChat(this.chatId);
    if (acquired) this.locked = true;
    return acquired;
  }

  releaseLock(): void {
    if (!this.locked) return;
    this.lockable.unlockChat(this.chatId);
    this.locked = false;
  }

  abort(): void {
    this.abortController.abort();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }
}
