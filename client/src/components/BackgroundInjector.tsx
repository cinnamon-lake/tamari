import { createEffect } from 'solid-js';
import { state } from '../stores/serverStore.js';

export function BackgroundInjector() {
  createEffect(() => {
    const url = String(state.settings['backgroundImageUrl'] ?? '');
    const blur = Number(state.settings['backgroundBlur'] ?? 0);

    const el = document.querySelector<HTMLElement>('.app-shell');
    if (!el) return;

    if (url) {
      el.style.backgroundImage = `url(${url})`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.style.backgroundRepeat = 'no-repeat';
    } else {
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      el.style.backgroundRepeat = '';
    }

    if (blur > 0) {
      el.style.backdropFilter = `blur(${blur}px)`;
    } else {
      el.style.backdropFilter = '';
    }
  });

  return null;
}
