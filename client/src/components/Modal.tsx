import { onMount, onCleanup, Show, splitProps, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import { createBackdropDismiss } from '../lib/backdropDismiss.js';
import { registerModal, unregisterModal, isTopmostModal } from '../stores/modalStore.js';
import { useI18n } from '../i18n/index.js';

/**
 * Shared modal shell — owns the scaffold every modal used to re-implement:
 * overlay + dialog DOM (same CSS classes as before), focus save/restore, focus
 * trapping, backdrop dismiss, and topmost-only Escape handling via the modal
 * registry (stores/modalStore.ts).
 *
 * Focus is saved at creation (before autofocus inside the dialog can steal it)
 * and restored on cleanup, so every unmount path — backdrop click, Escape,
 * footer buttons calling `onClose`, or the parent removing the dialog —
 * restores focus exactly once.
 *
 * Extra attributes (e.g. `data-form-loaded`) are spread onto the dialog div.
 */
export type ModalProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, 'title' | 'onClose'> & {
  /** Title content (may include icons/indicators); rendered as the heading. */
  title: JSX.Element;
  /** Dismiss callback — used for backdrop clicks, Escape, and the header close button. */
  onClose: () => void;
  children: JSX.Element;
  /** Class list for the dialog element (default "modal"). */
  class?: string;
  /** Class for the overlay element (default "modal-overlay"). */
  overlayClass?: string;
  /** Class for the title heading (default "modal-title"). */
  titleClass?: string;
  /** Heading level for the title (default "h2"). */
  titleAs?: 'h2' | 'h3';
  /** When set, the title gets this id and the dialog is labelled by it. */
  titleId?: string;
  /** aria-label for the dialog (ignored when titleId is set). */
  ariaLabel?: string;
  /** Wrap the title in a header row with a close icon button. */
  showCloseButton?: boolean;
  /** Class for the header row wrapper (default "modal-header-row"). */
  headerClass?: string;
  /** Extra content in the header row, between the title and the close button. */
  headerExtras?: JSX.Element;
};

export function Modal(allProps: ModalProps) {
  const [props, rest] = splitProps(allProps, [
    'title',
    'onClose',
    'children',
    'class',
    'overlayClass',
    'titleClass',
    'titleAs',
    'titleId',
    'ariaLabel',
    'showCloseButton',
    'headerClass',
    'headerExtras',
  ]);
  const { t } = useI18n();

  saveFocus();

  const close = () => props.onClose();

  let overlayRef: HTMLDivElement | undefined;
  let instanceId = -1;

  // Global Escape closes the topmost registered modal only; stacked modals
  // beneath it stay open. Popups/context menus stop propagation before this.
  const onGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (!isTopmostModal(instanceId)) return;
    close();
  };

  onMount(() => {
    const main = document.getElementById('main-panel');
    const insideMain = !!main && !!overlayRef && main.contains(overlayRef);
    instanceId = registerModal(close, insideMain);
    document.addEventListener('keydown', onGlobalKeyDown);
  });

  onCleanup(() => {
    unregisterModal(instanceId);
    document.removeEventListener('keydown', onGlobalKeyDown);
    restoreFocus();
  });

  const titleEl = () => (
    <Dynamic component={props.titleAs ?? 'h2'} class={props.titleClass ?? 'modal-title'} id={props.titleId}>
      {props.title}
    </Dynamic>
  );

  return (
    <div ref={overlayRef} class={props.overlayClass ?? 'modal-overlay'} {...createBackdropDismiss(close)}>
      <div
        {...rest}
        class={props.class ?? 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.titleId}
        aria-label={props.titleId ? undefined : props.ariaLabel}
        onKeyDown={(e) => trapFocus(e.currentTarget, e)}
        onClick={(e) => e.stopPropagation()}
      >
        <Show when={props.showCloseButton} fallback={titleEl()}>
          <div class={props.headerClass ?? 'modal-header-row'}>
            {titleEl()}
            {props.headerExtras}
            <button
              class="icon-btn"
              onClick={close}
              title={t('common.close')}
              aria-label={t('common.close')}
              type="button"
            >
              <i class="bi bi-x-lg" />
            </button>
          </div>
        </Show>
        {props.children}
      </div>
    </div>
  );
}
