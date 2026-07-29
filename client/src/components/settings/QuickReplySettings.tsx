import { createSignal, Show, For } from 'solid-js';
import { bus } from '../../bus/WebSocketBus.js';
import { state } from '../../stores/serverStore.js';
import type { QuickReply } from '@tamari/types';
import { QuickReplyEditor } from '../QuickReplyEditor.js';
import { useI18n } from '../../i18n/index.js';
import './QuickReplySettings.css';

export function QuickReplySettings() {
  const { t } = useI18n();
  const [showEditor, setShowEditor] = createSignal(false);
  const [editingQr, setEditingQr] = createSignal<QuickReply | undefined>(undefined);

  const globalQrs = () => state.quickReplies.filter((qr) => qr.scope === 'global');

  const openEditor = (qr?: QuickReply) => {
    setEditingQr(qr);
    setShowEditor(true);
  };

  return (
    <div class="quick-reply-settings">
      <Show when={globalQrs().length === 0}>
        <p class="settings-hint">{t('settings.quickReplies.emptyHint')}</p>
      </Show>

      <div class="qr-settings-list">
        <For each={globalQrs()}>
          {(qr) => (
            <div id={qr.id} class="qr-settings-row">
              <span class="qr-settings-label">
                {qr.icon} {qr.label}
              </span>
              <span class="qr-settings-lang">{qr.language}</span>
              <div class="qr-settings-actions">
                <button type="button" class="btn btn-ghost btn-sm" onClick={() => openEditor(qr)}>
                  {t('common.edit')}
                </button>
                <button type="button" class="btn btn-danger btn-sm" onClick={() => bus.send({ type: 'quickreply.delete', id: qr.id })}>
                  {t('common.delete')}
                </button>
              </div>
            </div>
          )}
        </For>
      </div>

      <button class="btn btn-primary primary-btn mt-md" type="button" onClick={() => openEditor()}>
        <i class="bi bi-plus-lg" /> {t('settings.quickReplies.add')}
      </button>

      <Show when={showEditor()}>
        <QuickReplyEditor qr={editingQr()} chatId={''} characterId={''} onClose={() => setShowEditor(false)} />
      </Show>
    </div>
  );
}
