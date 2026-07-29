import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@solidjs/testing-library';
import { BackgroundInjector } from './BackgroundInjector.js';
import { setState } from '../stores/serverStore.js';

describe('BackgroundInjector', () => {
  let appShell: HTMLDivElement;

  beforeEach(() => {
    appShell = document.createElement('div');
    appShell.className = 'app-shell';
    document.body.appendChild(appShell);
    setState('settings', { backgroundImageUrl: '', backgroundBlur: 0 });
  });

  afterEach(() => {
    appShell.remove();
  });

  it('does nothing when no background URL', () => {
    render(() => <BackgroundInjector />);
    expect(appShell.style.backgroundImage).toBe('');
  });

  it('sets background image and styles', () => {
    setState('settings', { backgroundImageUrl: 'http://example.com/bg.jpg' });
    render(() => <BackgroundInjector />);
    expect(appShell.style.backgroundImage).toContain('http://example.com/bg.jpg');
    expect(appShell.style.backgroundSize).toBe('cover');
    expect(appShell.style.backgroundPosition).toBe('center center');
    expect(appShell.style.backgroundRepeat).toBe('no-repeat');
  });

  it('clears background when URL removed', () => {
    setState('settings', { backgroundImageUrl: 'http://example.com/bg.jpg' });
    render(() => <BackgroundInjector />);
    setState('settings', { backgroundImageUrl: '' });
    expect(appShell.style.backgroundImage).toBe('');
  });

  it('applies blur when set', () => {
    setState('settings', { backgroundImageUrl: 'http://example.com/bg.jpg', backgroundBlur: 5 });
    render(() => <BackgroundInjector />);
    expect(appShell.style.backdropFilter).toBe('blur(5px)');
  });

  it('removes blur when set to 0', () => {
    setState('settings', { backgroundImageUrl: 'http://example.com/bg.jpg', backgroundBlur: 5 });
    render(() => <BackgroundInjector />);
    setState('settings', { backgroundBlur: 0 });
    expect(appShell.style.backdropFilter).toBe('');
  });
});
