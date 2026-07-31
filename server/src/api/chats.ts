/**
 * Chat REST API — export (JSONL / plain text) and generation traces.
 */

import { Router } from 'express';
import { z } from 'zod';
import { getMessageText } from '@tamari/types';
import { getLogger } from '../lib/logger.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { IGenerationRepository } from '../repos/GenerationRepository.js';

const log = getLogger('api/chats');

/** Max generation records returned by /:id/generations (newest first). */
const GENERATIONS_LIMIT = 50;

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function createChatsRouter(chats: IChatRepository, generations?: IGenerationRepository): Router {
  const router = Router();

  // Recent generation records for the chat (debug traces — read-only; the
  // client composes layers/chains from `meta`). Newest first, capped.
  router.get('/:id/generations', async (req, res) => {
    try {
      const chatId = z.string().parse(req.params.id);
      if (!generations) {
        res.status(501).json({ error: 'Generation records are not available' });
        return;
      }
      const chat = await chats.getChatById(chatId);
      if (!chat) {
        res.status(404).json({ error: 'Chat not found' });
        return;
      }
      const records = await generations.listByChat(chatId);
      res.json({ items: records.slice(0, GENERATIONS_LIMIT), total: records.length });
    } catch (err) {
      log.error({ err }, 'generations: error');
      res.status(500).json({ error: 'Failed to list generation records' });
    }
  });

  router.get('/:id/export', async (req, res) => {
    try {
      const chatId = z.string().parse(req.params.id);
      const format = typeof req.query.format === 'string' ? req.query.format : 'jsonl';
      const messages = await chats.getActiveBranch(chatId, { limit: 10000 });
      const filename = safeFilename(chatId);

      if (format === 'txt') {
        const lines = messages.map((m) => {
          return `${m.role}: ${getMessageText(m.extra.parts)}`;
        });
        const text = lines.join('\n\n');
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`);
        res.send(text);
        return;
      }

      // Default: JSONL
      const lines = messages.map((m) => JSON.stringify(m));
      res.setHeader('Content-Type', 'application/jsonl');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.jsonl"`);
      res.send(lines.join('\n'));
    } catch (err) {
      log.error({ err }, 'export: error');
      res.status(500).json({ error: 'Failed to export chat' });
    }
  });

  return router;
}
