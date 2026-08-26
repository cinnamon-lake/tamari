import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { ImageLightbox } from './ImageLightbox.js';
import { openLightbox, closeLightbox } from '../stores/lightboxStore.js';

describe('ImageLightbox', () => {
  beforeEach(() => {
    closeLightbox();
  });

  it('does not render when closed', () => {
    render(() => <ImageLightbox />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders image when open', () => {
    openLightbox('http://example.com/img.png');
    render(() => <ImageLightbox />);
    const img = document.querySelector('.lightbox-img') as HTMLImageElement;
    expect(img.src).toBe('http://example.com/img.png');
  });

  it('clicking overlay closes lightbox', () => {
    openLightbox('http://example.com/img.png');
    render(() => <ImageLightbox />);
    const overlay = document.querySelector('.lightbox-overlay');
    overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('dragging off the image and releasing on the overlay does not close', () => {
    // Simulates a selection drag: press on the image, release over the
    // backdrop. The browser fires the click on their common ancestor (the
    // overlay), but a press that started inside must not dismiss.
    openLightbox('http://example.com/img.png');
    render(() => <ImageLightbox />);
    const img = document.querySelector('.lightbox-img') as HTMLImageElement;
    const overlay = () => document.querySelector('.lightbox-overlay');
    expect(overlay()).toBeInTheDocument();
    img.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    img.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    overlay()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(overlay()).toBeInTheDocument();
  });

  it('a full press-and-release on the overlay itself closes (detail 1)', () => {
    openLightbox('http://example.com/img.png');
    render(() => <ImageLightbox />);
    const overlay = document.querySelector('.lightbox-overlay')!;
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(document.querySelector('.lightbox-overlay')).not.toBeInTheDocument();
  });


  it('clicking close button closes lightbox', () => {
    openLightbox('http://example.com/img.png');
    render(() => <ImageLightbox />);
    screen.getByLabelText('Close').click();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('pressing Escape closes lightbox', () => {
    openLightbox('http://example.com/img.png');
    render(() => <ImageLightbox />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('clicking image does not close lightbox', () => {
    openLightbox('http://example.com/img.png');
    render(() => <ImageLightbox />);
    const img = document.querySelector('.lightbox-img') as HTMLImageElement;
    img.click();
    expect(img).toBeInTheDocument();
  });
});
