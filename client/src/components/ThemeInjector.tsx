import { createEffect } from 'solid-js';
import { state } from '../stores/serverStore.js';

const THEME_STYLE_ID = 'user-theme-css';

export function ThemeInjector() {
  createEffect(() => {
    const css = String(state.settings['themeCustomCss'] ?? '');
    let styleEl = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;

    if (!css) {
      if (styleEl) styleEl.remove();
      return;
    }

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = THEME_STYLE_ID;
      document.head.appendChild(styleEl);
    }

    styleEl.textContent = css;
  });

  return null;
}
