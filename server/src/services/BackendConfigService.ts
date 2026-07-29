/**
 * BackendConfig service — orchestrates backend config lifecycle with cascading side effects.
 */

import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import { NotFoundError } from '../errors.js';

export type DeleteBackendConfigResult =
  | {
      success: true;
      fallbackBackendConfigId: string | null;
    }
  | {
      success: false;
      error: { message: string; code: string };
      fallbackBackendConfigId: string | null;
    };

export class BackendConfigService {
  constructor(
    private backendConfigs: IBackendConfigRepository,
    private settings: ISettingsRepository,
  ) {}

  async deleteBackendConfig(backendConfigId: string): Promise<DeleteBackendConfigResult> {
    const count = await this.backendConfigs.count();
    if (count <= 1) {
      return {
        success: false,
        error: { message: 'Cannot delete the last backend config', code: 'LAST_BACKEND_CONFIG' },
        fallbackBackendConfigId: null,
      };
    }

    const activeBackendConfigId = await this.settings.get('activeBackendConfigId');
    let fallbackBackendConfigId: string | null = null;

    if (activeBackendConfigId === backendConfigId) {
      const remaining = await this.backendConfigs.listSummaries();
      const fallback = remaining.find((p) => p.id !== backendConfigId);
      if (fallback) {
        fallbackBackendConfigId = fallback.id;
        await this.settings.setValue('activeBackendConfigId', fallbackBackendConfigId);
      }
    }

    try {
      await this.backendConfigs.delete(backendConfigId);
    } catch (err) {
      // Already gone (stale client list / racing delete) — the desired end
      // state holds, so report success rather than erroring to the user.
      if (!(err instanceof NotFoundError)) throw err;
    }

    return {
      success: true,
      fallbackBackendConfigId,
    };
  }
}
