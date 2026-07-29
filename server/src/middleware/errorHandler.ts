/**
 * Centralized Express error handler.
 *
 * Guarantees that no internal error details (stack traces, raw messages)
 * leak to the client in production. Returns a uniform error JSON shape.
 */

import type { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { getLogger } from '../lib/logger.js';

const log = getLogger('api');

export interface ApiError {
  code: string;
  message: string;
  status: number;
}

export function apiError(code: string, message: string, status: number): ApiError {
  return { code, message, status };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
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
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as ApiError).code : 'INTERNAL_ERROR';

  // Log full error details server-side
  if (err instanceof Error) {
    log.error({ err: err.message, stack: err.stack, status, code }, 'request error');
  } else {
    log.error({ err, status, code }, 'request error');
  }

  // In production, never leak internal error messages or stack traces (4xx
  // messages like "File too large" are safe and useful to show).
  const isProduction = process.env.NODE_ENV === 'production';
  const message =
    isProduction && status >= 500
      ? 'An internal error occurred'
      : (typeof err === 'object' && err !== null && 'message' in err ? (err as Error).message : 'Unknown error');

  res.status(status).json({
    error: {
      code,
      message,
    },
  });
}
