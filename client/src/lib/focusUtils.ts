/**
 * Keyboard accessibility utilities — focus trapping, focus restoration, and
 * Enter/Space activation for div-based interactables.
 *
 * Used by modals (focus trap + restore) and clickable divs (role=button +
 * keyboard activation). Replaces v1's MutationObserver-based keyboard.js with
 * component-level fixes.
 */

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab/Shift+Tab within a container (for modals). Call from the
 * container's `onKeyDown` handler.
 */
export function trapFocus(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => el.offsetParent !== null && !el.hasAttribute('disabled'));
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (e.shiftKey) {
    if (document.activeElement === first || !container.contains(document.activeElement)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

/** Save the currently-focused element so it can be restored later. */
let savedFocus: HTMLElement | null = null;

export function saveFocus(): void {
  savedFocus = document.activeElement as HTMLElement | null;
}

/**
 * Restore focus to the element saved by `saveFocus()`.
 *
 * The focus call is deferred to the next animation frame. Modal `close()`
 * routines call this *before* the dialog unmounts; when the background is
 * `inert` (see App.tsx), focusing an inert descendant is a spec no-op, and
 * even without `inert` some browsers refuse to focus an element inside a
 * subtree that is about to be torn down. By rAF, Solid has disposed the
 * dialog and the `inert` observer has cleared, so the trigger is focusable.
 */
export function restoreFocus(): void {
  if (!savedFocus) return;
  const target = savedFocus;
  savedFocus = null;
  requestAnimationFrame(() => target.focus());
}

/**
 * Activate a div-based interactable on Enter or Space (for elements with
 * `role="button"` + `tabindex={0}`). Call from the element's `onKeyDown`.
 */
export function onEnterActivate(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    (e.currentTarget as HTMLElement).click();
  }
}

/**
 * Focus the first focusable element inside a container (for modal autofocus).
 */
export function focusFirst(container: HTMLElement): void {
  const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  if (first) first.focus();
}
