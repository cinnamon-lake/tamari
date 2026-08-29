/**
 * st-api domain: settings & backend — global settings key/value access and
 * BackendConfig selection/parameters (model, apiUrl, temperature, maxTokens,
 * contextLength, provider).
 */

import { str } from '../../lib/coerce.js';
import { isSecretSettingKey } from '../../dispatch/helpers.js';
import type { StApiContext } from './context.js';
import type { StApi } from './types.js';

export type SettingsApi = Pick<
  StApi,
  | 'get_setting'
  | 'set_setting'
  | 'get_settings'
  | 'get_backend_configs'
  | 'get_backend_config'
  | 'set_backend_config'
  | 'get_model'
  | 'set_model'
  | 'get_apiUrl'
  | 'set_apiUrl'
  | 'get_temperature'
  | 'set_temperature'
  | 'get_maxTokens'
  | 'set_maxTokens'
  | 'get_contextLength'
  | 'set_contextLength'
  | 'get_backend'
  | 'set_backend'
>;

export function createSettings(c: StApiContext): SettingsApi {
  const { settings, backendConfigs, bus } = c.deps;
  const { checkAbort } = c;

  return {
    get_setting: async (key: string) => {
      checkAbort();
      const value = await settings.get(String(key));
      return value ?? null;
    },

    set_setting: async (key: string, value: unknown) => {
      checkAbort();
      await settings.setValue(String(key), value);
      // Never echo secret values back onto the wire.
      bus.broadcast({
        type: 'settings.changed',
        key: String(key),
        value: isSecretSettingKey(String(key)) ? null : value,
      });
    },

    get_settings: async () => {
      checkAbort();
      return await settings.list();
    },

    get_backend_configs: async () => {
      checkAbort();
      const list = await backendConfigs.list();
      return list.map((p) => ({
        id: p.id,
        name: p.name,
        backendProvider: p.backendProvider,
        model: p.model,
      }));
    },

    get_backend_config: async (id: string) => {
      checkAbort();
      if (typeof id !== 'string') throw new Error('get_backend_config: expected string');
      const p = await backendConfigs.getById(id);
      if (!p) return null;
      return {
        id: p.id,
        name: p.name,
        backendProvider: p.backendProvider,
        model: p.model,
        generationMode: p.generationMode,
        apiUrl: p.apiUrl,
        temperature: p.temperature,
        maxTokens: p.maxTokens,
        contextLength: p.contextLength,
        instructTemplate: p.instructTemplate,
        stopStrings: p.stopStrings,
      };
    },

    set_backend_config: async (id: string) => {
      checkAbort();
      if (typeof id !== 'string') throw new Error('set_backend_config: expected string');
      const p = await backendConfigs.getById(id);
      if (!p) throw new Error(`set_backend_config: backend config "${id}" not found`);
      await settings.setValue('activeBackendConfigId', id);
      bus.broadcast({ type: 'settings.changed', key: 'activeBackendConfigId', value: id });
    },

    get_model: async () => {
      checkAbort();
      const activeBackendConfigId = str(await settings.get('activeBackendConfigId'));
      if (activeBackendConfigId) {
        const p = await backendConfigs.getById(activeBackendConfigId);
        if (p?.model) return p.model;
      }
      return str(await settings.get('model'));
    },

    set_model: async (model: string) => {
      checkAbort();
      if (typeof model !== 'string') throw new Error('set_model: expected string');
      await settings.setValue('model', model);
      bus.broadcast({ type: 'settings.changed', key: 'model', value: model });
    },

    get_apiUrl: async () => {
      checkAbort();
      return str(await settings.get('apiUrl'));
    },

    set_apiUrl: async (url: string) => {
      checkAbort();
      if (typeof url !== 'string') throw new Error('set_apiUrl: expected string');
      await settings.setValue('apiUrl', url);
      bus.broadcast({ type: 'settings.changed', key: 'apiUrl', value: url });
    },

    get_temperature: async () => {
      checkAbort();
      // v2: temperature lives on the active BackendConfig; the top-level
      // settings key is a legacy fallback for installs without an active config.
      const activeBackendConfigId = str(await settings.get('activeBackendConfigId'));
      if (activeBackendConfigId) {
        const p = await backendConfigs.getById(activeBackendConfigId);
        if (p && p.temperature !== null) return p.temperature;
      }
      const val = await settings.get('temperature');
      return val !== undefined ? Number(val) : 0.7;
    },

    set_temperature: async (value: number) => {
      checkAbort();
      const num = Number(value);
      if (isNaN(num)) throw new Error('set_temperature: expected number');
      const activeBackendConfigId = str(await settings.get('activeBackendConfigId'));
      const active = activeBackendConfigId ? await backendConfigs.getById(activeBackendConfigId) : null;
      if (active) {
        // v2 home for temperature: patch the active BackendConfig so the value
        // actually reaches generation (buildBackendSettings reads it there).
        const updated = await backendConfigs.update(active.id, { temperature: num });
        bus.broadcast({ type: 'backendConfig.updated', backendConfig: updated });
        return;
      }
      await settings.setValue('temperature', num);
      bus.broadcast({ type: 'settings.changed', key: 'temperature', value: num });
    },

    get_maxTokens: async () => {
      checkAbort();
      const val = await settings.get('maxResponseTokens');
      return val !== undefined ? Number(val) : 512;
    },

    set_maxTokens: async (value: number) => {
      checkAbort();
      const num = Math.max(1, Math.floor(Number(value)));
      if (isNaN(num)) throw new Error('set_maxTokens: expected number');
      await settings.setValue('maxResponseTokens', num);
      bus.broadcast({ type: 'settings.changed', key: 'maxResponseTokens', value: num });
    },

    get_contextLength: async () => {
      checkAbort();
      // Context length lives only on the BackendConfig (there is no global
      // setting anymore); fall back to the macro/wire default without one.
      const activeBackendConfigId = str(await settings.get('activeBackendConfigId'));
      if (activeBackendConfigId) {
        const p = await backendConfigs.getById(activeBackendConfigId);
        if (p && p.contextLength !== null) return p.contextLength;
      }
      return 4096;
    },

    set_contextLength: async (value: number) => {
      checkAbort();
      const num = Math.max(1, Math.floor(Number(value)));
      if (isNaN(num)) throw new Error('set_contextLength: expected number');
      const activeBackendConfigId = str(await settings.get('activeBackendConfigId'));
      const active = activeBackendConfigId ? await backendConfigs.getById(activeBackendConfigId) : null;
      if (!active) throw new Error('set_contextLength: no active backend config');
      const updated = await backendConfigs.update(active.id, { contextLength: num });
      bus.broadcast({ type: 'backendConfig.updated', backendConfig: updated });
    },

    get_backend: async () => {
      checkAbort();
      return str(await settings.get('backendProvider'));
    },

    set_backend: async (provider: string) => {
      checkAbort();
      if (typeof provider !== 'string') throw new Error('set_backend: expected string');
      await settings.setValue('backendProvider', provider);
      bus.broadcast({ type: 'settings.changed', key: 'backendProvider', value: provider });
    },
  };
}
