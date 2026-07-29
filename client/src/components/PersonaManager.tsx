import { For, Show, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { bus } from '../bus/WebSocketBus.js';
import { state } from '../stores/serverStore.js';
import { addToast } from '../stores/toastStore.js';
import { activePersonaId, setActivePersonaId } from '../stores/uiStore.js';
import type { Persona } from '@tamari/types';
import { CropModal } from './CropModal.js';
import { confirmPopup } from '../stores/popupStore.js';
import { SafeImage } from './SafeImage.js';
import { apiFetch } from '../lib/apiFetch.js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../timing.js';
import './PersonaManager.css';

export function PersonaManager(props: { onClose: () => void }) {
  const { t } = useI18n();

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  onMount(() => {
    saveFocus();
    bus.send({ type: 'persona.list' });

    const unsubCreated = bus.on('persona.created', (msg) => {
      if (msg.clientId === state.clientId) {
        setActivePersonaId(msg.persona.id);
      }
    });

    onCleanup(() => {
      unsubCreated();
      setActivePersonaId(null);
    });
  });

  const currentChatPersonaId = () => state.activeChat?.personaId ?? null;

  const createPersona = () => {
    bus.send({
      type: 'persona.create',
      data: { name: t('persona.newPersona'), description: '' },
    });
  };

  const selectPersonaForChat = (personaId: string) => {
    const chatId = state.activeChat?.id;
    if (chatId) {
      bus.send({ type: 'chat.update', chatId, patch: { personaId: personaId } });
    }
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal persona-modal" role="dialog" aria-modal="true" aria-label={t('persona.modalAriaLabel')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <div class="modal-header-row">
          <h2 class="modal-title">{t('persona.title')}</h2>
          <button class="icon-btn" onClick={close} title={t('common.close')} aria-label={t('common.close')} type="button">
            <i class="bi bi-x-lg" />
          </button>
        </div>

        <Show
          when={activePersonaId()}
          fallback={
            <>
              <div class="persona-list">
                <For each={state.personas}>
                  {(persona) => {
                    const isSelected = () => currentChatPersonaId() === persona.id;
                    return (
                      <div
                        id={persona.id}
                        class={`selectable-item persona-item ${isSelected() ? 'active' : ''}`}
                        onClick={() => selectPersonaForChat(persona.id)}
                        title={isSelected() ? t('persona.selectedForChat') : t('persona.clickToSelect')}
                      >
                        <Show
                          when={persona.thumbnailUrl ?? persona.avatarUrl}
                          fallback={
                            <div class="persona-avatar">
                              <i class="bi bi-person text-xl" />
                            </div>
                          }
                        >
                          <SafeImage class="persona-avatar" src={(persona.thumbnailUrl ?? persona.avatarUrl) ?? undefined} alt={persona.name} />
                        </Show>
                        <div class="persona-info">
                          <span class="persona-name">
                            {persona.name}
                            <Show when={isSelected()}>
                              <i class="bi bi-check-circle-fill text-accent" title={t('persona.selectedForCurrent')} />
                            </Show>
                          </span>
                          <span class="persona-desc">{persona.description.slice(0, 60)}</span>
                        </div>
                        <button
                          class="icon-btn small"
                          onClick={(e) => {
                            e.stopPropagation();
                            setActivePersonaId(persona.id);
                            bus.send({ type: 'persona.select', personaId: persona.id });
                          }}
                          title={t('common.edit')} aria-label={t('common.edit')}
                          type="button"
                        >
                          <i class="bi bi-pencil" />
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
              <button class="btn btn-primary primary-btn" onClick={createPersona} type="button">
                <i class="bi bi-plus-lg" /> {t('persona.newPersona')}
              </button>
            </>
          }
        >
          {(id) => (
            <Show
              when={state.activePersona?.id === id()}
              fallback={
                <div class="flex items-center justify-center p-8">
                  <span class="loading-spinner" />
                  <span class="ml-2 text-muted">{t('persona.loadingPersona')}</span>
                </div>
              }
            >
              <PersonaEditor persona={state.activePersona!} onBack={() => setActivePersonaId(null)} />
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}

function PersonaEditor(props: { persona: Persona; onBack: () => void }) {
  const { t } = useI18n();
  const [name, setName] = createSignal(props.persona.name);
  const [description, setDescription] = createSignal(props.persona.description);
  const [loadedPersonaId, setLoadedPersonaId] = createSignal<string | null>(null);
  const [savedIndicator, setSavedIndicator] = createSignal(false);

  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let avatarInputRef: HTMLInputElement | undefined;

  createEffect(() => {
    const p = props.persona;
    if (p.id === loadedPersonaId()) return;
    setName(p.name);
    setDescription(p.description);
    setLoadedPersonaId(p.id);
  });

  const scheduleAutoSave = () => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => doSaveFields(), AUTOSAVE_DEBOUNCE_MS);
  };

  // Flush a pending auto-save on unmount so closing the editor within the
  // debounce window doesn't silently lose the edit.
  onCleanup(() => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      doSaveFields();
    }
  });

  const doSaveFields = () => {
    bus.send({
      type: 'persona.update',
      personaId: props.persona.id,
      patch: {
        name: name(),
        description: description(),
      },
    });
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 1200);
  };

  const uploadAvatarFile = async (file: File) => {
    const formData = new FormData();
    formData.append('avatar', file);
    const uploadUrl = props.persona.avatarUploadUrl;
    if (!uploadUrl) {
      console.error('No avatar upload URL');
      addToast(t('persona.avatarUploadUnavailable'), 'error');
      return;
    }
    try {
      await apiFetch(uploadUrl, {
        method: 'POST',
        body: formData,
      });
    } catch (err) {
      console.error('Avatar upload failed:', err);
      addToast(t('persona.avatarUploadFailed'), 'error');
    }
  };

  const deletePersona = async () => {
    if (!(await confirmPopup(t('persona.deleteConfirm')))) return;
    bus.send({ type: 'persona.delete', personaId: props.persona.id });
    props.onBack();
  };

  const [showCropModal, setShowCropModal] = createSignal(false);
  const [cropImageUrl, setCropImageUrl] = createSignal<string>('');

  const handleAvatarChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (state.settings['neverResizeAvatars']) {
      void uploadAvatarFile(file);
      return;
    }

    const url = URL.createObjectURL(file);
    setCropImageUrl(url);
    setShowCropModal(true);
  };

  const applyCroppedAvatar = (blob: Blob) => {
    setShowCropModal(false);
    URL.revokeObjectURL(cropImageUrl());
    void uploadAvatarFile(new File([blob], 'avatar.png', { type: 'image/png' }));
  };

  return (
    <div class="persona-editor">
      <button class="text-btn back-btn" onClick={props.onBack} type="button">
        <i class="bi bi-arrow-left" /> {t('persona.back')}
      </button>

      <label class="field-label">
        {t('common.name')}
        <input
          class="text-input"
          value={name()}
          onInput={(e) => {
            setName(e.currentTarget.value);
            scheduleAutoSave();
          }}
        />
      </label>

      <label class="field-label">
        {t('persona.descriptionLabel')}
        <textarea
          class="textarea-input"
          rows={3}
          value={description()}
          onInput={(e) => {
            setDescription(e.currentTarget.value);
            scheduleAutoSave();
          }}
        />
      </label>

      <div class="persona-avatar-upload">
        <Show
          when={props.persona.avatarUrl}
          fallback={
            <div class="persona-avatar-preview placeholder">
              <i class="bi bi-person" />
            </div>
          }
        >
          <SafeImage class="persona-avatar-preview" src={props.persona.avatarUrl ?? undefined} alt={name()} />
        </Show>
        <button
          type="button"
          class="attach-btn"
          onClick={() => avatarInputRef?.click()}
          title={t('persona.chooseAvatar')}
          aria-label={t('persona.chooseAvatar')}
        >
          <i class="bi bi-image" />
        </button>
        <input
          ref={avatarInputRef}
          class="hidden-file-input"
          type="file"
          accept="image/*"
          hidden
          onChange={handleAvatarChange}
        />
      </div>

      <div class="persona-actions">
        <div class="persona-actions-left">
          <button class="text-btn danger" onClick={deletePersona} type="button">
            <i class="bi bi-trash" /> {t('common.delete')}
          </button>
        </div>
        <Show when={savedIndicator()}>
          <span class="save-indicator">{t('persona.saved')}</span>
        </Show>
      </div>

      <Show when={showCropModal()}>
        <CropModal
          imageUrl={cropImageUrl()}
          onConfirm={applyCroppedAvatar}
          onCancel={() => {
            setShowCropModal(false);
            URL.revokeObjectURL(cropImageUrl());
          }}
        />
      </Show>
    </div>
  );
}
