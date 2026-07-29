import { Show, createSignal, For, createEffect } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { setActiveChatId } from '../stores/uiStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { confirmPopup } from '../stores/popupStore.js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';

export interface CheckpointsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function CheckpointsPanel(props: CheckpointsPanelProps) {
  const { t } = useI18n();
  const [showConfirmDelete, setShowConfirmDelete] = createSignal<string | null>(null);

  const activeChat = () => state.activeChat;

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

  const checkpoints = () => {
    const chat = activeChat();
    if (!chat) return [];
    return state.chats
      .filter((c) => c.forkedFromChatId === chat.id)
      .sort((a, b) => b.createdAt - a.createdAt);
  };

  const createCheckpoint = () => {
    const chat = activeChat();
    if (!chat) return;
    const messageId = chat.activeChildId ?? chat.headMessageId;
    if (messageId === null) {
      // no messages to checkpoint
      return;
    }
    bus.send({
      type: 'chat.softFork',
      chatId: chat.id,
      messageId,
      name: t('chatHeader.checkpointName', { name: chat.name }),
    });
  };

  const restoreCheckpoint = (checkpointId: string) => {
    // Set the local active chat first — the chat.snapshot handler ignores
    // snapshots for chats that aren't active (serverStore), so sending
    // chat.select alone makes restore a silent no-op.
    setActiveChatId(checkpointId);
    bus.send({ type: 'chat.select', chatId: checkpointId, limit: 30 });
    close();
  };

  const deleteCheckpoint = async (checkpointId: string) => {
    if (showConfirmDelete() === checkpointId) {
      bus.send({ type: 'chat.delete', chatId: checkpointId });
      setShowConfirmDelete(null);
      return;
    }
    if (!(await confirmPopup(t('chatHeader.deleteCheckpointConfirm')))) return;
    bus.send({ type: 'chat.delete', chatId: checkpointId });
  };

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && close()}>
        <div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="checkpoints-panel-title" onKeyDown={(e) => trapFocus(e.currentTarget, e)}>
          <h2 class="modal-title" id="checkpoints-panel-title">
            <i class="bi bi-bookmark" /> {t('chatHeader.checkpoints')}
          </h2>

          <button class="btn btn-primary primary-btn mb-md" onClick={createCheckpoint} type="button">
            <i class="bi bi-plus-lg" /> {t('chatHeader.createCheckpoint')}
          </button>

          <Show when={checkpoints().length > 0} fallback={<p class="text-muted">{t('chatHeader.noCheckpoints')}</p>}>
            <div class="worldinfo-list">
              <For each={checkpoints()}>
                {(cp) => (
                  <div id={cp.id} class="selectable-item worldinfo-item">
                    <div class="checkpoint-info">
                      <div class="worldinfo-name">{cp.name}</div>
                      <div class="worldinfo-meta">
                        {t('chatHeader.checkpointMeta', {
                          id: cp.forkedAtMessageId ?? 0,
                          date: new Date(cp.createdAt * 1000).toLocaleString(),
                        })}
                      </div>
                    </div>
                    <div class="section-actions">
                      <button class="icon-btn small" onClick={() => restoreCheckpoint(cp.id)} title={t('chatHeader.restore')} aria-label={t('chatHeader.restore')} type="button">
                        <i class="bi bi-box-arrow-in-right" />
                      </button>
                      <button
                        class="icon-btn small danger"
                        onClick={() => deleteCheckpoint(cp.id)}
                        title={t('common.delete')} aria-label={t('common.delete')}
                        type="button"
                      >
                        <i class="bi bi-trash" />
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="modal-actions">
            <button class="btn" type="button" onClick={close}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
