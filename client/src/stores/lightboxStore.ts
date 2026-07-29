import { createSignal } from 'solid-js';

const [lightboxSrc, setLightboxSrc] = createSignal<string | null>(null);

export function openLightbox(src: string): void {
  setLightboxSrc(src);
}

export function closeLightbox(): void {
  setLightboxSrc(null);
}

export { lightboxSrc };
