/**
 * `toolset.*` / `toolTemplate.*` messages — CRUD plus Lua template cache
 * invalidation.
 */

import { randomUUID } from 'node:crypto';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildToolHandlers(
  deps: DispatcherDeps,
): Handlers<
  'toolset.create' | 'toolset.update' | 'toolset.delete' | 'toolTemplate.create' | 'toolTemplate.update' | 'toolTemplate.delete'
> {
  const { bus, toolRegistry, toolsets: toolsetRepo, toolTemplates: toolTemplateRepo } = deps;

  return {
    'toolset.create': async (client, msg) => {
      const id = randomUUID();
      const toolset = await toolsetRepo.create(id, msg.data);
      bus.broadcast({ type: 'toolset.created', toolset }, client.id);
      const list = await toolsetRepo.list();
      bus.broadcast({ type: 'toolset.listed', toolsets: list }, client.id);
    },

    'toolset.update': async (client, msg) => {
      const toolset = await toolsetRepo.update(msg.toolsetId, msg.patch);
      bus.broadcast({ type: 'toolset.updated', toolset }, client.id);
      const list = await toolsetRepo.list();
      bus.broadcast({ type: 'toolset.listed', toolsets: list }, client.id);
    },

    'toolset.delete': async (client, msg) => {
      await toolsetRepo.delete(msg.toolsetId);
      bus.broadcast({ type: 'toolset.deleted', toolsetId: msg.toolsetId }, client.id);
      const list = await toolsetRepo.list();
      bus.broadcast({ type: 'toolset.listed', toolsets: list }, client.id);
    },

    'toolTemplate.create': async (client, msg) => {
      const id = randomUUID();
      const toolTemplate = await toolTemplateRepo.create(id, msg.data);
      bus.broadcast({ type: 'toolTemplate.created', toolTemplate }, client.id);
      const list = await toolTemplateRepo.list();
      bus.broadcast({ type: 'toolTemplate.listed', toolTemplates: list }, client.id);
      toolRegistry?.invalidateLuaCache();
    },

    'toolTemplate.update': async (client, msg) => {
      const toolTemplate = await toolTemplateRepo.update(msg.toolTemplateId, msg.patch);
      bus.broadcast({ type: 'toolTemplate.updated', toolTemplate }, client.id);
      const list = await toolTemplateRepo.list();
      bus.broadcast({ type: 'toolTemplate.listed', toolTemplates: list }, client.id);
      toolRegistry?.invalidateLuaCache();
    },

    'toolTemplate.delete': async (client, msg) => {
      await toolTemplateRepo.delete(msg.toolTemplateId);
      bus.broadcast({ type: 'toolTemplate.deleted', toolTemplateId: msg.toolTemplateId }, client.id);
      const list = await toolTemplateRepo.list();
      bus.broadcast({ type: 'toolTemplate.listed', toolTemplates: list }, client.id);
      toolRegistry?.invalidateLuaCache();
    },
  };
}
