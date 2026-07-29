/**
 * Shared HTTP request prologue for backend adapters.
 *
 * Every adapter's `stream()` used to inline the same sequence: build the
 * request, optionally run the Lua request script, log, fetch, and map
 * transport-level failures to a `GenerationResult`. `executeRequest` is that
 * shared prologue — adapters implement `buildRequest` + stream parsing only.
 */

import type { GenerationResult } from './BackendAdapter.js';
import { logger } from '../lib/logger.js';
import { logHttpError, logRequest, logRequestError, logResponseHeaders } from './RequestLogger.js';
import { applyRequestScript, RequestScriptError } from './RequestScript.js';

/**
 * Config fields shared by every backend adapter. Provider adapters extend
 * this with their own knobs (e.g. Claude `cacheTTL`, KoboldCpp
 * `contextLength`, OpenRouter routing options).
 */
export interface BaseAdapterConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** Default provider-specific generation parameters (temperature, topP, etc.). */
  params?: Record<string, unknown>;
  /** Lua script that mutates the outgoing HTTP request before it is sent. */
  requestScript?: string;
}

export interface ExecuteRequestOptions {
  /** Adapter id, used for request/response logging. */
  adapterId: string;
  /** The request as built by the adapter's `buildRequest`. */
  request: { url: string; init: RequestInit };
  /** Optional Lua request script applied to the request before sending. */
  requestScript?: string;
  signal: AbortSignal;
  /** Prompt token estimate, used for the usage fallback on early errors. */
  promptTokens: number;
}

export type ExecuteRequestOutcome =
  | { ok: true; body: ReadableStream<Uint8Array> }
  | { ok: false; result: GenerationResult };

/**
 * Run the shared request prologue: apply the request script, log, fetch, and
 * map script errors / HTTP errors / missing bodies to a `GenerationResult`.
 * On success returns the response body for the adapter to parse.
 * Non-`RequestScriptError` script failures are re-thrown.
 */
export async function executeRequest(options: ExecuteRequestOptions): Promise<ExecuteRequestOutcome> {
  const { adapterId, request, requestScript, signal, promptTokens } = options;

  let finalUrl = request.url;
  let finalInit = request.init;
  if (requestScript) {
    try {
      const result = await applyRequestScript(finalUrl, finalInit, requestScript);
      finalUrl = result.url;
      finalInit = result.init;
    } catch (err) {
      if (err instanceof RequestScriptError) {
        logRequestError(adapterId, err);
        return {
          ok: false,
          result: {
            finishReason: 'error',
            usage: { promptTokens, completionTokens: 0 },
            error: `Request script error: ${err.message}`,
          },
        };
      }
      throw err;
    }
  }

  logRequest(adapterId, finalUrl, finalInit);
  let response: Response;
  try {
    response = await fetch(finalUrl, { ...finalInit, signal });
  } catch (err) {
    logRequestError(adapterId, err);
    throw err;
  }
  logResponseHeaders(adapterId, response);

  if (!response.ok) {
    const text = await response.text().catch((err) => {
      logger.debug({ err }, 'HTTP error body read failed');
      return 'Unknown error';
    });
    logHttpError(adapterId, response.status, text);
    return {
      ok: false,
      result: {
        finishReason: 'error',
        usage: { promptTokens, completionTokens: 0 },
        error: `HTTP ${response.status}: ${text}`,
      },
    };
  }

  if (!response.body) {
    return {
      ok: false,
      result: {
        finishReason: 'error',
        usage: { promptTokens, completionTokens: 0 },
        error: 'No response body',
      },
    };
  }

  return { ok: true, body: response.body };
}
