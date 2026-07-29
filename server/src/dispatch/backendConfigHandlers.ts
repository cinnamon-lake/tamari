/**
 * `backendConfig.*` messages — selection and CRUD with fallback broadcast.
 */

import { randomUUID } from 'node:crypto';
import { toBackendConfigSummary } from '../lib/summaries.js';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildBackendConfigHandlers(
  deps: DispatcherDeps,
): Handlers<
  'backendConfig.select' | 'backendConfig.list' | 'backendConfig.create' | 'backendConfig.update' | 'backendConfig.delete'
> {
  const { bus, backendConfigs, backendConfigService } = deps;

  return {
    'backendConfig.select': async (client, msg) => {
      const backendConfig = await backendConfigs.getById(msg.backendConfigId);
      if (!backendConfig) {
        bus.sendTo(client.id, { type: 'error', message: 'Backend config not found', code: 'NOT_FOUND' });
        return;
      }
      bus.broadcast({ type: 'backendConfig.snapshot', backendConfig }, client.id);
    },

    'backendConfig.list': async (client, _msg) => {
      const list = await backendConfigs.listSummaries();
      bus.sendTo(client.id, { type: 'backendConfig.listed', backendConfigs: list.map(toBackendConfigSummary) });
    },

    'backendConfig.create': async (client, msg) => {
      const id = randomUUID();
      const backendConfig = await backendConfigs.create(id, msg.data);
      bus.broadcast({ type: 'backendConfig.created', backendConfig }, client.id);
      bus.broadcast({ type: 'backendConfig.snapshot', backendConfig }, client.id);
      const list = await backendConfigs.listSummaries();
      bus.broadcast({ type: 'backendConfig.listed', backendConfigs: list.map(toBackendConfigSummary) }, client.id);
    },

    'backendConfig.update': async (client, msg) => {
      const backendConfig = await backendConfigs.update(msg.backendConfigId, msg.patch);
      bus.broadcast({ type: 'backendConfig.updated', backendConfig }, client.id);
      bus.broadcast({ type: 'backendConfig.snapshot', backendConfig }, client.id);
      const list = await backendConfigs.listSummaries();
      bus.broadcast({ type: 'backendConfig.listed', backendConfigs: list.map(toBackendConfigSummary) }, client.id);
    },

    'backendConfig.delete': async (client, msg) => {
      const result = await backendConfigService.deleteBackendConfig(msg.backendConfigId);
      if (!result.success) {
        bus.sendTo(client.id, {
          type: 'error',
          message: result.error.message,
          code: result.error.code,
        });
        return;
      }
      if (result.fallbackBackendConfigId) {
        bus.broadcast(
          { type: 'settings.changed', key: 'activeBackendConfigId', value: result.fallbackBackendConfigId },
          client.id,
        );
      }
      bus.broadcast({ type: 'backendConfig.deleted', backendConfigId: msg.backendConfigId }, client.id);
      const list = await backendConfigs.listSummaries();
      bus.broadcast({ type: 'backendConfig.listed', backendConfigs: list.map(toBackendConfigSummary) }, client.id);
    },
  };
}
