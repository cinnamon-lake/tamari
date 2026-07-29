/**
 * SSRF-guarded fetch for Lua tool templates (`allowNet` sandbox flag).
 *
 * Exposed to Lua as an async global `fetch(url, opts?)` and awaited from Lua
 * via wasmoon's promise support: `local res = fetch(url):await()`.
 *
 * Guard policy: loopback is ALLOWED (local media servers — Forge, Silero, … —
 * are the flagship use case, and only user-authored templates can enable
 * allowNet); other private/LAN/link-local ranges stay blocked, same as the
 * request-script guard with allowLocalhost=true.
 */

import { assertSafeUrl } from '../backends/RequestScript.js';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export interface LuaFetchResult {
  status: number;
  headers: Record<string, string>;
  /** UTF-8 decoded body, or null when the body isn't valid UTF-8 (binary). */
  body: string | null;
  /** Base64 of the raw body — always present, for binary payloads. */
  bodyBase64: string;
}

export interface LuaFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function readBodyWithCap(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`fetch: response body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function tryDecodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export async function luaFetch(url: string, opts?: LuaFetchOptions): Promise<LuaFetchResult> {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('fetch: url is required');
  }
  await assertSafeUrl(url, /* allowLocalhost */ true);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: opts?.method ?? 'GET',
      headers: opts?.headers,
      body: opts?.body,
      signal: controller.signal,
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      // Cookies from arbitrary hosts have no business in model context.
      if (key.toLowerCase() === 'set-cookie') return;
      headers[key] = value;
    });

    const buf = await readBodyWithCap(res);
    return {
      status: res.status,
      headers,
      body: tryDecodeUtf8(buf),
      bodyBase64: buf.toString('base64'),
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`fetch: request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
