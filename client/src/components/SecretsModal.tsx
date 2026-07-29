/**
 * Secrets management modal — CRUD for the encrypted vault.
 *
 * The vault is encrypted server-side with TAMARI_SECRET; the client
 * reaches it with just its bearer token (no separate password).
 * Secrets are fetched on demand over REST (not broadcast over WS).
 */

import { createSignal, Show, For, onMount } from 'solid-js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import { listSecrets, setSecret, deleteSecret, type SecretEntry } from '../lib/secrets.js';
import { confirmPopup } from '../stores/popupStore.js';

export function SecretsModal(props: { onClose: () => void }) {
  const { t } = useI18n();
  const [entries, setEntries] = createSignal<SecretEntry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [formMode, setFormMode] = createSignal<'closed' | 'add' | 'edit'>('closed');
  const [formKey, setFormKey] = createSignal('');
  const [formLabel, setFormLabel] = createSignal('');
  const [formValue, setFormValue] = createSignal('');
  const [revealed, setRevealed] = createSignal<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setEntries(await listSecrets());
    } catch {
      setError(t('secrets.errorFetch'));
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    saveFocus();
    void load();
  });

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  const openAdd = () => {
    setFormMode('add');
    setFormKey(''); setFormLabel(''); setFormValue('');
  };

  const openEdit = (s: SecretEntry) => {
    setFormMode('edit');
    setFormKey(s.key); setFormLabel(s.label ?? ''); setFormValue(s.value);
  };

  const closeForm = () => setFormMode('closed');

  const save = async () => {
    const k = formKey().trim();
    const v = formValue().trim();
    if (!k || !v) return;
    try {
      await setSecret(k, v, formLabel().trim() || undefined);
      closeForm();
      await load();
    } catch {
      setError(t('secrets.errorSave'));
    }
  };

  const remove = async (s: SecretEntry) => {
    const name = s.label ?? s.key;
    if (!(await confirmPopup(t('secrets.deleteConfirm', { name })))) return;
    try {
      await deleteSecret(s.key);
      // setSecret is an upsert — close an edit form open on this key so a
      // later Save can't silently resurrect the deleted secret.
      if (formMode() === 'edit' && formKey() === s.key) closeForm();
      await load();
    } catch {
      setError(t('secrets.errorDelete'));
    }
  };

  const toggleReveal = (k: string) => setRevealed((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal settings-modal" role="dialog" aria-modal="true" aria-label={t('secrets.title')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <h2 class="modal-title">{t('secrets.title')}</h2>

        <section class="settings-section">
          <p class="hint-text">{t('secrets.description', { ref: 'secret:my-key' })}</p>
          {error() && <p class="hint-text text-danger">{error()}</p>}
        </section>

        <section class="settings-section">
          <Show when={!loading()} fallback={<p class="hint-text">{t('common.loading')}</p>}>
            <Show
              when={entries().length > 0}
              fallback={<p class="hint-text">{t('secrets.empty')}</p>}
            >
              <For each={entries()}>
                {(s) => (
                  <div class="flex-between">
                    <div class="flex-col-sm flex-1 min-w-0">
                      <span class="text-sm"><strong>{s.label ?? s.key}</strong></span>
                      <span class="text-xs text-muted font-mono">{s.key}</span>
                      <span class="text-xs text-muted font-mono">
                        {revealed()[s.key] ? s.value : '••••••••••••'}
                      </span>
                    </div>
                    <div class="flex-row-sm">
                      <button class="text-btn small" type="button" onClick={() => toggleReveal(s.key)}>
                        {revealed()[s.key] ? t('secrets.hide') : t('secrets.reveal')}
                      </button>
                      <button class="text-btn small" type="button" onClick={() => openEdit(s)}>
                        {t('secrets.edit')}
                      </button>
                      <button class="text-btn danger small" type="button" onClick={() => remove(s)}>
                        {t('secrets.delete')}
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </section>

        {/* Add / edit form */}
        <Show when={formMode() !== 'closed'}>
          <section class="settings-section">
            <h3 class="section-heading">{formMode() === 'add' ? t('secrets.add') : t('secrets.edit')}</h3>
            <label class="field-label">
              {t('secrets.key')}
              <input
                class="input font-mono"
                value={formKey()}
                onInput={(e) => setFormKey(e.currentTarget.value)}
                placeholder="openai-key"
                disabled={formMode() === 'edit'}
              />
              <span class="hint-text">{t('secrets.keyHint', { ref: `secret:${formKey() || '...'}` })}</span>
            </label>
            <label class="field-label">
              {t('secrets.label')}
              <input
                class="input"
                value={formLabel()}
                onInput={(e) => setFormLabel(e.currentTarget.value)}
                placeholder="OpenAI – Work"
              />
            </label>
            <label class="field-label">
              {t('secrets.value')}
              <input
                class="input font-mono"
                type="password"
                value={formValue()}
                onInput={(e) => setFormValue(e.currentTarget.value)}
                placeholder="sk-..."
              />
            </label>
            <div class="flex-row-sm mt-sm">
              <button class="btn btn-primary primary-btn" type="button" onClick={() => void save()}>{t('secrets.save')}</button>
              <button class="text-btn" type="button" onClick={closeForm}>{t('secrets.cancel')}</button>
            </div>
          </section>
        </Show>

        <Show when={formMode() === 'closed'}>
          <button class="text-btn" type="button" onClick={openAdd}>
            <i class="bi bi-plus-lg" /> {t('secrets.add')}
          </button>
        </Show>

        <div class="modal-actions">
          <button class="btn" onClick={close}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
