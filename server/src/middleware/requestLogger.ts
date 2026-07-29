/**
 * Express middleware — logs every HTTP request and response.
 *
 * Always logs at info level (method, path, status, duration).
 * Logs request/response bodies at debug level.
 * Generates and propagates a correlation ID (x-request-id) per request.
 */

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../lib/logger.js';

const log = getLogger('api');

export function requestLogger(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const route = (req.route as { path?: string } | undefined)?.path ?? req.path;
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();

    // Propagate correlation ID to response headers
    res.setHeader('x-request-id', requestId);

    // Create a child logger with the request ID for this request
    const reqLog = log.child({ requestId });

    // Attach to request for use in route handlers
    (req as Request & { requestId: string }).requestId = requestId;

    // Debug: log request body for non-GET requests
    if (req.method !== 'GET' && reqLog.isLevelEnabled('debug')) {
      reqLog.debug({ method: req.method, path: route, body: sanitizeBody(req.body) }, '→ request');
    }

    res.on('finish', () => {
      const duration = Date.now() - start;
      const status = res.statusCode;

      reqLog.info(
        { method: req.method, path: route, status, duration_ms: duration },
        `${req.method} ${route} ${status} (${duration}ms)`,
      );

      // Debug: log response body for errors
      if (status >= 400 && reqLog.isLevelEnabled('debug')) {
        reqLog.debug({ method: req.method, path: route, status }, '← response error');
      }
    });

    next();
  };
}

const SENSITIVE_BODY_KEYS = new Set(
  [
    'apiKey',
    'apikey',
    'api_key',
    'key',
    'token',
    'secret',
    'password',
    'auth',
    'authorization',
    'value',
    'access_token',
    'refresh_token',
    'proxy_password',
    'proxypassword',
  ].map((k) => k.toLowerCase().replace(/[-_.]/g, '')),
);

function sanitizeBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map(sanitizeBody);
  const b = body as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  // Recursively redact sensitive fields by normalized key name (covers nested bodies and the
  // previous broken list — duplicate 'apiKey', missing 'value'/'api_key'/'authorization').
  for (const [key, value] of Object.entries(b)) {
    const normalized = key.toLowerCase().replace(/[-_.]/g, '');
    clone[key] = SENSITIVE_BODY_KEYS.has(normalized) ? '[REDACTED]' : sanitizeBody(value);
  }
  return clone;
}
