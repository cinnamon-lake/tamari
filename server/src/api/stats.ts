/**
 * Stats REST API — global usage statistics.
 */

import { Router } from 'express';
import type { StatsService } from '../services/StatsService.js';

export function createStatsRouter(statsService: StatsService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const stats = await statsService.getGlobalStats();
    res.json(stats);
  });

  return router;
}
