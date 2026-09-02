/**
 * `transformerchain.*` / `transformerscript.*` messages — CRUD for request
 * transformer chains and the Lua scripts they reference, plus a save-free
 * Lua load-check (`transformerscript.validate`). Follows the custombackend.*
 * pattern: rebroadcast the full list after every mutation so all clients
 * converge (AGENTS.md §5). `save` is an upsert — the presence of `id`
 * decides update vs create (the id is assigned server-side on create).
 */

import { randomUUID } from 'node:crypto';
import type { DispatcherDeps, Handlers } from './types.js';
import { validateTransformerLuaSource } from '../transformers/luaRunner.js';

export function buildTransformerHandlers(
  deps: DispatcherDeps,
): Handlers<
  | 'transformerchain.list'
  | 'transformerchain.get'
  | 'transformerchain.save'
  | 'transformerchain.delete'
  | 'transformerscript.list'
  | 'transformerscript.get'
  | 'transformerscript.save'
  | 'transformerscript.delete'
  | 'transformerscript.validate'
> {
  const { bus, transformerChains, transformerScripts, luaRuntime } = deps;

  const rebroadcastChains = async (originatorId: string): Promise<void> => {
    const items = await transformerChains.list();
    bus.broadcast({ type: 'transformerchain.listed', items }, originatorId);
  };

  const rebroadcastScripts = async (originatorId: string): Promise<void> => {
    const items = await transformerScripts.list();
    bus.broadcast({ type: 'transformerscript.listed', items }, originatorId);
  };

  return {
    'transformerchain.list': async (client, _msg) => {
      const items = await transformerChains.list();
      bus.sendTo(client.id, { type: 'transformerchain.listed', items });
    },

    'transformerchain.get': async (client, msg) => {
      const item = await transformerChains.getById(msg.id);
      if (!item) {
        bus.sendTo(client.id, {
          type: 'error',
          message: `Transformer chain "${msg.id}" not found`,
          code: 'NOT_FOUND',
        });
        return;
      }
      bus.sendTo(client.id, { type: 'transformerchain.snapshot', item });
    },

    'transformerchain.save': async (client, msg) => {
      if (msg.id !== undefined) {
        const item = await transformerChains.update(msg.id, msg.data);
        bus.broadcast({ type: 'transformerchain.updated', item }, client.id);
      } else {
        const item = await transformerChains.create(randomUUID(), msg.data);
        bus.broadcast({ type: 'transformerchain.created', item }, client.id);
      }
      await rebroadcastChains(client.id);
    },

    'transformerchain.delete': async (client, msg) => {
      await transformerChains.delete(msg.id);
      bus.broadcast({ type: 'transformerchain.deleted', id: msg.id }, client.id);
      await rebroadcastChains(client.id);
    },

    'transformerscript.list': async (client, _msg) => {
      const items = await transformerScripts.list();
      bus.sendTo(client.id, { type: 'transformerscript.listed', items });
    },

    'transformerscript.get': async (client, msg) => {
      const item = await transformerScripts.getById(msg.id);
      if (!item) {
        bus.sendTo(client.id, {
          type: 'error',
          message: `Transformer script "${msg.id}" not found`,
          code: 'NOT_FOUND',
        });
        return;
      }
      bus.sendTo(client.id, { type: 'transformerscript.snapshot', item });
    },

    'transformerscript.save': async (client, msg) => {
      if (msg.id !== undefined) {
        const item = await transformerScripts.update(msg.id, msg.data);
        bus.broadcast({ type: 'transformerscript.updated', item }, client.id);
      } else {
        const item = await transformerScripts.create(randomUUID(), msg.data);
        bus.broadcast({ type: 'transformerscript.created', item }, client.id);
      }
      await rebroadcastScripts(client.id);
    },

    'transformerscript.delete': async (client, msg) => {
      await transformerScripts.delete(msg.id);
      bus.broadcast({ type: 'transformerscript.deleted', id: msg.id }, client.id);
      await rebroadcastScripts(client.id);
    },

    /**
     * Load-check Lua transformer source without saving. Always answered with
     * sendTo — this is a request/response pair, not shared state.
     */
    'transformerscript.validate': async (client, msg) => {
      const error = await validateTransformerLuaSource(luaRuntime, msg.luaSource);
      bus.sendTo(client.id, {
        type: 'transformerscript.validated',
        requestId: msg.requestId,
        ok: error === null,
        error: error ?? undefined,
      });
    },
  };
}
