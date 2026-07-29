/**
 * `settings.*` messages — set/get plus side effects (RAG reconfigure,
 * greeting rebroadcast on userName change).
 */

import { getRAGConfig } from '../services/ragConfig.js';
import { maybeRebroadcastGreetingSnapshot } from './helpers.js';
import type { DispatcherDeps, Handlers } from './types.js';

/**
 * Structural equality for settings values. Settings persist as a JSON blob,
 * so values are always plain JSON data (no functions, class instances, or
 * cyclic refs) and a recursive plain-data comparison is sufficient.
 */
function settingsValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => settingsValueEqual(v, b[i]))
    );
  }
  const aEntries = Object.entries(a as Record<string, unknown>);
  const bObj = b as Record<string, unknown>;
  return (
    aEntries.length === Object.keys(bObj).length &&
    aEntries.every(([k, v]) => settingsValueEqual(v, bObj[k]))
  );
}

export function buildSettingsHandlers(deps: DispatcherDeps): Handlers<'settings.set' | 'settings.get'> {
  const { bus, chats, settings, chatBroadcast } = deps;

  return {
    'settings.set': async (client, msg) => {
      const current = await settings.get(msg.key);
      if (settingsValueEqual(current, msg.value)) {
        // No-op write: skip the SQLite write AND the change-keyed side
        // effects below — but still echo settings.changed. The echo is the
        // ack contract for settings.set (e2e helpers and external WS clients
        // await it to confirm the value is in effect), not just sync noise.
        bus.broadcast({ type: 'settings.changed', key: msg.key, value: msg.value }, client.id);
        return;
      }
      await settings.setValue(msg.key, msg.value);
      bus.broadcast({ type: 'settings.changed', key: msg.key, value: msg.value }, client.id);
      if (msg.key.startsWith('rag.')) {
        // Runtime RAG reconfigure — the service is built at boot with RAG
        // disabled by default, so `rag.*` edits must reach it live.
        deps.ragService?.configure(getRAGConfig(await settings.list()));
      }
      if (msg.key === 'userName') {
        const chatList = await chats.listChats({ limit: 0 });
        for (const chat of chatList.items) {
          await maybeRebroadcastGreetingSnapshot(chatBroadcast, chat, client.id);
        }
      }
    },

    'settings.get': async (client, _msg) => {
      // NOTE: msg.keys is accepted by the wire schema but the reply always
      // carries the full parsed blob (settings.loaded's type requires it).
      const blob = await settings.getMany();
      // Dedicated reply — a `snapshot` here would wholesale-replace the
      // client's sidebar lists with empty arrays.
      bus.sendTo(client.id, { type: 'settings.loaded', settings: blob });
    },
  };
}
