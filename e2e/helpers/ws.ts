/**
 * Short-lived WebSocket helpers against the app's /ws bus, evaluated inside
 * the page (which holds the auth token in localStorage). Shared plumbing for
 * the UI-bypass helpers in helpers/app.ts / helpers/backendConfig.ts:
 * connect → auth → request → await a response frame → close. Both helpers
 * reject on a server `error` frame and on websocket error.
 *
 * The page-side functions must stay self-contained: page.evaluate serializes
 * them, so they cannot close over module scope.
 */
import type { Page } from '@playwright/test';

type WsFrame = Record<string, any>;

export interface WsRpcOptions {
  /** Per-call timeout in ms (default 10000). */
  timeout?: number;
  /** Only resolve on a matching frame when this dot path JSON-equals `value`. */
  match?: { path: string; value: unknown };
  /** Dot path to pluck from the matching frame as the resolved value (default: the whole frame). */
  pick?: string;
}

/**
 * One-shot RPC: open a socket, authenticate, wait for the initial `snapshot`,
 * send `msg`, and resolve with the first frame of `awaitType` (optionally
 * filtered by `match` and reduced by `pick`). Rejects on a server `error`
 * frame, on websocket error, or after `timeout` ms.
 */
export async function wsRpc<T = unknown>(
  page: Page,
  msg: WsFrame,
  awaitType: string | string[],
  opts: WsRpcOptions = {},
): Promise<T> {
  return page.evaluate(
    ({ msg, awaitType, timeout, match, pick }) => {
      return new Promise<unknown>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
        const types = Array.isArray(awaitType) ? awaitType : [awaitType];
        const get = (obj: unknown, path: string): unknown =>
          path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error(`wsRpc timed out waiting for ${types.join('|')} (sent ${msg.type})`));
        }, timeout);
        const settle = (fn: () => void) => {
          clearTimeout(timer);
          ws.close();
          fn();
        };
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
        ws.onmessage = (event) => {
          try {
            const frame = JSON.parse(event.data as string);
            if (frame.type === 'snapshot') {
              ws.send(JSON.stringify(msg));
            } else if (frame.type === 'error') {
              settle(() => reject(new Error(frame.message ?? `${msg.type} failed`)));
            } else if (types.includes(frame.type)) {
              if (match && JSON.stringify(get(frame, match.path)) !== JSON.stringify(match.value)) return;
              settle(() => resolve(pick ? get(frame, pick) : frame));
            }
          } catch (err) {
            settle(() => reject(err instanceof Error ? err : new Error(String(err))));
          }
        };
        ws.onerror = () => settle(() => reject(new Error(`wsRpc websocket error (sent ${msg.type})`)));
      });
    },
    { msg, awaitType, timeout: opts.timeout ?? 10000, match: opts.match ?? null, pick: opts.pick ?? null },
  ) as Promise<T>;
}

export interface WsPollOptions {
  /** Deadline in ms (default 10000). Checked on each response frame — a
   *  server that never answers hangs the call, same as the inlined originals. */
  timeout?: number;
  /** Resend delay after a non-matching response (default 150). */
  intervalMs?: number;
  /** Helper name used in error messages. */
  label?: string;
}

/**
 * Polling read: open a socket, authenticate, send `request` immediately, and
 * re-send it every `intervalMs` after each `responseType` frame whose `path`
 * value does not equal `expected` (`expected === undefined` matches any
 * defined value, JSON comparison otherwise). Resolves on the first match;
 * rejects on a server `error` frame, websocket error, or once past the
 * deadline (checked on response arrival, matching the inlined originals).
 */
export async function wsPoll(
  page: Page,
  request: WsFrame,
  responseType: string,
  path: string,
  expected: unknown,
  opts: WsPollOptions = {},
): Promise<void> {
  await page.evaluate(
    ({ request, responseType, path, expected, hasExpected, timeout, intervalMs, label }) => {
      return new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
        const deadline = Date.now() + timeout;
        const get = (obj: unknown, p: string): unknown =>
          p.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
        const matches = (value: unknown): boolean =>
          !hasExpected ? value !== undefined : JSON.stringify(value) === JSON.stringify(expected);
        const ask = () => ws.send(JSON.stringify(request));
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth' }));
          ask();
        };
        ws.onmessage = (event) => {
          try {
            const frame = JSON.parse(event.data as string);
            if (frame.type === responseType) {
              const value = get(frame, path);
              if (matches(value)) {
                ws.close();
                resolve();
              } else if (Date.now() > deadline) {
                ws.close();
                reject(
                  new Error(
                    `${label}: "${path}" did not become ${JSON.stringify(expected)} within ${timeout}ms (last: ${JSON.stringify(value)})`,
                  ),
                );
              } else {
                setTimeout(ask, intervalMs);
              }
            }
            if (frame.type === 'error') {
              ws.close();
              reject(new Error(frame.message ?? `${request.type} failed`));
            }
          } catch (err) {
            ws.close();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };
        ws.onerror = () => {
          ws.close();
          reject(new Error('WebSocket error'));
        };
      });
    },
    {
      request,
      responseType,
      path,
      expected: expected === undefined ? null : expected,
      hasExpected: expected !== undefined,
      timeout: opts.timeout ?? 10000,
      intervalMs: opts.intervalMs ?? 150,
      label: opts.label ?? 'wsPoll',
    },
  );
}
