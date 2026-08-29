import { describe, it, expect, afterEach } from 'vitest';
import {
  isAppModalOpen,
  openAppModal,
  closeAppModal,
  registerModal,
  unregisterModal,
  isTopmostModal,
  modalStack,
  type AppModalId,
} from './modalStore.js';

const ALL_IDS: AppModalId[] = [
  'characterEditor',
  'settings',
  'backendConfigs',
  'secrets',
  'customBackends',
  'promptLists',
  'instructTemplates',
  'regexRules',
  'worldInfo',
  'personas',
  'tools',
  'stats',
];

afterEach(() => {
  // Reset shared store state so tests don't leak into each other (or into
  // component tests running in the same process).
  for (const id of ALL_IDS) closeAppModal(id);
  for (const m of modalStack()) unregisterModal(m.id);
});

describe('modalStore named app modals', () => {
  it('opens and closes a modal by id', () => {
    expect(isAppModalOpen('settings')).toBe(false);
    openAppModal('settings');
    expect(isAppModalOpen('settings')).toBe(true);
    closeAppModal('settings');
    expect(isAppModalOpen('settings')).toBe(false);
  });

  it('tracks multiple modals independently', () => {
    openAppModal('settings');
    openAppModal('stats');
    expect(isAppModalOpen('settings')).toBe(true);
    expect(isAppModalOpen('stats')).toBe(true);
    closeAppModal('settings');
    expect(isAppModalOpen('settings')).toBe(false);
    expect(isAppModalOpen('stats')).toBe(true);
  });

  it('opening the same id twice is a no-op', () => {
    openAppModal('tools');
    openAppModal('tools');
    expect(isAppModalOpen('tools')).toBe(true);
  });

  it('closing an id that is not open is a no-op', () => {
    closeAppModal('secrets');
    expect(isAppModalOpen('secrets')).toBe(false);
  });
});

describe('modalStore instance stack', () => {
  it('last registered instance is topmost', () => {
    const a = registerModal(() => {}, false);
    const b = registerModal(() => {}, false);
    expect(isTopmostModal(a)).toBe(false);
    expect(isTopmostModal(b)).toBe(true);
  });

  it('topmost falls back to the previous instance after unregister', () => {
    const a = registerModal(() => {}, false);
    const b = registerModal(() => {}, false);
    unregisterModal(b);
    expect(isTopmostModal(a)).toBe(true);
    unregisterModal(a);
    expect(modalStack()).toHaveLength(0);
  });

  it('isTopmostModal is false for unknown ids and an empty stack', () => {
    expect(isTopmostModal(999)).toBe(false);
    const a = registerModal(() => {}, true);
    expect(isTopmostModal(999)).toBe(false);
    unregisterModal(a);
  });

  it('records insideMain per instance for the inert sync', () => {
    const a = registerModal(() => {}, true);
    const b = registerModal(() => {}, false);
    expect(modalStack().find((m) => m.id === a)?.insideMain).toBe(true);
    expect(modalStack().find((m) => m.id === b)?.insideMain).toBe(false);
  });
});
