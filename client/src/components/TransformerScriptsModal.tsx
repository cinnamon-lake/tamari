/**
 * Transformer scripts management modal — CRUD for named Lua transformer
 * scripts plus an on-demand load-check (`transformerscript.validate`).
 *
 * Scripts live server-side and are reached over WebSocket: the list lives in
 * serverStore.transformerScripts and stays fresh because the server
 * rebroadcasts `transformerscript.listed` after every mutation. The modal
 * requests a fresh list on open (CustomBackendsModal precedent — there is no
 * active-entity snapshot for this entity).
 *
 * There is no Save button: edits auto-save debounced with a dirty flag
 * (BackendConfigModal / PromptListModal precedent). "Add Script" creates the
 * entity immediately with a handle() template; the clientId-filtered
 * `transformerscript.created` echo opens the edit form on it (PromptListModal
 * duplicate-flow precedent). Pending edits flush on form close / modal close
 * / switching the edit target, and are cancelled when the target is deleted.
 */

import { createSignal, createEffect, Show, For, onMount, onCleanup } from 'solid-js';
import type { TransformerScript } from '@tamari/types';
import { useI18n } from '../i18n/index.js';
import { Modal } from './Modal.js';
import { confirmPopup } from '../stores/popupStore.js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../timing.js';
import './TransformerScriptsModal.css';

/** Starter source for a freshly created script — doubles as the contract doc. */
const NEW_SCRIPT_SOURCE = `-- handle(messages, ctx) receives the rendered message array and the
-- context table (userName, charName, generationType, model,
-- backendProvider); return the (possibly new) message array to send.
function handle(messages, ctx)
  return messages
end
`;

export function TransformerScriptsModal(props: { onClose: () => void }) {
  const { t } = useI18n();
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [formName, setFormName] = createSignal('');
  const [formDescription, setFormDescription] = createSignal('');
  const [formLuaSource, setFormLuaSource] = createSignal('');
  const [dirty, setDirty] = createSignal(false);

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

  // Add Script creates server-side immediately; our own created echo opens
  // the edit form. Self-filtered so another tab's creation doesn't hijack
  // the form (AGENTS.md §Active Entity).
  const unsubCreated = bus.on('transformerscript.created', (msg) => {
    if (msg.clientId !== state.clientId) return;
    openEdit(msg.item);
  });
  onCleanup(unsubCreated);

  const close = () => {
    flushPending();
    props.onClose();
  };

  const resetValidation = () => {
    setValidating(false);
    setPendingRequestId(null);
    setValidationResult(null);
  };

  /** Send the current form as an update. Skipped while invalid (blank name)
      so a half-typed edit never clobbers the stored entity. */
  const saveForm = () => {
    const id = editingId();
    const name = formName().trim();
    if (!id || !name) return;
    bus.send({
      type: 'transformerscript.save',
      id,
      data: { name, description: formDescription().trim(), luaSource: formLuaSource() },
    });
  };

  /** Flush a pending debounced save NOW — clearing dirty first would cancel
      the timer and silently drop the edits (BackendConfigModal precedent). */
  const flushPending = () => {
    if (!dirty()) return;
    saveForm();
    setDirty(false);
  };

  // Auto-save the open script (debounced).
  createEffect(() => {
    if (!dirty()) return;
    formName();
    formDescription();
    formLuaSource();

    const timer = setTimeout(() => {
      saveForm();
      setDirty(false);
    }, AUTOSAVE_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(timer));
  });

  const openEdit = (s: TransformerScript) => {
    // Flush edits against the PREVIOUS target before switching — its save
    // goes out with that target's id.
    flushPending();
    setEditingId(s.id);
    setFormName(s.name);
    setFormDescription(s.description);
    setFormLuaSource(s.luaSource);
    setDirty(false);
    resetValidation();
  };

  const addScript = () => {
    flushPending();
    // Upsert without id = create; the created echo opens the edit form.
    bus.send({
      type: 'transformerscript.save',
      data: { name: t('transformers.newScriptName'), description: '', luaSource: NEW_SCRIPT_SOURCE },
    });
  };

  const closeForm = () => {
    flushPending();
    setEditingId(null);
    resetValidation();
  };

  const markDirty = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setDirty(true);
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
    // Cancel any pending debounced save when the edit form is open on this
    // script — its target is about to disappear (BackendConfigModal
    // delete-after-save hazard).
    if (editingId() === s.id) {
      setDirty(false);
      closeForm();
    }
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

      {/* Edit form — auto-saves; opened by Edit or by the Add Script echo. */}
      <Show when={editingId() !== null}>
        <section class="settings-section">
          <h3 class="section-heading">{t('transformers.editScript')}</h3>
          <label class="field-label">
            {t('transformers.scriptName')}
            <input
              class="input"
              value={formName()}
              onInput={(e) => markDirty(setFormName)(e.currentTarget.value)}
              placeholder="strip-ooc"
            />
          </label>
          <label class="field-label">
            {t('transformers.scriptDescriptionLabel')}
            <input
              class="input"
              value={formDescription()}
              onInput={(e) => markDirty(setFormDescription)(e.currentTarget.value)}
            />
          </label>
          <label class="field-label">
            {t('transformers.luaSource')}
            <textarea
              class="font-mono text-sm resize-v"
              rows={12}
              value={formLuaSource()}
              onInput={(e) => {
                markDirty(setFormLuaSource)(e.currentTarget.value);
                resetValidation();
              }}
              placeholder="function handle(messages, ctx)&#10;  return messages&#10;end"
            />
            <span class="hint-text">{t('transformers.luaSourceHint')}</span>
          </label>
          <div class="flex-row-sm mt-sm">
            <button
              class="text-btn"
              type="button"
              disabled={validating() || !formLuaSource().trim()}
              onClick={validate}
            >
              {validating() ? t('transformers.validating') : t('transformers.validate')}
            </button>
            <button class="text-btn" type="button" onClick={closeForm}>
              {t('transformers.doneEditing')}
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

      <Show when={editingId() === null}>
        <button class="text-btn" type="button" onClick={addScript}>
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
