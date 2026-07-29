import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { StatsService } from '../services/StatsService.js';
import { createStatsRouter } from './stats.js';

const fakeStats = {
  totalChats: 12,
  totalMessages: 345,
  totalCharacters: 6,
  totalPersonas: 2,
};

function createApp(statsService: StatsService) {
  const app = express();
  app.use('/stats', createStatsRouter(statsService));
  return app;
}

describe('createStatsRouter', () => {
  it('GET / returns the global stats from the service', async () => {
    const statsService = {
      getGlobalStats: vi.fn().mockResolvedValue(fakeStats),
    } as unknown as StatsService;

    const res = await request(createApp(statsService)).get('/stats').expect(200);

    expect(res.body).toEqual(fakeStats);
    expect(statsService.getGlobalStats).toHaveBeenCalledOnce();
  });

  it('returns 500 when the service fails', async () => {
    const statsService = {
      getGlobalStats: vi.fn().mockRejectedValue(new Error('db gone')),
    } as unknown as StatsService;

    const res = await request(createApp(statsService)).get('/stats').expect(500);

    expect(res.body.error).toBe('Failed to load stats');
  });
});
