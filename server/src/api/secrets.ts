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
import { getLogger } from '../lib/logger.js';
import type { SecretService, SecretEntry } from '../services/SecretService.js';
import { extractBearerToken, type AuthedRequest } from '../middleware/auth.js';
import type { AuthService, AuthKind } from '../services/AuthService.js';

const log = getLogger('api/secrets');

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

export function createSecretsRouter(
  secretService: SecretService,
  secretsPassword: string,
  auth?: AuthService,
): Router {
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
      log.error({ err }, 'secrets: list error');
      res.status(500).json({ error: 'Failed to list secrets' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const parsed = SecretSetSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
        return;
      }
      const { key, value, label } = parsed.data;
      await secretService.set(key, value, secretsPassword, label);
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'secrets: set error');
      res.status(500).json({ error: 'Failed to set secret' });
    }
  });

  router.delete('/:key', async (req, res) => {
    try {
      await secretService.delete(z.string().parse(req.params.key), secretsPassword);
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'secrets: delete error');
      res.status(500).json({ error: 'Failed to delete secret' });
    }
  });

  return router;
}
