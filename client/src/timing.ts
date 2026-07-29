/**
 * Shared UI timing constants.
 *
 * The e2e suite pre-seeds localStorage for every browser context (Playwright
 * storageState — see e2e/global-setup.ts) with st_fast_timers=1, and waits for
 * the debounced 'Saved' indicator hundreds of times per run; the full
 * human-typing pause is dead time there. Unit tests (jsdom) and real browsers
 * keep the production value.
 */
const fastTimers =
  typeof localStorage !== 'undefined' && localStorage.getItem('st_fast_timers') === '1';

/** Idle delay before an editor field auto-saves. */
export const AUTOSAVE_DEBOUNCE_MS = fastTimers ? 50 : 600;
