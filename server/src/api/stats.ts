/**
 * Stats REST API — global usage statistics.
 */

import { Router } from 'express';
import { getLogger } from '../lib/logger.js';
import type { StatsService } from '../services/StatsService.js';

const log = getLogger('api/stats');

export function createStatsRouter(statsService: StatsService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const stats = await statsService.getGlobalStats();
      res.json(stats);
    } catch (err) {
      log.error({ err }, 'stats: error');
      res.status(500).json({ error: 'Failed to load stats' });
    }
  });

  return router;
}
