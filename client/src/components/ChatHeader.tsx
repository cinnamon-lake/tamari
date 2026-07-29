import { Show, createSignal, createMemo, createEffect, onMount, onCleanup, on } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { chatSearchQuery, setChatSearchQuery } from '../stores/uiStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { confirmPopup } from '../stores/popupStore.js';
import { authenticatedUrl } from '../lib/apiFetch.js';
import { AuthorsNotePanel } from './AuthorsNotePanel.js';
import { CheckpointsPanel } from './CheckpointsPanel.js';
import { useI18n } from '../i18n/index.js';
import './ChatHeader.css';

export function ChatHeader() {
  const { t } = useI18n();
  const [showMenu, setShowMenu] = createSignal(false);
  const [showAN, setShowAN] = createSignal(false);
  const [showCheckpoints, setShowCheckpoints] = createSignal(false);
  const [showSearch, setShowSearch] = createSignal(false);

  const activeChat = createMemo(() => state.activeChat);

  // Close the ⋮ dropdown on outside pointer-down and on Escape — previously it
  // only closed when a menu item was picked, so it lingered over modals and
  // across chat switches.
  let menuRef: HTMLDivElement | undefined;
  onMount(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!showMenu()) return;
      if (menuRef && e.target instanceof Node && !menuRef.contains(e.target)) {
        setShowMenu(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMenu(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    });
  });

  // Switching chats closes the menu too.
  createEffect(on(() => activeChat()?.id, () => setShowMenu(false), { defer: true }));

  const activeCharacter = createMemo(() => {
    const chat = activeChat();
    if (!chat?.characterId) return null;
    return state.chatCharacter;
  });

  const title = createMemo(() => {
    const char = activeCharacter();
    if (char) return char.name;
    return activeChat()?.name ?? t('chatHeader.defaultChatName');
  });

  const subtitle = createMemo(() => {
    const char = activeCharacter();
    const chatName = activeChat()?.name;
    if (char && chatName) return chatName;
    return null;
  });

  const deleteChat = async () => {
    const chatId = state.activeChat?.id;
    if (!chatId) return;
    if (!(await confirmPopup(t('chatHeader.deleteChatConfirm')))) return;
    bus.send({ type: 'chat.delete', chatId });
    setShowMenu(false);
  };

  const exportChat = (format: 'jsonl' | 'txt') => {
    const chat = state.activeChat;
    if (!chat) return;
    const url = format === 'txt' ? chat.txtExportUrl : chat.jsonlExportUrl;
    if (!url) return;
    window.open(authenticatedUrl(url), '_blank');
    setShowMenu(false);
  };

  return (
    <header class="chat-header">
      <Show when={state.activeChat} fallback={<div class="chat-header-placeholder" />}>
        <div class="chat-header-info">
          <h2 class="chat-header-title" title={title()}>{title()}</h2>
          <Show when={subtitle()}>
            <span class="chat-header-subtitle">{subtitle()}</span>
          </Show>
        </div>
        <div class="chat-header-actions">
          <Show when={showSearch()}>
            <input
              class="search-input chat-search"
              type="text"
              autocomplete="off"
              placeholder={t('chatHeader.searchMessagesPlaceholder')}
              aria-label={t('chatHeader.searchMessages')}
              value={chatSearchQuery()}
              onInput={(e) => setChatSearchQuery(e.currentTarget.value)}
              autofocus
            />
          </Show>
          <button
            class={`icon-btn ${showSearch() ? 'active' : ''}`}
            onClick={() => {
              setShowSearch((v) => !v);
              if (showSearch()) setChatSearchQuery('');
            }}
            title={t('chatHeader.searchMessages')} aria-label={t('chatHeader.searchMessages')}
            aria-expanded={showSearch()}
            aria-controls="chat-search-input"
            type="button"
          >
            <i class="bi bi-search" />
          </button>
          <div class="chat-header-menu" ref={menuRef}>
            <button class="icon-btn" onClick={() => setShowMenu((v) => !v)} title={t('chatHeader.menu')} aria-label={t('chatHeader.menu')} aria-expanded={showMenu()} aria-controls="chat-header-dropdown" type="button">
              <i class="bi bi-three-dots-vertical" />
            </button>
            <Show when={showMenu()}>
              <div class="dropdown-menu" id="chat-header-dropdown">
                <button class="dropdown-item" onClick={() => exportChat('jsonl')} type="button">
                  <i class="bi bi-download" /> {t('chatHeader.exportJsonl')}
                </button>
                <button class="dropdown-item" onClick={() => exportChat('txt')} type="button">
                  <i class="bi bi-file-text" /> {t('chatHeader.exportTxt')}
                </button>
                <button
                  class="dropdown-item"
                  onClick={() => {
                    setShowAN(true);
                    setShowMenu(false);
                  }}
                  type="button"
                >
                  <i class="bi bi-journal-text" /> {t('chatHeader.authorsNote')}
                </button>
                <button
                  class="dropdown-item"
                  onClick={() => {
                    setShowCheckpoints(true);
                    setShowMenu(false);
                  }}
                  type="button"
                >
                  <i class="bi bi-bookmark" /> {t('chatHeader.checkpoints')}
                </button>
                <button class="dropdown-item danger" onClick={deleteChat} type="button">
                  <i class="bi bi-trash" /> {t('chatHeader.deleteChat')}
                </button>
              </div>
            </Show>
          </div>
        </div>
      </Show>
      <AuthorsNotePanel open={showAN()} onClose={() => setShowAN(false)} />
      <CheckpointsPanel open={showCheckpoints()} onClose={() => setShowCheckpoints(false)} />
    </header>
  );
}
