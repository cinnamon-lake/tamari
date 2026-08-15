/**
 * 017 — move the global Claude prompt-caching settings (`claudeCacheMode`,
 * `claudeCacheDepth`, `claudeCacheTTL`) out of the settings blob into the
 * `providerParams` (`cacheMode`, `cacheDepth`, `cacheTTL`) of every backend
 * config whose provider is `claude` or `openrouter`, then drop the globals.
 *
 * The values are read from the RAW settings blob (mirroring 016): the current
 * AppSettingsSchema no longer declares the claudeCache* keys, and migration
 * code should not depend on schema catchall behavior for deleted keys.
 * Configs that already carry a key keep it (first writer wins). Idempotent:
 * with the globals gone there is nothing left to copy, and re-running is a
 * no-op.
 */

import { str } from '../../lib/coerce.js';
import { getLogger } from '../../lib/logger.js';
import { BackendConfigRepository } from '../../repos/BackendConfigRepository.js';
import { SettingsRepository } from '../../repos/SettingsRepository.js';
import type { Migration } from '../runMigrations.js';

const log = getLogger('db');

const CACHE_PROVIDERS = new Set(['claude', 'openrouter']);

const migration: Migration = {
  async up({ db }) {
    const backendConfigs = new BackendConfigRepository(db);
    const settings = new SettingsRepository(db);

    const row = await db.execute('SELECT blob FROM settings WHERE id = 0');
    const raw = (
      row.rows.length > 0 ? JSON.parse(str(row.rows[0]?.blob, '{}')) : {}
    ) as Record<string, unknown>;

    const hasGlobals =
      'claudeCacheMode' in raw || 'claudeCacheDepth' in raw || 'claudeCacheTTL' in raw;

    if (hasGlobals) {
      const globalMode = raw['claudeCacheMode'];
      const globalDepth = raw['claudeCacheDepth'];
      const globalTTL = raw['claudeCacheTTL'];

      for (const config of await backendConfigs.list()) {
        if (!CACHE_PROVIDERS.has(config.backendProvider)) continue;
        const providerParams = { ...config.providerParams };
        let touched = false;
        if (providerParams['cacheMode'] === undefined && globalMode !== undefined) {
          providerParams['cacheMode'] = globalMode;
          touched = true;
        }
        if (providerParams['cacheDepth'] === undefined && globalDepth !== undefined) {
          providerParams['cacheDepth'] = globalDepth;
          touched = true;
        }
        if (providerParams['cacheTTL'] === undefined && globalTTL != null && str(globalTTL).trim().length > 0) {
          providerParams['cacheTTL'] = str(globalTTL);
          touched = true;
        }
        if (touched) {
          await backendConfigs.update(config.id, { providerParams });
        }
      }

      await settings.delete('claudeCacheMode');
      await settings.delete('claudeCacheDepth');
      await settings.delete('claudeCacheTTL');
      log.info('moved global claudeCache* settings into claude/openrouter backend configs');
    }
  },
};

export default migration;
