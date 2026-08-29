/**
 * Data Maid REST API — orphan scan/clean.
 */

import { Router } from 'express';
import { toChatSummary } from '../lib/summaries.js';
import type { DataMaid } from '../services/DataMaid.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { EventBus } from '../bus/EventBus.js';

export function createMaidRouter(dataMaid: DataMaid, chats: IChatRepository, bus: EventBus): Router {
  const router = Router();

  router.get('/scan', async (_req, res) => {
    const report = await dataMaid.scan();
    res.json(report);
  });

  router.post('/clean', async (_req, res) => {
    const report = await dataMaid.scan();
    const result = await dataMaid.clean(report);
    // maid/clean deletes WS-synced rows (chats/messages); rebroadcast the chat list
    // so open clients drop stale deleted chats instead of holding them (AGENTS.md §4).
    const chatList = await chats.listChatSummaries({ limit: 1000 });
    bus.broadcast({ type: 'chat.listed', chats: chatList.items.map(toChatSummary), total: chatList.total });
    res.json({ ok: true, ...result, report });
  });

  return router;
}
