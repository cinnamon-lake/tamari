/**
 * 012 — copy the deprecated global `api_url`/`api_key` settings into the
 * active backend config, then remove them.
 *
 * Moved from main.ts, where it ran as an ad-hoc boot-time migration after
 * `ensureDefaultBackendConfig`. That ordering is preserved here: if legacy
 * connection settings exist but no backend config does, the default configs
 * are created first so the settings have somewhere to land.
 */

import { randomUUID } from 'node:crypto';
import { str } from '../../lib/coerce.js';
import { getLogger } from '../../lib/logger.js';
import { loadDefaultConfigs } from '../../lib/loadDefaultConfigs.js';
import { BackendConfigRepository } from '../../repos/BackendConfigRepository.js';
import { SettingsRepository } from '../../repos/SettingsRepository.js';
import type { Migration } from '../runMigrations.js';

const log = getLogger('db');

const migration: Migration = {
  async up({ db }) {
    const backendConfigs = new BackendConfigRepository(db);
    const settings = new SettingsRepository(db);

    const allSettings = await settings.list();
    const globalApiUrl = allSettings['api_url'];
    const globalApiKey = allSettings['api_key'];
    const hasGlobalConnection =
      (globalApiUrl && str(globalApiUrl).trim().length > 0) ||
      (globalApiKey && str(globalApiKey).trim().length > 0);
    if (!hasGlobalConnection) return;

    const activeBackendConfigId = allSettings['activeBackendConfigId'];
    let backendConfig = activeBackendConfigId
      ? await backendConfigs.getById(String(activeBackendConfigId))
      : undefined;

    if (!backendConfig) {
      // No active config to receive the legacy settings — create the default
      // set, mirroring what main.ts's ensureDefaultBackendConfig did before
      // this migration ran there.
      if ((await backendConfigs.count()) === 0) {
        for (const { backendConfig: defaultConfig } of loadDefaultConfigs()) {
          await backendConfigs.create(randomUUID(), defaultConfig);
        }
      }
      backendConfig = (await backendConfigs.list())[0];
      if (!backendConfig) return;
      await settings.setValue('activeBackendConfigId', backendConfig.id);
    }

    const patch: { apiUrl?: string; apiKey?: string } = {};
    if (!backendConfig.apiUrl && globalApiUrl) patch.apiUrl = str(globalApiUrl);
    if (!backendConfig.apiKey && globalApiKey) patch.apiKey = str(globalApiKey);
    if (Object.keys(patch).length > 0) {
      await backendConfigs.update(backendConfig.id, patch);
      log.info('migrated global api_url/api_key into active backend config');
    }

    await settings.delete('api_url');
    await settings.delete('api_key');
    await settings.delete('reverseProxyUrl');
    await settings.delete('proxyPassword');
    log.info('removed deprecated global connection settings');
  },
};

export default migration;
