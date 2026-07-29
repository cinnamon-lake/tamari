import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthService } from '../services/AuthService.js';

export function createAuthMiddleware(auth: AuthService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Allow health checks without auth
    if (req.path === '/health') {
      next();
      return;
    }

    // Character assets are public content referenced in message markdown
    if (/^\/characters\/[^/]+\/assets\/[^/]+$/.test(req.path)) {
      next();
      return;
    }

    // Check Authorization header first
    const authHeader = req.headers.authorization;
    let token: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    // Fall back to query param (needed for <img> tags that can't send headers)
    if (!token && typeof req.query.token === 'string') {
      token = req.query.token;
    }

    if (!auth.validate(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
