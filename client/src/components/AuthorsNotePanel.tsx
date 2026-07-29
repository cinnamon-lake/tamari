import { Show, createSignal, createEffect, onCleanup } from 'solid-js';
import { str } from '../lib/coerce.js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';

export interface AuthorsNotePanelProps {
  open: boolean;
  onClose: () => void;
}

interface AuthorsNoteData {
  content: string;
  position: 'before_prompt' | 'after_prompt' | 'in_chat';
  depth: number;
  role: 'system' | 'user' | 'assistant';
  interval: number;
}

function getDefaultAN(): AuthorsNoteData {
  return {
    content: '',
    position: 'in_chat',
    depth: 4,
    role: 'system',
    interval: 1,
  };
}

function readAN(meta?: Record<string, unknown> | null): AuthorsNoteData {
  if (!meta) return getDefaultAN();
  const an = meta['authorsNote'];
  if (!an || typeof an !== 'object') return getDefaultAN();
  const obj = an as Record<string, unknown>;
  const pos = str(obj['position'], 'in_chat');
  const role = str(obj['role'], 'system');
  return {
    content: str(obj['content']),
    position: ['before_prompt', 'after_prompt', 'in_chat'].includes(pos)
      ? (pos as AuthorsNoteData['position'])
      : 'in_chat',
    depth: Number(obj['depth'] ?? 4),
    role: ['system', 'user', 'assistant'].includes(role) ? (role as AuthorsNoteData['role']) : 'system',
    interval: Number(obj['interval'] ?? 1),
  };
}

export function AuthorsNotePanel(props: AuthorsNotePanelProps) {
  const { t } = useI18n();
  const [content, setContent] = createSignal('');
  const [position, setPosition] = createSignal<AuthorsNoteData['position']>('in_chat');
  const [depth, setDepth] = createSignal(4);
  const [role, setRole] = createSignal<AuthorsNoteData['role']>('system');
  const [interval, setInterval] = createSignal(1);
  const [savedIndicator, setSavedIndicator] = createSignal(false);

  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const activeChat = () => state.activeChat;

  // Sync from chat metadata when panel opens or chat changes
  createEffect(() => {
    if (props.open) {
      const an = readAN(activeChat()?.metadata);
      setContent(an.content);
      setPosition(an.position);
      setDepth(an.depth);
      setRole(an.role);
      setInterval(an.interval);
    }
  });

  // Capture the element that had focus before the panel opened so it can be
  // restored on close. Only saves on the closed→open transition.
  let wasOpen = false;
  createEffect(() => {
    const nowOpen = props.open;
    if (nowOpen && !wasOpen) saveFocus();
    wasOpen = nowOpen;
  });

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  const doSave = () => {
    const chat = activeChat();
    if (!chat) return;
    const meta = { ...(chat.metadata ?? {}) };
    meta['authorsNote'] = {
      content: content(),
      position: position(),
      depth: depth(),
      role: role(),
      interval: interval(),
    };
    bus.send({ type: 'chat.update', chatId: chat.id, patch: { metadata: meta } });
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 1200);
  };

  const scheduleAutoSave = () => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => doSave(), 600);
  };

  // Flush a pending auto-save on unmount so closing the panel within the
  // debounce window doesn't silently lose the edit.
  onCleanup(() => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      doSave();
    }
  });

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && close()}>
        <div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="authors-note-title" onKeyDown={(e) => trapFocus(e.currentTarget, e)}>
          <h2 class="authors-note-title" id="authors-note-title">
            <i class="bi bi-journal-text" /> {t('authorsNote.title')}
          </h2>

          <label class="authors-note-content-label">
            {t('authorsNote.contentLabel')}
            <textarea
              class="authors-note-content-input"
              rows={6}
              value={content()}
              onInput={(e) => {
                setContent(e.currentTarget.value);
                scheduleAutoSave();
              }}
              placeholder={t('authorsNote.contentPlaceholder')}
            />
          </label>

          <label class="authors-note-position-label">
            {t('authorsNote.positionLabel')}
            <select
              class="select"
              value={position()}
              onChange={(e) => {
                setPosition(e.currentTarget.value as AuthorsNoteData['position']);
                scheduleAutoSave();
              }}
            >
              <option class="authors-note-position-option" value="before_prompt">{t('authorsNote.positionBeforePrompt')}</option>
              <option class="authors-note-position-option" value="after_prompt">{t('authorsNote.positionAfterPrompt')}</option>
              <option class="authors-note-position-option" value="in_chat">{t('authorsNote.positionInChat')}</option>
            </select>
          </label>

          <Show when={position() === 'in_chat'}>
            <div class="row-equal gap-md">
              <label class="authors-note-depth-label">
                {t('authorsNote.depthLabel')}
                <input
                  class="authors-note-depth-input"
                  type="number"
                  min={0}
                  max={100}
                  value={depth()}
                  onInput={(e) => {
                    setDepth(Math.max(0, parseInt(e.currentTarget.value, 10) || 0));
                    scheduleAutoSave();
                  }}
                />
              </label>
              <label class="authors-note-role-label">
                {t('authorsNote.roleLabel')}
                <select
                  class="select"
                  value={role()}
                  onChange={(e) => {
                    setRole(e.currentTarget.value as AuthorsNoteData['role']);
                    scheduleAutoSave();
                  }}
                >
                  <option class="authors-note-role-option" value="system">{t('authorsNote.roleSystem')}</option>
                  <option class="authors-note-role-option" value="user">{t('authorsNote.roleUser')}</option>
                  <option class="authors-note-role-option" value="assistant">{t('authorsNote.roleAssistant')}</option>
                </select>
              </label>
            </div>
          </Show>

          <label class="authors-note-interval-label">
            {t('authorsNote.intervalLabel')}
            <input
              class="authors-note-interval-input"
              type="number"
              min={0}
              max={100}
              value={interval()}
              onInput={(e) => {
                setInterval(Math.max(0, parseInt(e.currentTarget.value, 10) || 0));
                scheduleAutoSave();
              }}
            />
          </label>

          <div class="modal-actions">
            <button class="authors-note-close-btn" type="button" onClick={close}>
              {t('common.close')}
            </button>
            <Show when={savedIndicator()}>
              <span class="save-indicator">{t('authorsNote.saved')}</span>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
