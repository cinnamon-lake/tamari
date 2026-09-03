/**
 * Attachment REST API — base64 upload + download.
 *
 * Both routers are mounted before the /api auth middleware (inline images in
 * message HTML cannot send headers), so the download route performs its own
 * bearer/query token check — it is a capability gated on the credential, not
 * an open public endpoint. SVG uploads are forced to `attachment` disposition
 * plus a sandboxing CSP: same-origin documents must not be hostable here.
 */

import { Router } from 'express';
import { newId } from '@tamari/wordid';
import { z } from 'zod';
import { isAllowedAttachmentMime } from '../lib/mimeAllowlist.js';
import { apiError } from '../middleware/errorHandler.js';
import type { IAttachmentRepository } from '../repos/AttachmentRepository.js';
import type { FileStorage } from '../services/FileStorage.js';
import type { EventBus } from '../bus/EventBus.js';
import { extractBearerToken } from '../middleware/auth.js';
import type { AuthService } from '../services/AuthService.js';

const AttachmentUploadSchema = z.object({
  mimeType: z
    .string()
    .min(1)
    .max(100)
    .regex(/^\w+\/[\w.+-]+$/),
  data: z.string().min(1).max(15_000_000), // ~10MB binary in base64
  meta: z
    .record(z.string(), z.unknown())
    .optional()
    .refine((val) => !val || Object.keys(val).length <= 50, { message: 'Meta object must have at most 50 keys' }),
});

/** Attachment download — mounted BEFORE the /api auth middleware; checks the
 * token itself so inline <img>/<audio>/<video> tags can pass it via query. */
export function createAttachmentDownloadRouter(
  attachments: IAttachmentRepository,
  storage: FileStorage,
  auth: AuthService,
): Router {
  const router = Router();

  router.get('/:id', async (req, res) => {
    const kind = await auth.classify(req.socket.remoteAddress ?? undefined, extractBearerToken(req));
    if (!kind) {
      throw apiError('UNAUTHORIZED', 'Unauthorized', 401);
    }
    const attachment = await attachments.getById(z.string().parse(req.params.id));
    if (!attachment) {
      throw apiError('NOT_FOUND', 'Not found', 404);
    }
    res.setHeader('Content-Type', attachment.mimeType);
    // Inline-safe = raster media, audio, video. SVG is a same-origin
    // DOCUMENT (scripts run on direct navigation), so even though CSP
    // blocks it inside the app, direct visits get forced-download + a
    // sandboxing policy instead of hosting attacker-supplied markup.
    const isSvg = attachment.mimeType === 'image/svg+xml';
    if (
      isSvg ||
      (!attachment.mimeType.startsWith('image/') &&
        !attachment.mimeType.startsWith('audio/') &&
        !attachment.mimeType.startsWith('video/'))
    ) {
      res.setHeader('Content-Disposition', 'attachment');
    }
    if (isSvg) {
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    }
    // dotfiles: 'allow' — the path is server-constructed and traversal-guarded by
    // FileStorage; send's default dotfile policy would 404 whenever DATA_DIR itself
    // contains a dot segment (e.g. ~/.local/share, server/.test-data).
    res.sendFile(storage.resolve(attachment.filePath), { dotfiles: 'allow' });
  });

  return router;
}

/** Attachment upload (filesystem-backed) — mount after the /api auth middleware. */
export function createAttachmentsRouter(
  attachments: IAttachmentRepository,
  storage: FileStorage,
  bus: EventBus,
): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = AttachmentUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      throw apiError('INVALID_REQUEST', 'Invalid request body', 400, { details: parsed.error.flatten() });
    }
    const { mimeType, data, meta } = parsed.data;
    if (!isAllowedAttachmentMime(mimeType)) {
      throw apiError('UNSUPPORTED_MIME_TYPE', `Unsupported MIME type: ${mimeType}`, 400);
    }
    const id = newId();
    const blob = Buffer.from(data, 'base64');
    const filePath = storage.write('attachments', id, new Uint8Array(blob));
    const attachment = await attachments.create({ id, messageId: null, mimeType, filePath, meta: meta ?? {} });
    bus.broadcast({ type: 'attachment.created', attachment });
    res.json(attachment);
  });

  return router;
}
