/**
 * Logs outgoing HTTP requests to AI backends.
 *
 * Logs the request exactly as it is handed to `fetch()`, including
 * URL, method, headers (with API keys redacted), and the FULL body
 * (credential keys scrubbed). Seeing the exact prompt that went out
 * is a constant debugging necessity — this is mandatory, no toggle,
 * no debug-level gate.
 */

import { getLogger } from '../lib/logger.js';

const log = getLogger('backend');

const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'x-auth-token']);

const SENSITIVE_BODY_KEYS = new Set(
  [
    'apiKey',
    'apikey',
    'key',
    'token',
    'secret',
    'password',
    'auth',
    'authorization',
    'access_token',
    'refresh_token',
  ].map((k) => k.toLowerCase().replace(/[-_.]/g, '')),
);

/** Substrings that mark a key as credential-bearing even in compound names (proxy_password, api_secret, clientToken…). */
const SENSITIVE_KEY_SUBSTRINGS = ['password', 'secret', 'token', 'apikey'];

function isSensitiveKeyName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_.]/g, '');
  return SENSITIVE_BODY_KEYS.has(normalized) || SENSITIVE_KEY_SUBSTRINGS.some((s) => normalized.includes(s));
}

/** Redact credentials carried in the query string (e.g. KoboldCpp/llama.cpp `?key=` / `?password=`). */
export function scrubUrlQuery(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (isSensitiveKeyName(k)) u.searchParams.set(k, '[REDACTED]');
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function logRequest(
  adapterId: string,
  url: string,
  init: { method?: string; headers?: unknown; body?: unknown },
): void {
  const method = init.method ?? 'POST';
  const headers = redactHeaders(init.headers);
  const body = formatBody(init.body);
  const safeUrl = scrubUrlQuery(url);

  log.info({ adapterId, method, url: safeUrl, headers, bodyLength: body.length }, `${adapterId} → ${method} ${safeUrl} (${body.length} chars)`);
  // The full (credential-scrubbed) body, always: prompt-list debugging needs it.
  log.info({ adapterId, body }, `${adapterId} request body`);
}

/** Log a non-2xx response with its (scrubbed) error body — upstream detail otherwise only reaches a transient toast. */
export function logHttpError(adapterId: string, status: number, errorBody: string): void {
  log.error({ adapterId, status, errorBody: scrubText(errorBody) }, `${adapterId} HTTP ${status}`);
}

/** Log a request that failed before/without an HTTP exchange (script errors, transport failures). */
export function logRequestError(adapterId: string, err: unknown): void {
  log.error({ adapterId, err }, `${adapterId} request failed`);
}

export function logResponseHeaders(adapterId: string, response: Response): void {
  const headers: Record<string, string> = {};
  // Tests mock Response without headers; runtime guard required despite DOM types
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (response.headers?.forEach) {
    response.headers.forEach((value, key) => {
      if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
        headers[key] = value;
      }
    });
  }
  log.info({ adapterId, status: response.status, headers }, `${adapterId} status: ${response.status}`);
}

/**
 * True when a parsed stream object carries the generation's finish signal:
 * - OpenAI-style: `choices[0].finish_reason`
 * - Gemini: `candidates[0].finishReason`
 * - Claude: `delta.stop_reason` (message_delta)
 * - KoboldCpp: top-level `finish_reason`
 * - llama.cpp: terminal chunk flagged `stop: true`
 */
function carriesFinishSignal(delta: unknown): boolean {
  if (typeof delta !== 'object' || delta === null) return false;
  const d = delta as Record<string, unknown>;
  const first = (key: string): Record<string, unknown> | undefined => {
    const arr = d[key];
    const item = Array.isArray(arr) ? (arr[0] as unknown) : undefined;
    return typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : undefined;
  };
  if (typeof first('choices')?.['finish_reason'] === 'string') return true;
  if (typeof first('candidates')?.['finishReason'] === 'string') return true;
  const inner = d['delta'];
  if (typeof inner === 'object' && inner !== null && typeof (inner as Record<string, unknown>)['stop_reason'] === 'string') return true;
  if (typeof d['finish_reason'] === 'string') return true;
  if (d['stop'] === true) return true;
  return false;
}

export function logDelta(adapterId: string, delta: unknown): void {
  // The terminal stream object — the one carrying the finish reason — is
  // always logged at info, no gate: seeing why a generation ended is as
  // necessary as seeing the request. Per-token deltas are logged at debug;
  // enable them with LOG_LEVEL=debug when a stream needs inspecting.
  if (carriesFinishSignal(delta)) {
    log.info({ adapterId, delta }, `${adapterId} stream finish`);
    return;
  }
  log.debug({ adapterId, delta }, `${adapterId} stream delta`);
}

export function redactHeaders(headers: unknown): Record<string, string> {
  if (!headers) return {};

  const entries: Array<[string, string]> = [];

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      entries.push([key, value]);
    });
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) entries.push([key, String(value)]);
    }
  }

  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKeyName(k)) {
        obj[k] = typeof v === 'string' && v.length > 64 ? `[REDACTED ${v.length} chars]` : '[REDACTED]';
      } else {
        obj[k] = scrubValue(v);
      }
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  return value;
}

export function scrubBodyText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const scrubbed = scrubValue(parsed);
    return JSON.stringify(scrubbed);
  } catch (err) {
    log.debug({ err }, 'scrubBodyText: not valid JSON, returning raw');
    return text;
  }
}

/** Matches Bearer-token-style credentials embedded in arbitrary text. */
const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Scrub an arbitrary text blob (e.g. an upstream error body): JSON-aware key
 * redaction plus a regex pass for `Bearer <token>`-style credentials that
 * appear outside structured fields.
 */
export function scrubText(text: string): string {
  return scrubBodyText(text).replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]');
}

function formatBody(body: unknown): string {
  if (body === undefined || body === null) return '[empty]';
  if (typeof body === 'string') {
    return scrubBodyText(body);
  }
  if (body instanceof Uint8Array) {
    try {
      const text = new TextDecoder().decode(body);
      return scrubBodyText(text);
    } catch (err) {
      log.debug({ err }, 'formatBody: TextDecoder failed');
      return `[binary ${body.byteLength} bytes]`;
    }
  }
  if (ArrayBuffer.isView(body)) {
    try {
      const text = new TextDecoder().decode(body);
      return scrubBodyText(text);
    } catch (err) {
      log.debug({ err }, 'formatBody: TextDecoder failed (ArrayBuffer view)');
      return `[binary ${body.byteLength} bytes]`;
    }
  }
  if (body instanceof FormData) {
    return '[FormData]';
  }
  if (body instanceof URLSearchParams) {
    const scrubbed = new URLSearchParams();
    for (const [k, v] of body.entries()) {
      scrubbed.append(k, isSensitiveKeyName(k) ? '[REDACTED]' : v);
    }
    return scrubbed.toString();
  }
  if (body instanceof Blob) {
    return `[Blob ${body.size} bytes]`;
  }
  return '[unknown body type]';
}
