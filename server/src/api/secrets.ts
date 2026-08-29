/**
 * Secret REST API — encrypted vault list/set/delete.
 *
 * Listing masks values unless the request authenticated with the MASTER
 * credential (TAMARI_SECRET). Session tokens get `{masked, hint}` shapes so
 * a leaked browser token can enumerate but not read vault contents; setting
 * or deleting needs no plaintext readback and stays open to sessions.
 */

import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { apiError } from '../middleware/errorHandler.js';
import type { SecretService, SecretEntry } from '../services/SecretService.js';
import { extractBearerToken, type AuthedRequest } from '../middleware/auth.js';
import type { AuthService, AuthKind } from '../services/AuthService.js';

const SecretSetSchema = z.object({
  key: z.string().min(1).max(256),
  value: z.string().min(1).max(10_240), // 10KB max
  label: z.string().max(256).optional(),
});

/** Value-free shape returned to non-master credentials. */
export interface MaskedSecretEntry {
  key: string;
  label?: string;
  masked: true;
  hint: string;
}

export function createSecretsRouter(secretService: SecretService, secretsPassword: string, auth?: AuthService): Router {
  const router = Router();

  async function kindFor(req: Request): Promise<AuthKind | null> {
    // When the AuthService is wired in, trust its classification of THIS
    // request's presented credential (not the middleware's stored kind) so
    // masking tracks exactly what was presented.
    if (!auth) return (req as AuthedRequest).authKind ?? null;
    return auth.classify(req.socket.remoteAddress ?? undefined, extractBearerToken(req));
  }

  router.get('/', async (req, res) => {
    try {
      const items = await secretService.list(secretsPassword);
      const kind = await kindFor(req);
      if (kind === 'master') {
        res.json(items satisfies SecretEntry[]);
        return;
      }
      const masked: MaskedSecretEntry[] = items.map((item) => ({
        key: item.key,
        ...(item.label !== undefined ? { label: item.label } : {}),
        masked: true,
        hint: item.value.length >= 4 ? `••••${item.value.slice(-4)}` : '••••',
      }));
      res.json(masked);
    } catch (err) {
      // Redaction boundary: service errors can embed vault plaintext (cipher
      // failures quote the value), so answer a fixed generic message at every
      // NODE_ENV. The central handler logs the original via `cause`.
      throw apiError('SECRET_LIST_FAILED', 'Failed to list secrets', 500, { cause: err });
    }
  });

  router.post('/', async (req, res) => {
    const parsed = SecretSetSchema.safeParse(req.body);
    if (!parsed.success) {
      throw apiError('INVALID_REQUEST', 'Invalid request body', 400, { details: parsed.error.flatten() });
    }
    try {
      const { key, value, label } = parsed.data;
      await secretService.set(key, value, secretsPassword, label);
      res.json({ ok: true });
    } catch (err) {
      // Redaction boundary — see GET /.
      throw apiError('SECRET_SET_FAILED', 'Failed to set secret', 500, { cause: err });
    }
  });

  router.delete('/:key', async (req, res) => {
    try {
      await secretService.delete(z.string().parse(req.params.key), secretsPassword);
      res.json({ ok: true });
    } catch (err) {
      // Redaction boundary — see GET /.
      throw apiError('SECRET_DELETE_FAILED', 'Failed to delete secret', 500, { cause: err });
    }
  });

  return router;
}
