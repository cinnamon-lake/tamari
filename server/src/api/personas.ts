/**
 * Persona REST API — avatar upload.
 *
 * The avatar pipeline itself lives in services/personaAvatar.ts (shared with
 * any future persona-avatar producers); this router only handles HTTP
 * concerns: lookup, multer, MIME validation.
 */

import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { getLogger } from '../lib/logger.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { FileStorage } from '../services/FileStorage.js';
import type { EventBus } from '../bus/EventBus.js';
import { setPersonaAvatarFromBuffer } from '../services/personaAvatar.js';

const log = getLogger('api/personas');

const AVATAR_MIME_ALLOWLIST = new Set(['image/png', 'image/jpeg', 'image/webp']);

function validateAvatarMime(file: Express.Multer.File | undefined): string | null {
  if (!file) return 'No file uploaded';
  if (!AVATAR_MIME_ALLOWLIST.has(file.mimetype)) {
    return `Unsupported file type: ${file.mimetype}. Allowed: ${[...AVATAR_MIME_ALLOWLIST].join(', ')}`;
  }
  return null;
}

export function createPersonasRouter(
  personas: IPersonaRepository,
  storage: FileStorage,
  bus: EventBus,
  avatarMaxFileSizeBytes: number,
): Router {
  const router = Router();
  const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: avatarMaxFileSizeBytes } });

  router.post('/:id/avatar', avatarUpload.single('avatar'), async (req, res) => {
    try {
      const persona = await personas.getById(z.string().parse(req.params.id));
      if (!persona) {
        res.status(404).json({ error: 'Persona not found' });
        return;
      }
      const mimeError = validateAvatarMime(req.file);
      if (mimeError) {
        res.status(400).json({ error: mimeError });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }
      await setPersonaAvatarFromBuffer({ personas, storage, bus }, persona, req.file.buffer);
      res.json({ success: true });
    } catch (err) {
      log.error({ err }, 'api/personas: avatar upload error');
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  return router;
}
