import { describe, it, expect } from 'vitest';
import { isAllowedAttachmentMime } from './mimeAllowlist.js';

describe('isAllowedAttachmentMime', () => {
  it('allows images, audio, video by prefix', () => {
    expect(isAllowedAttachmentMime('image/png')).toBe(true);
    expect(isAllowedAttachmentMime('image/svg+xml')).toBe(true);
    expect(isAllowedAttachmentMime('audio/mpeg')).toBe(true);
    expect(isAllowedAttachmentMime('audio/wav')).toBe(true);
    expect(isAllowedAttachmentMime('video/mp4')).toBe(true);
  });

  it('allows text/plain, markdown, pdf, json, octet-stream', () => {
    expect(isAllowedAttachmentMime('text/plain')).toBe(true);
    expect(isAllowedAttachmentMime('text/markdown')).toBe(true);
    expect(isAllowedAttachmentMime('application/pdf')).toBe(true);
    expect(isAllowedAttachmentMime('application/json')).toBe(true);
    expect(isAllowedAttachmentMime('application/octet-stream')).toBe(true);
  });

  it('rejects html, javascript, and other dangerous types', () => {
    expect(isAllowedAttachmentMime('text/html')).toBe(false);
    expect(isAllowedAttachmentMime('application/javascript')).toBe(false);
    expect(isAllowedAttachmentMime('application/xhtml+xml')).toBe(false);
    expect(isAllowedAttachmentMime('application/x-httpd-php')).toBe(false);
    expect(isAllowedAttachmentMime('text/xml')).toBe(false);
  });
});
