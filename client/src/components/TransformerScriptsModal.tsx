/**
 * Transformer scripts management modal — CRUD for named Lua transformer
 * scripts plus an on-demand load-check (`transformerscript.validate`).
 *
 * Scripts live server-side and are reached over WebSocket: the list lives in
 * serverStore.transformerScripts and stays fresh because the server
 * rebroadcasts `transformerscript.listed` after every mutation. The modal
 * requests a fresh list on open (CustomBackendsModal precedent — there is no
 * active-entity snapshot for this entity).
 */

import { createSignal, Show, For, onMount, onCleanup } from 'solid-js';
import type { TransformerScript } from '@tamari/types';
import { useI18n } from '../i18n/index.js';
import { Modal } from './Modal.js';
import { confirmPopup } from '../stores/popupStore.js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import './TransformerScriptsModal.css';

export function TransformerScriptsModal(props: { onClose: () => void }) {
  const { t } = useI18n();
  const [formMode, setFormMode] = createSignal<'closed' | 'add' | 'edit'>('closed');
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [formName, setFormName] = createSignal('');
  const [formDescription, setFormDescription] = createSignal('');
  const [formLuaSource, setFormLuaSource] = createSignal('');

  // Validate-on-demand: request/response pair keyed by requestId — results
  // with any other requestId are ignored so a racing client can't clobber
  // the status line (same pattern as BackendDryRunPanel).
  const [validating, setValidating] = createSignal(false);
  const [pendingRequestId, setPendingRequestId] = createSignal<string | null>(null);
  const [validationResult, setValidationResult] = createSignal<{ ok: boolean; error?: string } | null>(null);

  const unsubValidated = bus.on('transformerscript.validated', (msg) => {
    const pending = pendingRequestId();
    if (!pending || msg.requestId !== pending) return;
    setValidationResult({ ok: msg.ok, ...(msg.error !== undefined ? { error: msg.error } : {}) });
    setValidating(false);
    setPendingRequestId(null);
  });
  onCleanup(unsubValidated);

  onMount(() => {
    bus.send({ type: 'transformerscript.list' });
  });

  const close = () => props.onClose();

  const resetValidation = () => {
    setValidating(false);
    setPendingRequestId(null);
    setValidationResult(null);
  };

  const openAdd = () => {
    setFormMode('add');
    setEditingId(null);
    setFormName('');
    setFormDescription('');
    setFormLuaSource('');
    resetValidation();
  };

  const openEdit = (s: TransformerScript) => {
    setFormMode('edit');
    setEditingId(s.id);
    setFormName(s.name);
    setFormDescription(s.description);
    setFormLuaSource(s.luaSource);
    resetValidation();
  };

  const closeForm = () => {
    setFormMode('closed');
    setEditingId(null);
    resetValidation();
  };

  const save = () => {
    const name = formName().trim();
    if (!name || !formLuaSource().trim()) return;
    const data = { name, description: formDescription().trim(), luaSource: formLuaSource() };
    const id = editingId();
    // Upsert — presence of `id` decides update vs create server-side.
    if (formMode() === 'edit' && id) {
      bus.send({ type: 'transformerscript.save', id, data });
    } else {
      bus.send({ type: 'transformerscript.save', data });
    }
    closeForm();
  };

  const validate = () => {
    const luaSource = formLuaSource();
    if (!luaSource.trim() || validating()) return;
    const requestId = crypto.randomUUID();
    setPendingRequestId(requestId);
    setValidating(true);
    setValidationResult(null);
    bus.send({ type: 'transformerscript.validate', luaSource, requestId });
  };

  const remove = async (s: TransformerScript) => {
    if (!(await confirmPopup(t('transformers.deleteScriptConfirm', { name: s.name })))) return;
    // Close the edit form if it's open on this script — otherwise a later
    // Save sends an update for a dead id and the form contents error out.
    if (editingId() === s.id) closeForm();
    bus.send({ type: 'transformerscript.delete', id: s.id });
  };

  return (
    <Modal
      title={t('transformers.scriptsTitle')}
      onClose={close}
      class="modal settings-modal transformer-scripts-modal"
      ariaLabel={t('transformers.scriptsTitle')}
    >
      <section class="settings-section">
        <p class="hint-text">{t('transformers.scriptsDescription')}</p>
      </section>

      <section class="settings-section">
        <Show
          when={state.transformerScripts.length > 0}
          fallback={<p class="hint-text">{t('transformers.scriptsEmpty')}</p>}
        >
          <For each={state.transformerScripts}>
            {(s) => (
              <div class="flex-between">
                <div class="flex-col-sm flex-1 min-w-0">
                  <span class="text-sm">
                    <strong>{s.name}</strong>
                  </span>
                  <Show when={s.description}>
                    <span class="text-xs text-muted">{s.description}</span>
                  </Show>
                </div>
                <div class="flex-row-sm">
                  <button class="text-btn small" type="button" onClick={() => openEdit(s)}>
                    {t('transformers.editScript')}
                  </button>
                  <button class="text-btn danger small" type="button" onClick={() => void remove(s)}>
                    {t('transformers.deleteScript')}
                  </button>
                </div>
              </div>
            )}
          </For>
        </Show>
      </section>

      {/* Add / edit form */}
      <Show when={formMode() !== 'closed'}>
        <section class="settings-section">
          <h3 class="section-heading">
            {formMode() === 'add' ? t('transformers.addScript') : t('transformers.editScript')}
          </h3>
          <label class="field-label">
            {t('transformers.scriptName')}
            <input
              class="input"
              value={formName()}
              onInput={(e) => setFormName(e.currentTarget.value)}
              placeholder="strip-ooc"
            />
          </label>
          <label class="field-label">
            {t('transformers.scriptDescriptionLabel')}
            <input class="input" value={formDescription()} onInput={(e) => setFormDescription(e.currentTarget.value)} />
          </label>
          <label class="field-label">
            {t('transformers.luaSource')}
            <textarea
              class="font-mono text-sm resize-v"
              rows={12}
              value={formLuaSource()}
              onInput={(e) => {
                setFormLuaSource(e.currentTarget.value);
                resetValidation();
              }}
              placeholder="for i = #messages, 1, -1 do&#10;  ...&#10;end"
            />
            <span class="hint-text">{t('transformers.luaSourceHint')}</span>
          </label>
          <div class="flex-row-sm mt-sm">
            <button class="btn btn-primary primary-btn" type="button" onClick={save}>
              {t('transformers.saveScript')}
            </button>
            <button
              class="text-btn"
              type="button"
              disabled={validating() || !formLuaSource().trim()}
              onClick={validate}
            >
              {validating() ? t('transformers.validating') : t('transformers.validate')}
            </button>
            <button class="text-btn" type="button" onClick={closeForm}>
              {t('transformers.cancelEdit')}
            </button>
          </div>
          {/* role=status announces the async load-check result (aria-live).
              The element always exists — only its content changes (§11). */}
          <p class="transformer-scripts-validation hint-text" role="status">
            <Show when={validationResult()}>
              {(result) => (
                <span class={result().ok ? 'transformer-scripts-validation-ok' : 'text-danger'}>
                  {result().ok ? t('transformers.validateOk') : (result().error ?? '')}
                </span>
              )}
            </Show>
          </p>
        </section>
      </Show>

      <Show when={formMode() === 'closed'}>
        <button class="text-btn" type="button" onClick={openAdd}>
          <i class="bi bi-plus-lg" /> {t('transformers.addScript')}
        </button>
      </Show>

      <div class="modal-actions">
        <button class="btn" onClick={close}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  );
}
