import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@solidjs/testing-library';
import { ThemeInjector } from './ThemeInjector.js';
import { setState } from '../stores/serverStore.js';

describe('ThemeInjector', () => {
  beforeEach(() => {
    setState('settings', { themeCustomCss: '' });
    document.getElementById('user-theme-css')?.remove();
  });

  it('does not inject style when no CSS', () => {
    render(() => <ThemeInjector />);
    expect(document.getElementById('user-theme-css')).not.toBeInTheDocument();
  });

  it('injects style tag with CSS', () => {
    setState('settings', { themeCustomCss: 'body { color: red; }' });
    render(() => <ThemeInjector />);
    const style = document.getElementById('user-theme-css') as HTMLStyleElement;
    expect(style).toBeInTheDocument();
    expect(style.textContent).toBe('body { color: red; }');
  });

  it('updates existing style tag when CSS changes', () => {
    setState('settings', { themeCustomCss: 'body { color: red; }' });
    render(() => <ThemeInjector />);
    setState('settings', { themeCustomCss: 'body { color: blue; }' });
    const style = document.getElementById('user-theme-css') as HTMLStyleElement;
    expect(style.textContent).toBe('body { color: blue; }');
  });

  it('removes style tag when CSS is cleared', () => {
    setState('settings', { themeCustomCss: 'body { color: red; }' });
    render(() => <ThemeInjector />);
    setState('settings', { themeCustomCss: '' });
    expect(document.getElementById('user-theme-css')).not.toBeInTheDocument();
  });
});
