import { createSignal, Show, For, createEffect } from 'solid-js';
import { bus } from '../bus/WebSocketBus.js';
import { state } from '../stores/serverStore.js';
import { activeChatId } from '../stores/uiStore.js';
import type { QuickReply } from '@tamari/types';
import { QuickReplyEditor } from './QuickReplyEditor.js';
import { useI18n } from '../i18n/index.js';
import './QuickReplyBar.css';

const startupFired = new Set<string>();

export function QuickReplyBar() {
  const { t } = useI18n();
  const [showEditor, setShowEditor] = createSignal(false);
  const [editingQr, setEditingQr] = createSignal<QuickReply | undefined>(undefined);

  const chatId = () => activeChatId();
  const characterId = () => state.activeChat?.characterId ?? null;

  createEffect(() => {
    const id = chatId();
    if (!id) return;
    // One merged request: the server returns the union of chat + character + global
    // replies for this view, and we wholesale-replace state.quickReplies (AGENTS.md §5).
    bus.send({ type: 'quickreply.listForChat', chatId: id });

    // Fire startup trigger once per chat per session
    if (!startupFired.has(id)) {
      startupFired.add(id);
      bus.send({ type: 'quickreply.runStartup', chatId: id });
    }
  });

  const quickReplies = () => {
    const id = chatId();
    const charId = characterId();
    return state.quickReplies.filter(
      (qr) =>
        (qr.scope === 'chat' && qr.scopeId === id) ||
        (qr.scope === 'character' && qr.scopeId === charId) ||
        (qr.scope === 'global' && qr.scopeId === ''),
    );
  };

  const executeQr = (qr: QuickReply) => {
    const id = chatId();
    if (!id) return;
    bus.send({ type: 'quickreply.execute', id: qr.id, chatId: id });
  };

  return (
    <Show when={state.settings['showQuickReplyBar'] !== false}>
      <div class="quick-reply-bar">
        <For each={quickReplies()}>
          {(qr) => (
            <button
              id={qr.id}
              class="quick-reply-btn"
              style={qr.color ? { '--qr-color': qr.color } : undefined}
              onClick={() => executeQr(qr)}
              onContextMenu={(e) => {
                e.preventDefault();
                setEditingQr(qr);
                setShowEditor(true);
              }}
              title={qr.script}
            >
              {qr.icon && <span class="qr-icon">{qr.icon}</span>}
              <span class="qr-label">{qr.label}</span>
              {qr.language !== 'lua' && <span class="qr-legacy">⚠</span>}
            </button>
          )}
        </For>
        <button
          class="quick-reply-btn quick-reply-add"
          onClick={() => {
            setEditingQr(undefined);
            setShowEditor(true);
          }}
          title={t('quickReply.addQuickReply')} aria-label={t('quickReply.addQuickReply')}
        >
          +
        </button>
      </div>

      <Show when={showEditor()}>
        <QuickReplyEditor
          qr={editingQr()}
          chatId={chatId() ?? ''}
          characterId={characterId() ?? ''}
          onClose={() => setShowEditor(false)}
        />
      </Show>
    </Show>
  );
}
