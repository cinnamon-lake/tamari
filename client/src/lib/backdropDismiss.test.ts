import { describe, it, expect, vi } from 'vitest';
import { createBackdropDismiss } from './backdropDismiss.js';

function fakeEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    target: null,
    currentTarget: null,
    detail: 1,
    ...overrides,
  } as unknown as MouseEvent;
}

const backdrop = document.createElement('div');
const dialog = document.createElement('div');

describe('createBackdropDismiss', () => {
  it('dismisses a full click on the backdrop', () => {
    const onDismiss = vi.fn();
    const handlers = createBackdropDismiss(onDismiss);

    handlers.onMouseDown(fakeEvent({ target: backdrop, currentTarget: backdrop }));
    handlers.onClick(fakeEvent({ target: backdrop, currentTarget: backdrop }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss when the press started inside the dialog and released on the backdrop', () => {
    const onDismiss = vi.fn();
    const handlers = createBackdropDismiss(onDismiss);

    handlers.onMouseDown(fakeEvent({ target: dialog, currentTarget: backdrop }));
    handlers.onClick(fakeEvent({ target: backdrop, currentTarget: backdrop }));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not dismiss clicks that bubble from inside the dialog', () => {
    const onDismiss = vi.fn();
    const handlers = createBackdropDismiss(onDismiss);

    handlers.onMouseDown(fakeEvent({ target: dialog, currentTarget: backdrop }));
    // Keyboard activation reports detail === 0; must still be ignored off-backdrop.
    handlers.onClick(fakeEvent({ target: dialog, currentTarget: backdrop, detail: 0 }));
    handlers.onClick(fakeEvent({ target: dialog, currentTarget: backdrop }));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses programmatic .click() on the overlay (detail === 0)', () => {
    const onDismiss = vi.fn();
    const handlers = createBackdropDismiss(onDismiss);
    handlers.onMouseDown(fakeEvent({ target: dialog, currentTarget: backdrop }));

    handlers.onClick(fakeEvent({ target: backdrop, currentTarget: backdrop, detail: 0 }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores stale press state from a drag released outside the overlay', () => {
    const onDismiss = vi.fn();
    const handlers = createBackdropDismiss(onDismiss);

    // Press inside, release past the overlay: click never reaches us,
    // but the state must not leak into later synthetic clicks.
    handlers.onMouseDown(fakeEvent({ target: dialog, currentTarget: backdrop }));
    handlers.onClick(fakeEvent({ target: backdrop, currentTarget: backdrop, detail: 0 }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // A subsequent clean press-and-release still works.
    handlers.onMouseDown(fakeEvent({ target: backdrop, currentTarget: backdrop }));
    handlers.onClick(fakeEvent({ target: backdrop, currentTarget: backdrop }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
