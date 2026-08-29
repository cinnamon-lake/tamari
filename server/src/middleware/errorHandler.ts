/**
 * Centralized Express error handler.
 *
 * Canonical wire shape: `{ error: string }` plus an optional `details`
 * payload for validation errors — the flat shape the client and e2e tests
 * already consume. Route handlers throw `apiError(...)` (or let unexpected
 * exceptions propagate via Express 5 async forwarding); this handler is the
 * single place that serializes errors.
 *
 * Guarantees that no internal error details (stack traces, raw messages)
 * leak to the client in production: unexpected 5xx messages are redacted.
 * ApiError messages are deliberate, client-safe strings and are shown at any
 * status in every environment.
 */

import type { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { getLogger } from '../lib/logger.js';

const log = getLogger('middleware/errorHandler');

export interface ApiErrorOptions {
  /** Extra payload for the client (e.g. zod `flatten()` output on 400s). */
  details?: unknown;
  /** Original error, logged server-side but never serialized. */
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, options?: ApiErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = options?.details;
  }
}

export function apiError(code: string, message: string, status: number, options?: ApiErrorOptions): ApiError {
  return new ApiError(code, message, status, options);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // Multer errors carry a code (LIMIT_FILE_SIZE, …) but no status — map them
  // to client-meaningful 4xx instead of a misleading 500.
  const status =
    err instanceof MulterError
      ? err.code === 'LIMIT_FILE_SIZE'
        ? 413
        : 400
      : typeof err === 'object' && err !== null && 'status' in err
        ? (err as ApiError).status
        : 500;
  const code =
    typeof err === 'object' && err !== null && 'code' in err ? String((err as ApiError).code) : 'INTERNAL_ERROR';

  // Log full error details server-side, including the wrapped cause when a
  // route re-threw a low-level failure as a client-safe ApiError. 4xx is a
  // client mistake, not a server fault — warn, don't page.
  const fields = {
    err: err instanceof Error ? err.message : err,
    stack: err instanceof Error ? err.stack : undefined,
    cause: err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined,
    status,
    code,
    method: req.method,
    path: req.originalUrl,
  };
  if (status >= 500) {
    log.error(fields, 'request error');
  } else {
    log.warn(fields, 'request error');
  }

  // In production, never leak internal error messages or stack traces. Only
  // unexpected errors are redacted — ApiError messages are deliberate and
  // client-safe at any status, and 4xx messages like "File too large" are
  // safe and useful to show.
  const isProduction = process.env.NODE_ENV === 'production';
  const message =
    isProduction && status >= 500 && !(err instanceof ApiError)
      ? 'An internal error occurred'
      : typeof err === 'object' && err !== null && 'message' in err
        ? (err as Error).message
        : 'Unknown error';

  const body: Record<string, unknown> = { error: message };
  if (err instanceof ApiError && err.details !== undefined) {
    body['details'] = err.details;
  }
  res.status(status).json(body);
}
