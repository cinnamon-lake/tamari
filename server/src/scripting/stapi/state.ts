/**
 * st-api domain: meta state — out-of-fiction extension data (does NOT fork
 * with branches), scoped per chat or global.
 */

import type { StApiContext } from './context.js';
import type { StApi } from './types.js';

export type StateApi = Pick<
  StApi,
  'set_state' | 'get_state' | 'set_global_state' | 'get_global_state' | 'delete_state'
>;

export function createState(c: StApiContext): StateApi {
  const { extensionData } = c.deps;
  const { chatId, checkAbort } = c;

  function validateNamespace(fn: string, namespace: unknown): string {
    if (typeof namespace !== 'string' || namespace.length === 0 || namespace.length > 100) {
      throw new Error(`${fn}: expected non-empty namespace string (max 100 chars)`);
    }
    return namespace;
  }

  return {
    set_state: async (namespace: string, data: unknown) => {
      checkAbort();
      const ns = validateNamespace('set_state', namespace);
      if (data === null || typeof data !== 'object') {
        throw new Error('set_state: expected (namespace, table)');
      }
      await extensionData.set(ns, 'chat', chatId, data as Record<string, unknown>);
    },

    get_state: async (namespace: string) => {
      checkAbort();
      const ns = validateNamespace('get_state', namespace);
      return (await extensionData.get(ns, 'chat', chatId)) ?? null;
    },

    set_global_state: async (namespace: string, data: unknown) => {
      checkAbort();
      const ns = validateNamespace('set_global_state', namespace);
      if (data === null || typeof data !== 'object') {
        throw new Error('set_global_state: expected (namespace, table)');
      }
      await extensionData.set(ns, 'global', '', data as Record<string, unknown>);
    },

    get_global_state: async (namespace: string) => {
      checkAbort();
      const ns = validateNamespace('get_global_state', namespace);
      return (await extensionData.get(ns, 'global', '')) ?? null;
    },

    delete_state: async (namespace: string) => {
      checkAbort();
      const ns = validateNamespace('delete_state', namespace);
      // Deleting state that was never set is a no-op for scripts.
      await extensionData.deleteIfExists(ns, 'chat', chatId);
    },
  };
}
