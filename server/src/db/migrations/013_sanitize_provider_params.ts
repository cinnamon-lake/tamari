/**
 * 013 — drop undeclared providerParams keys (legacy v1 settings dumps) from
 * every stored backend config.
 *
 * Moved from main.ts, where it ran as an every-boot sweep. One-time is
 * sufficient: BackendConfigRepository has sanitized providerParams on write
 * since the split tables were introduced, so configs written after this
 * migration can never carry undeclared keys.
 */

import { sanitizeProviderParams } from '@tamari/types';
import { getLogger } from '../../lib/logger.js';
import { BackendConfigRepository } from '../../repos/BackendConfigRepository.js';
import type { Migration } from '../runMigrations.js';

const log = getLogger('db');

const migration: Migration = {
  async up({ db }) {
    const backendConfigs = new BackendConfigRepository(db);
    for (const config of await backendConfigs.list()) {
      const clean = sanitizeProviderParams(config.providerParams);
      const dropped = Object.keys(config.providerParams).filter((k) => !(k in clean));
      if (dropped.length > 0) {
        await backendConfigs.update(config.id, { providerParams: clean });
        log.info({ configId: config.id, name: config.name, dropped }, 'dropped undeclared providerParams keys');
      }
    }
  },
};

export default migration;
