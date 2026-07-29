import { For, createMemo } from 'solid-js';
import { toasts, removeToast } from '../stores/toastStore.js';
import { state } from '../stores/serverStore.js';
import { useI18n } from '../i18n/index.js';

// Bootstrap-Icons glyph per toast type. The icon SHAPE conveys type without
// relying on the border-left colour, so the type stays distinguishable under
// Windows High Contrast Mode (forced colours) where the colour collapses.
const TOAST_ICON: Record<string, string> = {
  success: 'check-circle-fill',
  error: 'exclamation-circle-fill',
  warning: 'exclamation-triangle-fill',
  info: 'info-circle-fill',
};

export function ToastContainer() {
  const { t } = useI18n();
  const position = createMemo(
    () =>
      (state.settings['toastPosition']) ?? 'top-right',
  );

  const typeLabel = (type: string): string =>
    type === 'success'
      ? t('toasts.typeSuccess')
      : type === 'error'
        ? t('toasts.typeError')
        : type === 'warning'
          ? t('toasts.typeWarning')
          : t('toasts.typeInfo');

  return (
    <div
      class={`toast-container toast-position-${position()}`}
      role="region"
      aria-live="polite"
      aria-label={t('toasts.regionLabel')}
    >
      <For each={toasts}>
        {(toast) => (
          // The toast itself is mouse-clickable to dismiss (onClick) but is NOT
          // a role="button": the accessible dismiss path is the .toast-close
          // button below, and making the whole toast role=button would nest that
          // button (axe nested-interactive). The toast is already announced via
          // the container's aria-live region.
          <div id={toast.id} class={`toast toast-${toast.type}`} onClick={() => removeToast(toast.id)}>
            <i class={`bi bi-${TOAST_ICON[toast.type] ?? 'info-circle-fill'} toast-icon`} aria-hidden="true" />
            <span class="sr-only">{typeLabel(toast.type)}</span>
            <span class="toast-message">{toast.message}</span>
            <button class="toast-close" onClick={() => removeToast(toast.id)} type="button" aria-label={t('toasts.dismiss')}>
              <i class="bi bi-x-lg" />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
