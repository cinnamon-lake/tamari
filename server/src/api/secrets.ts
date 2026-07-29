/**
 * Secret REST API — encrypted vault list/set/delete.
 */

import { Router } from 'express';
import { z } from 'zod';
import { getLogger } from '../lib/logger.js';
import type { SecretService } from '../services/SecretService.js';

const log = getLogger('api/secrets');

const SecretSetSchema = z.object({
  key: z.string().min(1).max(256),
  value: z.string().min(1).max(10_240), // 10KB max
  label: z.string().max(256).optional(),
});

export function createSecretsRouter(secretService: SecretService, secretsPassword: string): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const items = await secretService.list(secretsPassword);
      res.json(items);
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
