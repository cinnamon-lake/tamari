/**
 * `custombackend.*` messages — CRUD for Lua-driven custom backends
 * (scriptable-layers.md §2). Follows the quickreply.* pattern: rebroadcast
 * the full list after every mutation so all clients converge (AGENTS.md §5).
 */

import { randomUUID } from 'node:crypto';
import type { DispatcherDeps, Handlers } from './types.js';
import { dryRunBackendScript } from '../backends/customBackendDryRun.js';
import { getCharacterBackendScript } from '../backends/customBackendFactory.js';

export function buildCustomBackendHandlers(
  deps: DispatcherDeps,
): Handlers<
  | 'custombackend.list'
  | 'custombackend.get'
  | 'custombackend.create'
  | 'custombackend.update'
  | 'custombackend.delete'
  | 'custombackend.test'
> {
  const { bus, customBackends } = deps;

  const rebroadcastList = async (originatorId: string): Promise<void> => {
    const items = await customBackends.list();
    bus.broadcast({ type: 'custombackend.listed', items }, originatorId);
  };

  return {
    'custombackend.list': async (client, _msg) => {
      const items = await customBackends.list();
      bus.sendTo(client.id, { type: 'custombackend.listed', items });
    },

    'custombackend.get': async (client, msg) => {
      const item = await customBackends.getById(msg.id);
      if (!item) {
        bus.sendTo(client.id, { type: 'error', message: `Custom backend "${msg.id}" not found`, code: 'NOT_FOUND' });
        return;
      }
      bus.sendTo(client.id, { type: 'custombackend.updated', item });
    },

    'custombackend.create': async (client, msg) => {
      const id = randomUUID();
      const item = await customBackends.create(id, msg.data);
      bus.broadcast({ type: 'custombackend.created', item }, client.id);
      await rebroadcastList(client.id);
    },

    'custombackend.update': async (client, msg) => {
      const item = await customBackends.update(msg.id, msg.patch);
      bus.broadcast({ type: 'custombackend.updated', item }, client.id);
      await rebroadcastList(client.id);
    },

    'custombackend.delete': async (client, msg) => {
      await customBackends.delete(msg.id);
      bus.broadcast({ type: 'custombackend.deleted', id: msg.id }, client.id);
      await rebroadcastList(client.id);
    },

    /**
     * Dry-run a custom/contextual backend script against a recording delegate
     * (no live generation). Source resolution: explicit luaSource wins, then a
     * registry script by customBackendId, then a character's stored contextual
     * backend (which also weaves the character's description/firstMes into the
     * sample prompt). Always answered with sendTo — this is a request/response
     * pair, not shared state.
     */
    'custombackend.test': async (client, msg) => {
      const fail = (message: string) => bus.sendTo(client.id, { type: 'error', message, code: 'BAD_REQUEST' });

      let luaSource = msg.luaSource;
      let character;
      if (msg.characterId) {
        character = await deps.characters.getById(msg.characterId);
        if (!character) return fail(`Character "${msg.characterId}" not found`);
      }
      if (luaSource === undefined && msg.customBackendId) {
        const item = await customBackends.getById(msg.customBackendId);
        if (!item) return fail(`Custom backend "${msg.customBackendId}" not found`);
        luaSource = item.luaSource;
      }
      if (luaSource === undefined && character) {
        luaSource = getCharacterBackendScript(character)?.luaSource ?? '';
        if (luaSource.length === 0) {
          return fail('Character has no stored backend logic — pass luaSource to test unsaved source');
        }
      }
      if (luaSource === undefined) {
        return fail('Pass luaSource, customBackendId, or characterId');
      }

      try {
        const outcome = await dryRunBackendScript(deps.luaRuntime, {
          luaSource,
          input: msg.input,
          state: msg.state,
          delegateResponse: msg.delegateResponse,
          character: character
            ? { id: character.id, name: character.name, description: character.description, firstMes: character.firstMes }
            : undefined,
        });
        bus.sendTo(client.id, { type: 'custombackend.testResult', requestId: msg.requestId, outcome });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
