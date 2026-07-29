import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@solidjs/testing-library';
import { DesignTokenInjector } from './DesignTokenInjector.js';
import { setState } from '../stores/serverStore.js';

describe('DesignTokenInjector', () => {
  let appShell: HTMLDivElement;
  let messagesEl: HTMLDivElement;

  beforeEach(() => {
    appShell = document.createElement('div');
    appShell.className = 'app-shell';
    document.body.appendChild(appShell);

    messagesEl = document.createElement('div');
    messagesEl.className = 'messages';
    document.body.appendChild(messagesEl);

    setState('settings', {});
    document.documentElement.style.fontSize = '';
    document.documentElement.style.removeProperty('--chat-max-width');
    document.documentElement.style.removeProperty('--avatar-border-radius');
    document.documentElement.style.removeProperty('--shadow-opacity');
    document.documentElement.style.removeProperty('--backdrop-blur');
    document.documentElement.classList.remove('reduced-motion');
  });

  afterEach(() => {
    appShell.remove();
    messagesEl.remove();
  });

  it('sets font scale', () => {
    setState('settings', { fontScale: 1.25 });
    render(() => <DesignTokenInjector />);
    expect(document.documentElement.style.fontSize).toBe('125%');
  });

  it('sets chat max width', () => {
    setState('settings', { chatWidth: 60 });
    render(() => <DesignTokenInjector />);
    expect(document.documentElement.style.getPropertyValue('--chat-max-width')).toBe('60rem');
  });

  it('sets avatar border radius to round', () => {
    setState('settings', { avatarStyle: 'round' });
    render(() => <DesignTokenInjector />);
    expect(document.documentElement.style.getPropertyValue('--avatar-border-radius')).toBe('50%');
  });

  it('sets avatar border radius to rectangular', () => {
    setState('settings', { avatarStyle: 'rectangular' });
    render(() => <DesignTokenInjector />);
    expect(document.documentElement.style.getPropertyValue('--avatar-border-radius')).toBe('0');
  });

  it('sets shadow opacity', () => {
    setState('settings', { shadowWidth: 1.5 });
    render(() => <DesignTokenInjector />);
    expect(document.documentElement.style.getPropertyValue('--shadow-opacity')).toBe('1.5');
  });

  it('sets shadow opacity to 0 when noShadows', () => {
    setState('settings', { noShadows: true, shadowWidth: 1 });
    render(() => <DesignTokenInjector />);
    expect(document.documentElement.style.getPropertyValue('--shadow-opacity')).toBe('0');
  });

  it('adds compact-input class', () => {
    setState('settings', { compactInputArea: true });
    render(() => <DesignTokenInjector />);
    expect(appShell.classList.contains('compact-input')).toBe(true);
  });

  it('removes compact-input class', () => {
    appShell.classList.add('compact-input');
    setState('settings', { compactInputArea: false });
    render(() => <DesignTokenInjector />);
    expect(appShell.classList.contains('compact-input')).toBe(false);
  });

  it('sets chat style class on messages', () => {
    setState('settings', { chatStyle: 'bubbles' });
    render(() => <DesignTokenInjector />);
    expect(messagesEl.classList.contains('chat-style-bubbles')).toBe(true);
  });

  it('sets backdrop blur', () => {
    setState('settings', { blurStrength: 2 });
    render(() => <DesignTokenInjector />);
    expect(document.documentElement.style.getPropertyValue('--backdrop-blur')).toBe('2');
  });

  it('adds reduced-motion class', () => {
    setState('settings', { reducedMotion: true });
    render(() => <DesignTokenInjector />);
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);
  });

  it('removes reduced-motion class', () => {
    document.documentElement.classList.add('reduced-motion');
    setState('settings', { reducedMotion: false });
    render(() => <DesignTokenInjector />);
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);
  });
});
