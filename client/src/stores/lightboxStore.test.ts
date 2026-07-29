import { describe, it, expect, beforeEach } from 'vitest';
import { lightboxSrc, openLightbox, closeLightbox } from './lightboxStore.js';

describe('lightboxStore', () => {
  beforeEach(() => {
    closeLightbox();
  });

  it('starts closed', () => {
    expect(lightboxSrc()).toBeNull();
  });

  it('openLightbox sets src', () => {
    openLightbox('http://example.com/img.png');
    expect(lightboxSrc()).toBe('http://example.com/img.png');
  });

  it('closeLightbox clears src', () => {
    openLightbox('http://example.com/img.png');
    closeLightbox();
    expect(lightboxSrc()).toBeNull();
  });

  it('openLightbox overwrites existing src', () => {
    openLightbox('http://example.com/a.png');
    openLightbox('http://example.com/b.png');
    expect(lightboxSrc()).toBe('http://example.com/b.png');
  });
});
