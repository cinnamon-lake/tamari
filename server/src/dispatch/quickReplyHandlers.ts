/**
 * `quickreply.*` messages — scoped CRUD, execution, auto-execute triggers.
 */

import { randomUUID } from 'node:crypto';
import { QuickReplyAutoExecute } from '@tamari/types';
import { broadcastQuickReplyList } from '../services/quickReplyBroadcast.js';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildQuickReplyHandlers(
  deps: DispatcherDeps,
): Handlers<
  | 'quickreply.list'
  | 'quickreply.listForChat'
  | 'quickreply.create'
  | 'quickreply.update'
  | 'quickreply.delete'
  | 'quickreply.execute'
  | 'quickreply.runStartup'
> {
  const { bus, chats, quickReplyService, quickReplies } = deps;

  // Rebroadcast the full table after any mutation so every client's `.listed`-owned
  // list converges (AGENTS.md §5).
  const rebroadcastList = async (originatorId: string): Promise<void> => {
    await broadcastQuickReplyList(bus, quickReplies, originatorId);
  };

  return {
    'quickreply.list': async (client, msg) => {
      const items = await quickReplies.listByScope(msg.scope, msg.scopeId);
      bus.sendTo(client.id, { type: 'quickreply.listed', items });
    },

    'quickreply.listForChat': async (client, msg) => {
      // One merged list per view: the union of chat + character + global replies
      // for the current chat. The client wholesale-replaces state.quickReplies,
      // so multi-scope quick replies render correctly (AGENTS.md §5).
      const chat = await chats.getChatById(msg.chatId);
      const charId = chat?.characterId ?? null;
      const [chatQrs, charQrs, globalQrs] = await Promise.all([
        quickReplies.listByScope('chat', msg.chatId),
        charId ? quickReplies.listByScope('character', charId) : Promise.resolve([]),
        quickReplies.listByScope('global', ''),
      ]);
      bus.sendTo(client.id, {
        type: 'quickreply.listed',
        items: [...chatQrs, ...charQrs, ...globalQrs],
      });
    },

    'quickreply.create': async (client, msg) => {
      const id = randomUUID();
      const item = await quickReplies.create(id, msg.data);
      bus.broadcast({ type: 'quickreply.created', item }, client.id);
      await rebroadcastList(client.id);
    },

    'quickreply.update': async (client, msg) => {
      const item = await quickReplies.update(msg.id, msg.patch);
      bus.broadcast({ type: 'quickreply.updated', item }, client.id);
      // A patch can move a reply between scopes — only a full-list rebroadcast
      // converges every view.
      await rebroadcastList(client.id);
    },

    'quickreply.delete': async (client, msg) => {
      await quickReplies.delete(msg.id);
      bus.broadcast({ type: 'quickreply.deleted', id: msg.id }, client.id);
      await rebroadcastList(client.id);
    },

    'quickreply.execute': async (client, msg) => {
      await quickReplyService.executeById(msg.id, msg.chatId, client.id);
    },

    'quickreply.runStartup': async (client, msg) => {
      await quickReplyService.runAutoExecute(msg.chatId, QuickReplyAutoExecute.STARTUP, client.id);
    },
  };
}
