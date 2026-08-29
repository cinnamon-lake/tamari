/**
 * Express auth middleware + shared bearer-token extraction.
 *
 * Marks each request with the credential kind that satisfied it
 * (`req.authKind`) so routers can distinguish master credentials (scripts,
 * full access incl. vault plaintext) from issued session tokens (the
 * browser's revocable credential — see AuthService).
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthService, AuthKind } from '../services/AuthService.js';

const PUBLIC_ASSET_PATH = /^\/characters\/[^/]+\/assets\/[^/]+$/;

/** Bearer header first, query-param fallback for <img> tags that cannot send headers. */
export function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  if (typeof req.query.token === 'string') return req.query.token;
  return undefined;
}

/** Brute-force bucket key: raw peer address (x-forwarded-for is not trusted here). */
function peerOf(req: Request): string | undefined {
  return req.socket.remoteAddress ?? undefined;
}

export interface AuthedRequest extends Request {
  authKind?: AuthKind;
}

export function createAuthMiddleware(auth: AuthService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Allow health checks without auth
    if (req.path === '/health') {
      next();
      return;
    }

    // Character assets are public content referenced in message markdown
    if (PUBLIC_ASSET_PATH.test(req.path)) {
      next();
      return;
    }

    const kind = await auth.classify(peerOf(req), extractBearerToken(req));
    if (!kind) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    (req as AuthedRequest).authKind = kind;
    next();
  };
}
