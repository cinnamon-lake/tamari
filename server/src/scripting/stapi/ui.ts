/**
 * st-api domain: UI & timing — toasts to the originating client and
 * abort-aware waits (sleep/delay, both clamped to 30s).
 */

import type { StApiContext } from './context.js';
import type { StApi } from './types.js';

export type UiApi = Pick<StApi, 'toast' | 'sleep' | 'delay'>;

export function createUi(c: StApiContext): UiApi {
  const { bus, clientId } = c.deps;
  const { ctx, checkAbort } = c;

  return {
    toast: (message: string, level?: string) => {
      // Lua input is arbitrary — clamp to the wire enum before broadcasting.
      const l = String(level);
      const clamped = l === 'success' || l === 'error' || l === 'warning' ? l : 'info';
      bus.sendTo(clientId, {
        type: 'script.toast',
        message: String(message),
        level: clamped,
      });
    },

    sleep: async (seconds: number) => {
      checkAbort();
      const s = Number(seconds);
      if (!Number.isFinite(s) || s < 0) throw new Error('sleep: expected non-negative number');
      const maxSleep = 30;
      const ms = Math.min(s, maxSleep) * 1000;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (ctx.signal.aborted) {
          clearTimeout(timer);
          reject(new Error('Script aborted'));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          reject(new Error('Script aborted'));
        };
        ctx.signal.addEventListener('abort', onAbort);
      });
    },

    delay: async (ms: number) => {
      checkAbort();
      const n = Number(ms);
      if (!Number.isFinite(n) || n < 0) throw new Error('delay: expected non-negative number');
      // Same clamp as sleep: an unbounded await here would hold the script
      // open — and the chat lock with it — indefinitely.
      const maxDelayMs = 30_000;
      const clamped = Math.min(Math.floor(n), maxDelayMs);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, clamped);
        if (ctx.signal.aborted) {
          clearTimeout(timer);
          reject(new Error('Script aborted'));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          reject(new Error('Script aborted'));
        };
        ctx.signal.addEventListener('abort', onAbort);
      });
    },
  };
}
