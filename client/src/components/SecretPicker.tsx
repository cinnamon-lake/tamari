/**
 * Reusable vault-secret picker — a button that, when clicked, lists the vault
 * and writes `secret:<key>` into the calling field via `onPick`.
 */

import { createSignal, Show, For } from 'solid-js';
import { useI18n } from '../i18n/index.js';
import { listSecrets, type SecretEntry } from '../lib/secrets.js';
import './SecretPicker.css';

export function SecretPicker(props: { onPick: (ref: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = createSignal(false);
  const [secrets, setSecrets] = createSignal<SecretEntry[]>([]);
  const [loading, setLoading] = createSignal(false);

  const toggle = async () => {
    if (open()) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    try {
      setSecrets(await listSecrets());
    } catch {
      setSecrets([]);
    } finally {
      setLoading(false);
    }
  };

  const pick = (s: SecretEntry) => {
    props.onPick(`secret:${s.key}`);
    setOpen(false);
  };

  return (
    <div class="secret-picker">
      <button
        class="icon-btn small"
        type="button"
        onClick={() => void toggle()}
        title={t('secrets.useVaultSecret')}
        aria-label={t('secrets.useVaultSecret')}
      >
        <i class="bi bi-key" />
      </button>
      <Show when={open()}>
        <div class="secret-picker-dropdown">
          <Show when={!loading()} fallback={<span class="hint-text">{t('common.loading')}</span>}>
            <Show
              when={secrets().length > 0}
              fallback={<span class="hint-text">{t('secrets.noneAvailable')}</span>}
            >
              <For each={secrets()}>
                {(s) => (
                  <button
                    class="text-btn small secret-picker-item"
                    type="button"
                    onClick={() => pick(s)}
                  >
                    {s.label ?? s.key}
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
