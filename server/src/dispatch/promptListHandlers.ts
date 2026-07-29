/**
 * `promptList.*` messages — selection and CRUD with fallback broadcast.
 */

import { randomUUID } from 'node:crypto';
import { toPromptListSummary } from '../lib/summaries.js';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildPromptListHandlers(
  deps: DispatcherDeps,
): Handlers<'promptList.select' | 'promptList.list' | 'promptList.create' | 'promptList.update' | 'promptList.delete'> {
  const { bus, promptLists, promptListService } = deps;

  return {
    'promptList.select': async (client, msg) => {
      const promptList = await promptLists.getById(msg.promptListId);
      if (!promptList) {
        bus.sendTo(client.id, { type: 'error', message: 'Prompt list not found', code: 'NOT_FOUND' });
        return;
      }
      bus.broadcast({ type: 'promptList.snapshot', promptList }, client.id);
    },

    'promptList.list': async (client, _msg) => {
      const list = await promptLists.listSummaries();
      bus.sendTo(client.id, { type: 'promptList.listed', promptLists: list.map(toPromptListSummary) });
    },

    'promptList.create': async (client, msg) => {
      const id = randomUUID();
      const promptList = await promptLists.create(id, msg.data);
      bus.broadcast({ type: 'promptList.created', promptList }, client.id);
      bus.broadcast({ type: 'promptList.snapshot', promptList }, client.id);
      const list = await promptLists.listSummaries();
      bus.broadcast({ type: 'promptList.listed', promptLists: list.map(toPromptListSummary) }, client.id);
    },

    'promptList.update': async (client, msg) => {
      const promptList = await promptLists.update(msg.promptListId, msg.patch);
      bus.broadcast({ type: 'promptList.updated', promptList }, client.id);
      bus.broadcast({ type: 'promptList.snapshot', promptList }, client.id);
      const list = await promptLists.listSummaries();
      bus.broadcast({ type: 'promptList.listed', promptLists: list.map(toPromptListSummary) }, client.id);
    },

    'promptList.delete': async (client, msg) => {
      const result = await promptListService.deletePromptList(msg.promptListId);
      if (!result.success) {
        bus.sendTo(client.id, {
          type: 'error',
          message: result.error.message,
          code: result.error.code,
        });
        return;
      }
      if (result.fallbackPromptListId) {
        bus.broadcast(
          { type: 'settings.changed', key: 'activePromptListId', value: result.fallbackPromptListId },
          client.id,
        );
      }
      bus.broadcast({ type: 'promptList.deleted', promptListId: msg.promptListId }, client.id);
      const list = await promptLists.listSummaries();
      bus.broadcast({ type: 'promptList.listed', promptLists: list.map(toPromptListSummary) }, client.id);
    },
  };
}
