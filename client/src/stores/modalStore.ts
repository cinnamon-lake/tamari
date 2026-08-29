import { createSignal } from 'solid-js';

/**
 * Central modal state — two concerns:
 *
 * 1. Named app modals (the Sidebar's settings/editor dialogs) are opened and
 *    closed by id through `openAppModal`/`closeAppModal` instead of a loose
 *    boolean signal per modal in Sidebar.
 * 2. A stack of *mounted* modal instances (`registerModal`/`unregisterModal`,
 *    used by the Modal shell and PopupContainer) drives topmost-Escape
 *    ordering (`isTopmostModal`) and the background `inert` sync in App.tsx.
 */

/** Ids for the named modals hosted by the Sidebar. */
export type AppModalId =
  | 'characterEditor'
  | 'settings'
  | 'backendConfigs'
  | 'secrets'
  | 'customBackends'
  | 'promptLists'
  | 'instructTemplates'
  | 'regexRules'
  | 'worldInfo'
  | 'personas'
  | 'tools'
  | 'stats';

const [openAppModals, setOpenAppModals] = createSignal<ReadonlySet<AppModalId>>(new Set());

export function isAppModalOpen(id: AppModalId): boolean {
  return openAppModals().has(id);
}

export function openAppModal(id: AppModalId): void {
  setOpenAppModals((prev) => {
    if (prev.has(id)) return prev;
    const next = new Set(prev);
    next.add(id);
    return next;
  });
}

export function closeAppModal(id: AppModalId): void {
  setOpenAppModals((prev) => {
    if (!prev.has(id)) return prev;
    const next = new Set(prev);
    next.delete(id);
    return next;
  });
}

// --- Mounted modal instance stack -------------------------------------------

export interface ModalInstance {
  id: number;
  /** Dismiss callback (backdrop/Escape semantics — may be "cancel"). */
  dismiss: () => void;
  /**
   * Whether the dialog's DOM lives inside #main-panel. `main` must NOT be
   * inerted while such a dialog is open (that would inert the dialog itself).
   */
  insideMain: boolean;
}

const [modalStack, setModalStack] = createSignal<readonly ModalInstance[]>([]);
let nextModalInstanceId = 1;

export { modalStack };

/** Push a mounted modal onto the stack; returns its instance id. */
export function registerModal(dismiss: () => void, insideMain: boolean): number {
  const id = nextModalInstanceId++;
  setModalStack((prev) => [...prev, { id, dismiss, insideMain }]);
  return id;
}

export function unregisterModal(id: number): void {
  setModalStack((prev) => prev.filter((m) => m.id !== id));
}

/**
 * Whether the given instance is the topmost (most recently mounted) modal.
 * Read non-reactively from event handlers — only the topmost modal acts on
 * global Escape.
 */
export function isTopmostModal(id: number): boolean {
  const stack = modalStack();
  return stack.length > 0 && stack[stack.length - 1]!.id === id;
}
