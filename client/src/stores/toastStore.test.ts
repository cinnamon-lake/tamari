import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { toasts, addToast, removeToast } from './toastStore.js';

describe('toastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clear any leftover toasts
    while (toasts.length > 0) {
      removeToast(toasts[0]!.id);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts empty', () => {
    expect(toasts).toHaveLength(0);
  });

  it('addToast adds a toast', () => {
    addToast('hello', 'info');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe('hello');
    expect(toasts[0]!.type).toBe('info');
  });

  it('addToast assigns unique IDs', () => {
    addToast('first', 'info');
    addToast('second', 'info');
    expect(toasts[0]!.id).not.toBe(toasts[1]!.id);
  });

  it('removeToast removes by ID', () => {
    addToast('hello', 'info');
    const id = toasts[0]!.id;
    removeToast(id);
    expect(toasts).toHaveLength(0);
  });

  it('info toast auto-dismisses after 5s', () => {
    addToast('hello', 'info');
    expect(toasts).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(toasts).toHaveLength(0);
  });

  it('success toast auto-dismisses after 5s', () => {
    addToast('done', 'success');
    expect(toasts).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(toasts).toHaveLength(0);
  });

  it('error toast stays until dismissed manually', () => {
    addToast('fail', 'error');
    expect(toasts).toHaveLength(1);
    vi.advanceTimersByTime(60000);
    expect(toasts).toHaveLength(1);
    removeToast(toasts[0]!.id);
    expect(toasts).toHaveLength(0);
  });

  it('warning toast auto-dismisses after 6s', () => {
    addToast('caution', 'warning');
    expect(toasts[0]!.type).toBe('warning');
    expect(toasts).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(toasts).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(toasts).toHaveLength(0);
  });

  it('multiple toasts dismiss independently', () => {
    addToast('first', 'info');
    addToast('second', 'info');
    expect(toasts).toHaveLength(2);
    vi.advanceTimersByTime(5000);
    expect(toasts).toHaveLength(0);
  });

  it('manually removing toast prevents auto-dismiss crash', () => {
    addToast('hello', 'info');
    const id = toasts[0]!.id;
    removeToast(id);
    vi.advanceTimersByTime(5000);
    expect(toasts).toHaveLength(0);
  });
});
