import { describe, it, expect, beforeEach } from 'vitest';
import { trapFocus, saveFocus, restoreFocus, onEnterActivate } from './focusUtils.js';

// jsdom has no layout engine: offsetParent is always null, which trapFocus's
// visibility filter relies on. Stub it as visible for test elements.
function visible<T extends HTMLElement>(el: T): T {
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  return el;
}

function makeContainer(): { container: HTMLElement; first: HTMLButtonElement; last: HTMLButtonElement } {
  const container = document.createElement('div');
  const first = visible(document.createElement('button'));
  const middle = visible(document.createElement('input'));
  const last = visible(document.createElement('button'));
  container.append(first, middle, last);
  document.body.appendChild(container);
  return { container, first, last };
}

function tabEvent(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
}

describe('trapFocus', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('ignores non-Tab keys', () => {
    const { container } = makeContainer();
    const e = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    trapFocus(container, e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('wraps Tab from the last focusable element to the first', () => {
    const { container, first, last } = makeContainer();
    last.focus();
    const e = tabEvent();
    trapFocus(container, e);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('wraps Shift+Tab from the first focusable element to the last', () => {
    const { container, first, last } = makeContainer();
    first.focus();
    const e = tabEvent(true);
    trapFocus(container, e);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('does not wrap when focus is on a middle element', () => {
    const { container } = makeContainer();
    const middle = container.querySelector('input')!;
    middle.focus();
    const e = tabEvent();
    trapFocus(container, e);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(middle);
  });

  it('Shift+Tab with focus outside the container moves focus to the last element', () => {
    const { container, last } = makeContainer();
    document.body.focus();
    const e = tabEvent(true);
    trapFocus(container, e);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('skips disabled and hidden elements', () => {
    const container = document.createElement('div');
    const hidden = visible(document.createElement('button'));
    Object.defineProperty(hidden, 'offsetParent', { value: null, configurable: true });
    const disabled = visible(document.createElement('button'));
    disabled.disabled = true;
    const only = visible(document.createElement('button'));
    container.append(hidden, disabled, only);
    document.body.appendChild(container);

    only.focus();
    const e = tabEvent();
    trapFocus(container, e);
    // only is both first and last → Tab wraps back onto itself
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(only);
  });

  it('does nothing when the container has no focusable elements', () => {
    const container = document.createElement('div');
    container.appendChild(document.createElement('span'));
    document.body.appendChild(container);
    const e = tabEvent();
    trapFocus(container, e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('saveFocus / restoreFocus', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('restores focus to the saved element on the next animation frame', async () => {
    const trigger = document.createElement('button');
    const other = document.createElement('button');
    document.body.append(trigger, other);
    trigger.focus();

    saveFocus();
    other.focus();
    expect(document.activeElement).not.toBe(trigger);

    restoreFocus();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(trigger);
  });

  it('is a no-op when nothing was saved', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    el.focus();
    restoreFocus();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(el);
  });

  it('restores only once — the saved element is cleared after restore', async () => {
    const trigger = document.createElement('button');
    const other = document.createElement('button');
    document.body.append(trigger, other);
    trigger.focus();

    saveFocus();
    other.focus();
    restoreFocus();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(trigger);

    other.focus();
    restoreFocus();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).not.toBe(trigger);
  });
});

describe('onEnterActivate', () => {
  function clickEvent(key: string, target: HTMLElement): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, cancelable: true });
    Object.defineProperty(e, 'currentTarget', { value: target, configurable: true });
    return e;
  }

  it.each(['Enter', ' '])('clicks the current target on %s', (key) => {
    const el = document.createElement('div');
    let clicks = 0;
    el.addEventListener('click', () => clicks++);
    const e = clickEvent(key, el);
    onEnterActivate(e);
    expect(e.defaultPrevented).toBe(true);
    expect(clicks).toBe(1);
  });

  it('ignores other keys', () => {
    const el = document.createElement('div');
    let clicks = 0;
    el.addEventListener('click', () => clicks++);
    const e = clickEvent('a', el);
    onEnterActivate(e);
    expect(e.defaultPrevented).toBe(false);
    expect(clicks).toBe(0);
  });
});
