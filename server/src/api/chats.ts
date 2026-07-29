/**
 * Chat REST API — export (JSONL / plain text).
 */

import { Router } from 'express';
import { z } from 'zod';
import { getMessageText } from '@tamari/types';
import { getLogger } from '../lib/logger.js';
import type { IChatRepository } from '../repos/ChatRepository.js';

const log = getLogger('api/chats');

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function createChatsRouter(chats: IChatRepository): Router {
  const router = Router();

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
