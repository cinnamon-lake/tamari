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
import { apiError } from '../middleware/errorHandler.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { FileStorage } from '../services/FileStorage.js';
import type { EventBus } from '../bus/EventBus.js';
import { setPersonaAvatarFromBuffer } from '../services/personaAvatar.js';

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
    const persona = await personas.getById(z.string().parse(req.params.id));
    if (!persona) {
      throw apiError('NOT_FOUND', 'Persona not found', 404);
    }
    const mimeError = validateAvatarMime(req.file);
    if (mimeError) {
      throw apiError('INVALID_AVATAR', mimeError, 400);
    }
    if (!req.file) {
      throw apiError('NO_FILE', 'No file uploaded', 400);
    }
    await setPersonaAvatarFromBuffer({ personas, storage, bus }, persona, req.file.buffer);
    res.json({ success: true });
  });

  return router;
}
