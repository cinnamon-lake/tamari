/**
 * Static file serving for avatars and personas — no DB lookup, auth via
 * the shared middleware (?token= query param supported).
 */

import { Router, type RequestHandler } from 'express';
import type express from 'express';
import { basename, normalize } from 'node:path';
import type { FileStorage } from '../services/FileStorage.js';

function serveFileRoute(storage: FileStorage, subDir: string) {
  return (req: express.Request, res: express.Response) => {
    const fileName = Array.isArray(req.params.file) ? req.params.file[0] : req.params.file;
    // Robust path traversal guard: reject parent-dir refs, absolute paths,
    // and any filename that is not a single basename.
    if (
      !fileName ||
      fileName.includes('..') ||
      basename(fileName) !== fileName ||
      normalize(fileName) !== fileName
    ) {
      res.status(400).json({ error: 'Invalid file name' });
      return;
    }
    const filePath = `files/${subDir}/${fileName}`;
    let exists: boolean;
    try {
      exists = storage.exists(filePath);
    } catch {
      res.status(400).json({ error: 'Invalid file name' });
      return;
    }
    if (!exists) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
    };
    res.set('Content-Type', mimeMap[ext] ?? 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    // dotfiles: 'allow' — see attachments route in api/attachments.ts.
    res.sendFile(storage.resolve(filePath), { dotfiles: 'allow' });
  };
}

export function createFilesRouter(storage: FileStorage, requireAuth: RequestHandler): Router {
  const router = Router();

  router.get('/avatars/:file', requireAuth, serveFileRoute(storage, 'avatars'));
  router.get('/avatars/thumbs/:file', requireAuth, serveFileRoute(storage, 'avatars/thumbs'));
  router.get('/personas/:file', requireAuth, serveFileRoute(storage, 'personas'));
  router.get('/personas/thumbs/:file', requireAuth, serveFileRoute(storage, 'personas/thumbs'));

  return router;
}
