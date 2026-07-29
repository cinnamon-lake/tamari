/** Allowlist for attachment MIME types — prevents storing XSS vectors (text/html, application/javascript, etc.). */

export function isAllowedAttachmentMime(mime: string): boolean {
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')) return true;
  return [
    'text/plain',
    'text/markdown',
    'application/pdf',
    'application/json',
    'application/octet-stream',
  ].includes(mime);
}
