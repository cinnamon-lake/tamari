import { createEffect } from 'solid-js';
import { state } from '../stores/serverStore.js';
import type { AppSettings } from '@tamari/types';
import './DesignTokenInjector.css';

export function DesignTokenInjector() {
  createEffect(() => {
    const root = document.documentElement;
    const appShell = document.querySelector('.app-shell');

    // Font scale
    const fontScale = Number(state.settings['fontScale'] ?? 1);
    if (!Number.isNaN(fontScale) && fontScale > 0) {
      root.style.fontSize = `${fontScale * 100}%`;
    } else {
      root.style.fontSize = '';
    }

    // Chat max width
    const chatWidth = Number(state.settings['chatWidth'] ?? 50);
    if (!Number.isNaN(chatWidth) && chatWidth > 0) {
      root.style.setProperty('--chat-max-width', `${chatWidth}rem`);
    } else {
      root.style.setProperty('--chat-max-width', '');
    }

    // Avatar border radius ('circle' is a legacy value, same shape as 'round')
    const avatarStyle = state.settings['avatarStyle'] ?? 'round';
    const avatarRadiusMap: Record<AppSettings['avatarStyle'], string> = {
      round: '50%',
      circle: '50%',
      rectangular: '0',
      square: '0',
      rounded: 'var(--radius-md)',
    };
    root.style.setProperty('--avatar-border-radius', avatarRadiusMap[avatarStyle]);

    // Shadow intensity
    const noShadows = Boolean(state.settings['noShadows']);
    const shadowWidth = Number(state.settings['shadowWidth'] ?? 1);
    const shadowOpacity = noShadows ? 0 : Math.max(0, Math.min(2, shadowWidth));
    root.style.setProperty('--shadow-opacity', String(shadowOpacity));

    // Compact input area
    const compactInput = Boolean(state.settings['compactInputArea']);
    if (appShell) {
      if (compactInput) {
        appShell.classList.add('compact-input');
      } else {
        appShell.classList.remove('compact-input');
      }
    }

    // Chat display style
    const chatStyle = state.settings['chatStyle'] ?? 'default';
    const messagesEl = document.querySelector('.messages');
    if (messagesEl) {
      messagesEl.classList.remove('chat-style-default', 'chat-style-bubbles', 'chat-style-document');
      messagesEl.classList.add(`chat-style-${chatStyle}`);
    }

    // Backdrop blur strength
    const blurStrength = Number(state.settings['blurStrength'] ?? 1);
    if (!Number.isNaN(blurStrength) && blurStrength >= 0) {
      root.style.setProperty('--backdrop-blur', String(blurStrength));
    } else {
      root.style.setProperty('--backdrop-blur', '');
    }

    // Reduced motion
    const reducedMotion = Boolean(state.settings['reducedMotion']);
    if (reducedMotion) {
      document.documentElement.classList.add('reduced-motion');
    } else {
      document.documentElement.classList.remove('reduced-motion');
    }
  });

  return null;
}
