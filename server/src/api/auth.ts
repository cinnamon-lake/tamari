/**
 * Session-token auth API — the token-exchange login flow.
 *
 * POST /api/auth/session  { password } → { token, expiresAt }
 *   The browser presents TAMARI_SECRET once and thereafter holds a
 *   revocable session token (AuthService); the plaintext password is never
 *   persisted client-side. Brute-force attempts share the per-source buckets
 *   with every other auth surface via AuthService.
 *
 * DELETE /api/auth/session  (Bearer <session token>)
 *   Revoke the presented session. Master credentials cannot be "revoked";
 *   rotating TAMARI_SECRET serves that purpose.
 */

import { Router } from 'express';
import { z } from 'zod';
import { getLogger } from '../lib/logger.js';
import { apiError } from '../middleware/errorHandler.js';
import type { AuthService } from '../services/AuthService.js';
import type { Request } from 'express';
import { extractBearerToken } from '../middleware/auth.js';

const log = getLogger('api/auth');

const SessionRequestSchema = z.object({
  password: z.string().min(1).max(1024),
});

export function createAuthRouter(auth: AuthService): Router {
  const router = Router();

  // Mounted before the global requireAuth middleware on purpose: this IS the
  // login endpoint. All other /api routes stay behind the global guard.
  router.post('/session', async (req, res) => {
    const parsed = SessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw apiError('INVALID_REQUEST', 'Invalid request body', 400, { details: parsed.error.flatten() });
    }
    // Failed exchanges feed the same brute-force bucket as direct bearer use.
    if (!(await auth.validate(peerOf(req), parsed.data.password))) {
      throw apiError('INVALID_PASSWORD', 'Invalid password', 401);
    }
    const issued = await auth.issueSession(parsed.data.password);
    if (!issued) {
      throw apiError('SESSION_STORE_UNAVAILABLE', 'Session store unavailable', 500);
    }
    log.info('auth/session: issued');
    res.json({ token: issued.token, expiresAt: issued.expiresAt });
  });

  router.delete('/session', async (req, res) => {
    const kind = await auth.classify(peerOf(req), extractBearerToken(req));
    if (!kind) {
      throw apiError('UNAUTHORIZED', 'Unauthorized', 401);
    }
    const token = extractBearerToken(req);
    if (kind === 'master') {
      throw apiError('MASTER_NOT_REVOCABLE', 'Master credentials are not revocable; rotate TAMARI_SECRET instead', 400);
    }
    await auth.revokeSession(token);
    res.json({ ok: true });
  });

  return router;
}

function peerOf(req: Request): string | undefined {
  return req.socket.remoteAddress ?? undefined;
}
