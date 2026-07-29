import { Show, For, createSignal, onMount, onCleanup } from 'solid-js';
import { popups, resolvePopup, dismissPopup } from '../stores/popupStore.js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import './PopupContainer.css';

export function PopupContainer() {
  const { t } = useI18n();
  return (
    <Show when={popups.length > 0}>
      <div class="popup-overlay">
        <For each={popups}>
          {(popup) => {
            const config = popup.config;
            const [inputValue, setInputValue] = createSignal<string | number | boolean>(
              config.defaultValue ?? (config.inputType === 'checkbox' ? false : ''),
            );

            let inputRef: HTMLInputElement | HTMLTextAreaElement | undefined;

            onMount(() => {
              // Capture the trigger before autofocus so we can restore to it on close.
              saveFocus();
              if (inputRef && 'focus' in inputRef) {
                inputRef.focus();
                if (inputRef instanceof HTMLInputElement && inputRef.type === 'text') {
                  inputRef.select();
                }
              }
            });
            // Restore focus when the popup is dismissed/resolved and Solid disposes it.
            onCleanup(() => restoreFocus());

            let modalRef: HTMLDivElement | undefined;

            const handleKeyDown = (e: KeyboardEvent) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                dismissPopup(popup.id);
              } else if (e.key === 'Enter' && config.type !== 'alert') {
                e.preventDefault();
                if (config.type === 'confirm') {
                  resolvePopup(popup.id, true);
                } else {
                  resolvePopup(popup.id, inputValue());
                }
              } else if (e.key === 'Tab' && modalRef) {
                trapFocus(modalRef, e);
              }
            };

            const modalClass = () => {
              const classes = ['popup-modal'];
              if (config.wide) classes.push('popup-wide');
              if (config.large) classes.push('popup-large');
              return classes.join(' ');
            };

            return (
              <div id={String(popup.id)} class="popup-backdrop" onClick={() => dismissPopup(popup.id)} onKeyDown={handleKeyDown}>
                <div ref={modalRef} class={modalClass()} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={config.title ?? t('popups.defaultTitle')}>
                  <Show when={config.title}>
                    <h3 class="popup-title">{config.title}</h3>
                  </Show>
                  <p class="popup-message">{config.message}</p>

                  <Show when={config.type === 'prompt' || config.type === 'input'}>
                    <div class="popup-input-row">
                      <Show when={config.inputType === 'textarea'}>
                        <textarea
                          ref={inputRef as HTMLTextAreaElement}
                          class="popup-input"
                          rows={4}
                          value={String(inputValue())}
                          onInput={(e) => setInputValue(e.currentTarget.value)}
                        />
                      </Show>
                      <Show when={config.inputType === 'number'}>
                        <input
                          ref={inputRef as HTMLInputElement}
                          type="number"
                          class="popup-input"
                          value={Number(inputValue())}
                          onInput={(e) => setInputValue(Number(e.currentTarget.value))}
                        />
                      </Show>
                      <Show when={config.inputType === 'checkbox'}>
                        <label class="popup-checkbox-row">
                          <input
                            ref={inputRef as HTMLInputElement}
                            type="checkbox"
                            class="popup-checkbox"
                            checked={Boolean(inputValue())}
                            onChange={(e) => setInputValue(e.currentTarget.checked)}
                          />
                          <span class="checkbox-label-text">{t('popups.enabled')}</span>
                        </label>
                      </Show>
                      <Show when={!config.inputType || config.inputType === 'text'}>
                        <input
                          ref={inputRef as HTMLInputElement}
                          type="text"
                          class="popup-input"
                          value={String(inputValue())}
                          onInput={(e) => setInputValue(e.currentTarget.value)}
                        />
                      </Show>
                    </div>
                  </Show>

                  <div class="popup-actions">
                    <Show when={config.buttons && config.buttons.length > 0}>
                      <For each={config.buttons}>
                        {(btn, index) => (
                          <button
                            id={`popup-btn-${index()}`}
                            type="button"
                            class={btn.class || 'btn btn-primary primary'}
                            onClick={() => resolvePopup(popup.id, btn.value)}
                          >
                            {btn.label}
                          </button>
                        )}
                      </For>
                    </Show>
                    <Show when={!config.buttons || config.buttons.length === 0}>
                      <Show when={config.type !== 'alert'}>
                        <button type="button" class="btn btn-ghost" onClick={() => dismissPopup(popup.id)}>
                          {config.cancelLabel || t('common.cancel')}
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="btn btn-primary primary"
                        onClick={() => {
                          if (config.type === 'confirm') {
                            resolvePopup(popup.id, true);
                          } else if (config.type === 'prompt' || config.type === 'input') {
                            resolvePopup(popup.id, inputValue());
                          } else {
                            resolvePopup(popup.id, undefined);
                          }
                        }}
                      >
                        {config.confirmLabel || (config.type === 'confirm' ? t('common.confirm') : t('common.ok'))}
                      </button>
                    </Show>
                  </div>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
