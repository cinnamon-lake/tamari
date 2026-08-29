/**
 * st-api domain: variables — per-chat script variables stored under
 * `lua.var.<chatId>.<name>` in the settings repository.
 */

import type { StApiContext } from './context.js';
import type { StApi } from './types.js';

export type VariablesApi = Pick<StApi, 'setvar' | 'getvar' | 'clear_variables' | 'get_variables'>;

export function createVariables(c: StApiContext): VariablesApi {
  const { settings } = c.deps;
  const { chatId, checkAbort } = c;

  function varKey(name: string): string {
    return `lua.var.${chatId}.${name}`;
  }

  return {
    setvar: async (name: string, value: unknown) => {
      checkAbort();
      await settings.setValue(varKey(String(name)), value);
    },

    getvar: async (name: string) => {
      checkAbort();
      return await settings.get(varKey(String(name)));
    },

    clear_variables: async () => {
      checkAbort();
      const all = await settings.list();
      const prefix = `lua.var.${chatId}.`;
      for (const key of Object.keys(all)) {
        if (key.startsWith(prefix)) {
          await settings.delete(key);
        }
      }
    },

    get_variables: async () => {
      checkAbort();
      const all = await settings.list();
      const prefix = `lua.var.${chatId}.`;
      const vars: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(prefix)) {
          vars[key.slice(prefix.length)] = value;
        }
      }
      return vars;
    },
  };
}
