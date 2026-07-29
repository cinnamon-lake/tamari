import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data-v2');

function mimeFromPath(path: string): string | undefined {
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.mp3')) return 'audio/mp3';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.ogg')) return 'audio/ogg';
  if (path.endsWith('.m4a')) return 'audio/m4a';
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.mov')) return 'video/quicktime';
  return undefined;
}

/**
 * Resolve a local `/api/attachments/{id}` URL to a base64 data URL.
 * Non-local URLs are returned unchanged.
 */
export function resolveLocalAttachmentUrl(source: string, mimeType?: string): string {
  if (!source.startsWith('/api/attachments/')) {
    return source;
  }
  const id = source.slice('/api/attachments/'.length);
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
    return source;
  }

  // Try the modern extensionless path first, then legacy extension paths
  const candidates = [
    `files/attachments/${id}`,
    `files/attachments/${id}.png`,
    `files/attachments/${id}.jpg`,
    `files/attachments/${id}.jpeg`,
    `files/attachments/${id}.gif`,
    `files/attachments/${id}.webp`,
    `files/attachments/${id}.mp3`,
    `files/attachments/${id}.wav`,
    `files/attachments/${id}.ogg`,
    `files/attachments/${id}.m4a`,
    `files/attachments/${id}.mp4`,
    `files/attachments/${id}.webm`,
    `files/attachments/${id}.mov`,
  ];

  for (const relPath of candidates) {
    try {
      const buf = readFileSync(join(DATA_DIR, relPath));
      const mime = mimeType ?? mimeFromPath(relPath) ?? 'application/octet-stream';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      // try next candidate
    }
  }

  return source;
}
