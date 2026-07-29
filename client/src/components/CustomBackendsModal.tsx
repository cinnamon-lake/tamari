/**
 * Custom backends management modal — CRUD for named Lua backend adapters.
 *
 * Custom backends live server-side and are reached over WebSocket (not REST):
 * the list lives in serverStore.customBackends and stays fresh because the
 * server rebroadcasts `custombackend.listed` after every mutation. The modal
 * requests a fresh list on open.
 */

import { createSignal, Show, For, onMount } from 'solid-js';
import type { CustomBackend } from '@tamari/types';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import { confirmPopup } from '../stores/popupStore.js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { BackendDryRunPanel } from './BackendDryRunPanel.js';

export function CustomBackendsModal(props: { onClose: () => void }) {
  const { t } = useI18n();
  const [formMode, setFormMode] = createSignal<'closed' | 'add' | 'edit'>('closed');
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [formName, setFormName] = createSignal('');
  const [formDescription, setFormDescription] = createSignal('');
  const [formLuaSource, setFormLuaSource] = createSignal('');

  onMount(() => {
    saveFocus();
    bus.send({ type: 'custombackend.list' });
  });

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  const openAdd = () => {
    setFormMode('add');
    setEditingId(null);
    setFormName(''); setFormDescription(''); setFormLuaSource('');
  };

  const openEdit = (b: CustomBackend) => {
    setFormMode('edit');
    setEditingId(b.id);
    setFormName(b.name); setFormDescription(b.description); setFormLuaSource(b.luaSource);
  };

  const closeForm = () => {
    setFormMode('closed');
    setEditingId(null);
  };

  const save = () => {
    const name = formName().trim();
    if (!name || !formLuaSource().trim()) return;
    const data = { name, description: formDescription().trim(), luaSource: formLuaSource() };
    const id = editingId();
    if (formMode() === 'edit' && id) {
      bus.send({ type: 'custombackend.update', id, patch: data });
    } else {
      bus.send({ type: 'custombackend.create', data });
    }
    closeForm();
  };

  const remove = async (b: CustomBackend) => {
    if (!(await confirmPopup(t('customBackends.deleteConfirm', { name: b.name })))) return;
    // Close the edit form if it's open on this backend — otherwise a later
    // Save sends an update for a dead id and the form contents error out.
    if (editingId() === b.id) closeForm();
    bus.send({ type: 'custombackend.delete', id: b.id });
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal settings-modal" role="dialog" aria-modal="true" aria-label={t('customBackends.title')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <h2 class="modal-title">{t('customBackends.title')}</h2>

        <section class="settings-section">
          <p class="hint-text">{t('customBackends.description')}</p>
        </section>

        <section class="settings-section">
          <Show
            when={state.customBackends.length > 0}
            fallback={<p class="hint-text">{t('customBackends.empty')}</p>}
          >
            <For each={state.customBackends}>
              {(b) => (
                <div class="flex-between">
                  <div class="flex-col-sm flex-1 min-w-0">
                    <span class="text-sm"><strong>{b.name}</strong></span>
                    <Show when={b.description}>
                      <span class="text-xs text-muted">{b.description}</span>
                    </Show>
                  </div>
                  <div class="flex-row-sm">
                    <button class="text-btn small" type="button" onClick={() => openEdit(b)}>
                      {t('customBackends.edit')}
                    </button>
                    <button class="text-btn danger small" type="button" onClick={() => void remove(b)}>
                      {t('customBackends.delete')}
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
            <h3 class="section-heading">{formMode() === 'add' ? t('customBackends.add') : t('customBackends.edit')}</h3>
            <label class="field-label">
              {t('customBackends.name')}
              <input
                class="input"
                value={formName()}
                onInput={(e) => setFormName(e.currentTarget.value)}
                placeholder="my-backend"
              />
            </label>
            <label class="field-label">
              {t('customBackends.descriptionLabel')}
              <input
                class="input"
                value={formDescription()}
                onInput={(e) => setFormDescription(e.currentTarget.value)}
              />
            </label>
            <label class="field-label">
              {t('customBackends.luaSource')}
              <textarea
                class="font-mono text-sm resize-v"
                rows={12}
                value={formLuaSource()}
                onInput={(e) => setFormLuaSource(e.currentTarget.value)}
                placeholder="function generate(prompt, ctx)&#10;  ...&#10;end"
              />
              <span class="hint-text">{t('customBackends.luaSourceHint')}</span>
            </label>
            <div class="flex-row-sm mt-sm">
              <button class="btn btn-primary primary-btn" type="button" onClick={save}>{t('customBackends.save')}</button>
              <button class="text-btn" type="button" onClick={closeForm}>{t('customBackends.cancel')}</button>
            </div>

            {/* Dry-run against the current (unsaved) editor content. Shown only
                while the add/edit form is open — the list view has no editor
                content to test, so there is no test affordance when the form is closed. */}
            <BackendDryRunPanel luaSource={formLuaSource()} />
          </section>
        </Show>

        <Show when={formMode() === 'closed'}>
          <button class="text-btn" type="button" onClick={openAdd}>
            <i class="bi bi-plus-lg" /> {t('customBackends.add')}
          </button>
        </Show>

        <div class="modal-actions">
          <button class="btn" onClick={close}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
