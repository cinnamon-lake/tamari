import { describe, it, expect, beforeEach } from 'vitest';
import { popups, showPopup, resolvePopup, dismissPopup, confirmPopup, alertPopup, promptPopup } from './popupStore.js';

describe('popupStore', () => {
  beforeEach(() => {
    // Clear any leftover popups
    while (popups.length > 0) {
      dismissPopup(popups[0]!.id);
    }
  });

  it('starts empty', () => {
    expect(popups).toHaveLength(0);
  });

  it('showPopup adds a popup', () => {
    showPopup({ type: 'alert', message: 'hi' });
    expect(popups).toHaveLength(1);
    expect(popups[0]!.config.message).toBe('hi');
  });

  it('resolvePopup removes popup and resolves promise', async () => {
    const promise = showPopup({ type: 'confirm', message: 'sure?' });
    const id = popups[0]!.id;
    resolvePopup(id, true);
    expect(popups).toHaveLength(0);
    await expect(promise).resolves.toBe(true);
  });

  it('dismissPopup removes popup and resolves with undefined', async () => {
    const promise = showPopup({ type: 'alert', message: 'hi' });
    const id = popups[0]!.id;
    dismissPopup(id);
    expect(popups).toHaveLength(0);
    await expect(promise).resolves.toBeUndefined();
  });

  it('multiple popups stack', () => {
    showPopup({ type: 'alert', message: 'first' });
    showPopup({ type: 'alert', message: 'second' });
    expect(popups).toHaveLength(2);
    expect(popups[0]!.config.message).toBe('first');
    expect(popups[1]!.config.message).toBe('second');
  });

  it('popups have sequential IDs', () => {
    showPopup({ type: 'alert', message: 'first' });
    showPopup({ type: 'alert', message: 'second' });
    expect(popups[1]!.id).toBeGreaterThan(popups[0]!.id);
  });

  it('confirmPopup returns Promise<boolean>', async () => {
    const promise = confirmPopup('Delete?');
    expect(popups).toHaveLength(1);
    expect(popups[0]!.config.type).toBe('confirm');
    resolvePopup(popups[0]!.id, true);
    await expect(promise).resolves.toBe(true);
  });

  it('alertPopup returns Promise<void>', async () => {
    const promise = alertPopup('Done');
    expect(popups).toHaveLength(1);
    expect(popups[0]!.config.type).toBe('alert');
    resolvePopup(popups[0]!.id, undefined);
    await expect(promise).resolves.toBeUndefined();
  });

  it('promptPopup returns Promise<string | null>', async () => {
    const promise = promptPopup('Name?', 'default');
    expect(popups).toHaveLength(1);
    expect(popups[0]!.config.type).toBe('prompt');
    expect(popups[0]!.config.defaultValue).toBe('default');
    resolvePopup(popups[0]!.id, 'Alice');
    await expect(promise).resolves.toBe('Alice');
  });

  it('resolving non-existent popup is a no-op', () => {
    resolvePopup(99999, true);
    expect(popups).toHaveLength(0);
  });
});
