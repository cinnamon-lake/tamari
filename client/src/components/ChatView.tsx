import { Show, For, Switch, Match, createSignal, createEffect, createMemo, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { onEnterActivate, trapFocus } from '../lib/focusUtils.js';
import { serializeResponseForm } from '../lib/responseForm.js';
import { materializeChat } from '../lib/materializeChat.js';
import type { JSX } from 'solid-js';
import { state } from '../stores/serverStore.js';
import {
  activeChatId,
  loadingOlderChatId,
  setLoadingOlderChatId,
  chatSearchQuery,
  setChatSearchQuery,
} from '../stores/uiStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { confirmPopup } from '../stores/popupStore.js';
import type { Message } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import { GroupChatPanel } from './GroupChatPanel.js';

import { openLightbox } from '../stores/lightboxStore.js';
import { appendPendingDropFiles } from '../stores/dndStore.js';
import { SafeImage } from './SafeImage.js';
import { AudioPlayer } from './AudioPlayer.js';

import { getToolRenderer } from './tool-renderers/index.js';
import { MessagePartsView } from './MessagePartsView.js';
import { useI18n } from '../i18n/index.js';
import './ChatView.css';

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function getVisibleMessages(
  activeChat: import('@tamari/types').Chat | null,
  searchQuery: string,
  showHidden: boolean,
): Message[] {
  if (!activeChat) return [];
  let msgs = state.messages[activeChat.id] ?? [];
  if (!showHidden) msgs = msgs.filter((m) => !m.extra?.hidden);
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    msgs = msgs.filter((m) => getMessageText(m.extra?.parts).toLowerCase().includes(q));
  }
  return msgs;
}

export function ChatView() {
  const { t } = useI18n();
  const [showGroupPanel, setShowGroupPanel] = createSignal(false);
  const [scrollToBottomTrigger, setScrollToBottomTrigger] = createSignal(false);
  const [isAtBottom, setIsAtBottom] = createSignal(true);
  const [dragOver, setDragOver] = createSignal(false);

  const showHidden = createMemo(() => Boolean(state.settings['showHiddenMessages']));

  // Clear search when switching chats
  createEffect(() => {
    void activeChatId();
    setChatSearchQuery('');
  });

  const messages = createMemo(() => getVisibleMessages(state.activeChat, chatSearchQuery(), showHidden()));

  const [displayLimit, setDisplayLimit] = createSignal(50);
  const visibleMessages = createMemo(() => messages().slice(-displayLimit()));
  // Iterate stable message IDs (not message objects) so a store update —
  // message.snapshot / part.snapshot — re-renders inside the live bubble
  // instead of remounting it.
  const visibleMessageIds = createMemo(() => visibleMessages().map((m) => m.id));
  const canLoadMore = createMemo(() => {
    const msgs = messages();
    const first = msgs[0];
    return first !== undefined && first.parentId !== null;
  });

  const activeChat = createMemo(() => state.activeChat);

  const activeChild = createMemo(() => {
    const chat = activeChat();
    if (!chat?.activeChildId) return undefined;
    const child = state.swipes[chat.id]?.find((m) => m.id === chat.activeChildId);
    const bulk = state.messages[chat.id] ?? [];
    // If the active child is also the head (i.e., it's in the bulk), don't return it as a separate active child.
    if (bulk.some((m) => m.id === chat.activeChildId)) return undefined;
    return child;
  });

  const activeCharacter = createMemo(() => {
    const chat = activeChat();
    if (!chat?.characterId) return undefined;
    return state.chatCharacter ?? undefined;
  });

  const isLoadingOlder = createMemo(() => {
    const chat = state.activeChat;
    if (!chat) return false;
    return loadingOlderChatId() === chat.id;
  });

  const isStreaming = createMemo(() => state.generation.status === 'streaming' && state.generation.chatId === state.activeChat?.id);

  const isGroupChat = createMemo(() => activeChat()?.characterId === null);

  const greetings = createMemo(() => {
    const char = activeCharacter();
    if (!char) return [];
    const list: string[] = [];
    if (char.firstMes?.trim()) list.push(char.firstMes.trim());
    for (const alt of char.alternateGreetings ?? []) {
      if (alt?.trim()) list.push(alt.trim());
    }
    return list;
  });

  const showVirtualGreetings = createMemo(() => {
    const chat = activeChat();
    if (!chat || chat.characterId === null) return false;
    // A character with no greeting renders nothing — not an empty bubble.
    if (greetings().length === 0) return false;
    const msgs = state.messages[chat.id];
    return msgs !== undefined && msgs.length === 0 && !chat.materialized;
  });

  const selectedGreetingIndex = createMemo(() => {
    const chat = activeChat();
    return Number(chat?.metadata?.selectedGreetingIndex ?? 0);
  });

  const cycleGreeting = (direction: 'left' | 'right') => {
    const chat = activeChat();
    if (!chat) return;
    const list = greetings();
    if (list.length <= 1) return;
    const current = selectedGreetingIndex();
    const next = direction === 'right' ? (current + 1) % list.length : (current - 1 + list.length) % list.length;
    bus.send({
      type: 'chat.update',
      chatId: chat.id,
      patch: { metadata: { ...chat.metadata, selectedGreetingIndex: next } },
    });
  };

  const loadOlderMessages = () => {
    const chatId = state.activeChat?.id;
    if (!chatId || isLoadingOlder()) return;

    const msgs = messages();
    if (msgs.length === 0) return;

    const oldest = msgs[0];
    // Reached the root of the message tree; nothing older exists.
    if (!oldest || oldest.parentId === null) return;

    const limit = Number(state.settings['chatMessageLoadLimit'] ?? 30);

    setLoadingOlderChatId(chatId);
    bus.send({
      type: 'chat.load',
      chatId,
      beforeId: oldest.id,
      offset: 1,
      limit,
    });
  };

  const autoScrollEnabled = createMemo(() => state.settings['autoScrollToBottom'] !== false);

  let messagesRef: HTMLDivElement | undefined;

  const handleMessagesScroll = () => {
    if (!messagesRef) return;
    const { scrollTop, clientHeight, scrollHeight } = messagesRef;
    setIsAtBottom(scrollHeight - scrollTop - clientHeight < 40);
  };

  createEffect(() => {
    if (scrollToBottomTrigger() && messagesRef) {
      messagesRef.scrollTop = messagesRef.scrollHeight;
    }
  });

  createEffect(() => {
    const _msgs = visibleMessages();
    void _msgs.length;
    if (autoScrollEnabled() && isAtBottom() && messagesRef) {
      messagesRef.scrollTop = messagesRef.scrollHeight;
    }
  });

  // Scroll to bottom when switching chats
  createEffect(() => {
    const chatId = state.activeChat?.id;
    if (chatId && autoScrollEnabled()) {
      setScrollToBottomTrigger(true);
      setTimeout(() => setScrollToBottomTrigger(false), 100);
    }
  });

  // Auto-scroll trigger while streaming
  createEffect(() => {
    void state.generation.streamingText;
    if (isStreaming() && autoScrollEnabled()) {
      setScrollToBottomTrigger(true);
      setTimeout(() => setScrollToBottomTrigger(false), 100);
    }
  });

  // When streaming ends, the finalized bubble can still grow (message chrome,
  // swipe controls) after the last stream-driven scroll — pin once more so the
  // view actually lands at the bottom instead of stopping a few lines short.
  let wasStreaming = false;
  createEffect(() => {
    const streaming = isStreaming();
    if (wasStreaming && !streaming && autoScrollEnabled() && isAtBottom() && messagesRef) {
      messagesRef.scrollTop = messagesRef.scrollHeight;
    }
    wasStreaming = streaming;
  });

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer?.types.includes('Files')) {
      setDragOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) {
      appendPendingDropFiles(files);
    }
  };

  const greetingMessage = createMemo((): Message => {
    const char = activeCharacter();
    return {
      id: -1,
      parentId: null,
      role: 'assistant',
      extra: { characterId: char?.id, parts: [{ type: 'text', text: state.greeting ?? '' }] },
      createdAt: 0,
      updatedAt: 0,
      renderedHtml: state.greetingHtml != null ? [state.greetingHtml] : undefined,
    };
  });

  return (
    <div
      class="chat-view"
      classList={{ 'drag-over': dragOver() }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Show
        when={state.activeChat}
        fallback={
          <div class="chat-empty">
            <i class="bi bi-chat-square-text text-2xl opacity-40" />
            <Show
              when={state.characters.length === 0}
              fallback={<span class="empty-state-text">{t('chat.selectChatToStart')}</span>}
            >
              <span class="empty-state-text">{t('chat.emptyNoCharacters')}</span>
              <button
                class="btn btn-primary"
                onClick={() => bus.send({ type: 'character.create', data: { name: 'New Character' } })}
                type="button"
              >
                {t('chat.createFirstCharacter')}
              </button>
            </Show>
          </div>
        }
      >
        <Show when={isGroupChat()}>
          <div class="group-chat-toolbar">
            <span class="group-chat-badge">
              <i class="bi bi-people" /> {t('chat.groupChat')}
            </span>
            <button class="text-btn small" onClick={() => setShowGroupPanel(true)} type="button">
              {t('chat.manageMembers')}
            </button>
          </div>
        </Show>
        <div
          class="virtual-list messages"
          ref={(el) => {
            if (el) {
              messagesRef = el;
              el.addEventListener('scroll', handleMessagesScroll, { passive: true });
              onCleanup(() => el.removeEventListener('scroll', handleMessagesScroll));
            }
          }}
        >
          <Show when={!showVirtualGreetings() && canLoadMore()}>
            <button
              class="load-more-btn"
              onClick={() => {
                loadOlderMessages();
                setDisplayLimit((l) => l + 50);
              }}
              disabled={isLoadingOlder()}
              type="button"
            >
              {isLoadingOlder() ? t('chat.loadingOlderMessages') : t('chat.loadMoreMessages')}
            </button>
          </Show>
          <div class="virtual-list-content">
            <Show
              when={showVirtualGreetings()}
              fallback={
                <>
                  <For each={visibleMessageIds()}>
                    {(id) => {
                      return <MessageBubble id={String(id)} messageId={id} isLast={false} />;
                    }}
                  </For>
                  <Show when={activeChild()}>
                    {(child) => <MessageBubble id={String(child().id)} messageId={child().id} isLast={true} />}
                  </Show>
                </>
              }
            >
              <MessageBubble
                messageId={-1}
                fallbackMessage={greetingMessage()}
                isLast={true}
                readOnly
                onSwipeLeft={greetings().length > 1 ? () => cycleGreeting('left') : undefined}
                onSwipeRight={greetings().length > 1 ? () => cycleGreeting('right') : undefined}
                swipeIndex={selectedGreetingIndex() + 1}
                swipeTotal={greetings().length}
              />
            </Show>
          </div>
        </div>
        <Show when={!isAtBottom() && state.activeChat}>
          <button
            class="scroll-to-bottom-btn"
            onClick={() => {
              setScrollToBottomTrigger(true);
              setTimeout(() => setScrollToBottomTrigger(false), 100);
            }}
            type="button"
            title={t('chat.scrollToBottom')} aria-label={t('chat.scrollToBottom')}
          >
            <i class="bi bi-arrow-down" />
          </button>
        </Show>
      </Show>
      <Show when={showGroupPanel()}>
        <Show when={state.activeChat}>
          {(chat) => <GroupChatPanel chatId={chat().id} onClose={() => setShowGroupPanel(false)} />}
        </Show>
      </Show>
    </div>
  );
}

interface MessageBubbleShellProps {
  id?: string;
  role: string;
  avatarUrl?: string;
  name: string;
  /** Per-part content view (MessagePartsView), rendered as the bubble body. */
  content?: JSX.Element;
  isStreamingTarget?: boolean;
  streamFadeIn?: boolean;
  hideAvatar?: boolean;
  hideName?: boolean;
  hidden?: boolean;
  headerMeta?: JSX.Element;
  swipeActions?: JSX.Element;
  swipePicker?: JSX.Element;
  actions?: JSX.Element;
  bodyExtra?: JSX.Element;
  suppressContent?: boolean;
  isEditing?: boolean;
  rawText?: string;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}

const SWIPE_THRESHOLD = 50;
const SWIPE_TIMEOUT_MS = 600;

function MessageBubbleShell(props: MessageBubbleShellProps) {
  const { t } = useI18n();
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let tracking = false;

  const isSwipeable = () => Boolean(props.onSwipeLeft || props.onSwipeRight);

  const encodedText = createMemo(() => {
    if (!state.settings['encodeTags']) return '';
    const base = props.rawText ?? '';
    const stream = props.isStreamingTarget ? state.generation.streamingText : '';
    const text = base + stream;
    return text ? escapeHtml(text) : '';
  });

  const onTouchStart = (e: TouchEvent) => {
    if (!isSwipeable()) return;
    const touch = e.touches[0];
    if (!touch) return;
    startX = touch.clientX;
    startY = touch.clientY;
    startTime = Date.now();
    tracking = true;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!tracking) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    // Once the gesture is clearly horizontal, take over so the browser
    // doesn't navigate back/forward on mobile.
    if (Math.abs(dx) > SWIPE_THRESHOLD * 0.6 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      e.preventDefault();
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    const dt = Date.now() - startTime;
    if (
      dt < SWIPE_TIMEOUT_MS &&
      Math.abs(dx) > SWIPE_THRESHOLD &&
      Math.abs(dx) > Math.abs(dy) * 1.5
    ) {
      if (dx < 0 && props.onSwipeLeft) {
        props.onSwipeLeft();
      } else if (dx > 0 && props.onSwipeRight) {
        props.onSwipeRight();
      }
    }
  };

  const onTouchCancel = () => {
    tracking = false;
  };

  return (
    <div
      id={props.id}
      class={`message-bubble ${props.role}${props.isStreamingTarget ? ' streaming' : ''}${props.hidden ? ' hidden-message' : ''}${props.isEditing ? ' editing' : ''}${props.hideAvatar ? ' hide-avatar' : ''}${props.hideName ? ' hide-name' : ''}${isSwipeable() ? ' swipeable' : ''}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <div class="message-header">
        <div class="message-header-left">
          <Show when={!props.hideAvatar}>
            <SafeImage src={props.avatarUrl} class="message-avatar" loading="lazy" />
          </Show>
          <Show when={!props.hideName}>
            <span class="message-role">{props.name}</span>
          </Show>
          {props.headerMeta}
          {props.swipeActions}
        </div>
        {props.swipePicker}
        <Show when={!props.isEditing}>
          <div class="message-actions-burger">
            <button class="icon-btn" title={t('chat.actions')} aria-label={t('chat.actions')} type="button">
              <i class="bi bi-three-dots-vertical" />
            </button>
          </div>
          <div class="message-header-right">
            <div class="message-actions">{props.actions}</div>
          </div>
        </Show>
      </div>
      {props.bodyExtra}
      <Show when={!props.suppressContent}>
        <Show when={encodedText()} fallback={props.content}>
          <pre class="encoded-tags">
            <code class="encoded-tags-code">{encodedText()}</code>
          </pre>
        </Show>
      </Show>
      <Show when={props.isStreamingTarget && !encodedText()}>
        <span class="cursor">▋</span>
      </Show>
    </div>
  );
}

function MessageBubble(props: {
  id?: string;
  /** Stable message id — the live message is looked up in the store so
      part.snapshot / message.snapshot updates re-render in place instead of
      remounting the bubble. */
  messageId: number;
  /** Message object for bubbles that don't live in the store (the virtual
      greeting, id -1). */
  fallbackMessage?: Message;
  isLast: boolean;
  readOnly?: boolean;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  /** Explicit "n/total" for synthetic swipe sets (alternate greetings) that
      have no server-side swipes list — drives the counter display. */
  swipeIndex?: number;
  swipeTotal?: number;
}) {
  const message = createMemo<Message>(() => {
    const chatId = state.activeChat?.id ?? activeChatId() ?? '';
    const live =
      state.messages[chatId]?.find((m) => m.id === props.messageId) ??
      state.swipes[chatId]?.find((m) => m.id === props.messageId);
    if (live) return live;
    if (props.fallbackMessage) return props.fallbackMessage;
    return { id: props.messageId, parentId: null, role: 'assistant', extra: {}, createdAt: 0, updatedAt: 0 };
  });

  const [editingPartIndex, setEditingPartIndex] = createSignal<number | null>(null);
  const [editText, setEditText] = createSignal('');
  const { t } = useI18n();

  const parts = createMemo(() => message().extra?.parts ?? []);
  const editing = () => editingPartIndex() !== null;

  const isUser = () => message().role === 'user';
  const isAssistant = () => message().role === 'assistant';
  const isGroupChat = () => state.activeChat?.characterId === null;

  const isEdited = () => {
    return typeof message().extra?.editedAt === 'number';
  };

  const isStreamingTarget = createMemo(() =>
    state.generation.status === 'streaming' &&
    state.generation.chatId === (activeChatId() ?? '') &&
    state.generation.targetMessageId === message().id
  );

  const streamFadeInEnabled = createMemo(
    () => state.settings['streamFadeIn'] !== false && !state.settings['reducedMotion'],
  );

  const hideAvatar = createMemo(() => Boolean(state.settings['hideChatAvatars']));
  const hideName = createMemo(() => Boolean(state.settings['hideChatNames']));

  const hasParts = createMemo(() => parts().length > 0);
  const hasRenderedHtml = createMemo(() => (message().renderedHtml ?? []).some((h) => h != null && h !== ''));

  const attachments = createMemo(() => {
    return message().extra?.attachments ?? [];
  });

  const avatarUrl = createMemo(() => {
    if (isAssistant()) {
      // Non-group chats: server provides the canonical character in the snapshot
      if (state.chatCharacter) {
        return state.chatCharacter.thumbnailUrl ?? state.chatCharacter.avatarUrl ?? null;
      }
      // Group chats: server enriches messages with characterAvatarUrl.
      const enrichedUrl = message().extra?.characterAvatarUrl;
      if (typeof enrichedUrl === 'string') {
        return enrichedUrl;
      }
      return null;
    }
    if (isUser()) {
      // Server enriches messages with personaAvatarUrl; fall back to current active persona
      // for messages that haven't been enriched yet (e.g. newly created before next snapshot).
      const enrichedUrl = message().extra?.personaAvatarUrl;
      if (typeof enrichedUrl === 'string') {
        return enrichedUrl;
      }
      return state.chatPersona?.thumbnailUrl ?? state.chatPersona?.avatarUrl ?? null;
    }
    return null;
  });

  // Per-part editing: partIndex addresses one text part; an index one past the
  // end means "append a new text part" (message with no text part yet).
  const startEdit = (partIndex: number) => {
    const part = parts()[partIndex];
    setEditText(part && part.type === 'text' ? part.text : '');
    setEditingPartIndex(partIndex);
  };

  const firstTextPartIndex = () => parts().findIndex((p) => p.type === 'text');

  const saveEdit = () => {
    const idx = editingPartIndex();
    if (idx === null) return;
    bus.send({
      type: 'action.edit',
      chatId: activeChatId() ?? '',
      messageId: message().id,
      content: editText(),
      // Appending (index beyond the current parts) → omit partIndex; the
      // server appends a text part when none exists.
      ...(idx < parts().length ? { partIndex: idx } : {}),
    });
    setEditingPartIndex(null);
  };

  // Grow the edit box with its content (capped) instead of a fixed 9-row
  // height, so the Save/Cancel actions stay near the text being edited.
  const EDIT_AREA_MAX_HEIGHT = 320;
  const autoresizeEditArea = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, EDIT_AREA_MAX_HEIGHT)}px`;
  };

  const cancelEdit = () => {
    setEditingPartIndex(null);
  };

  const onEditKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveEdit();
    }
  };

  const onEditBlur = () => {
    if (state.settings['autoSaveMessageEdits']) {
      saveEdit();
    }
  };

  const renderEditArea = (_partIndex: number, _partText: string): JSX.Element => (
    <div class="message-edit">
      <textarea class="edit-textarea"
        ref={(el) => {
          queueMicrotask(() => {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
            autoresizeEditArea(el);
            el.closest('.message-bubble')?.scrollIntoView({ block: 'nearest' });
          });
        }}
        rows={3}
        value={editText()}
        onInput={(e) => {
          setEditText(e.currentTarget.value);
          autoresizeEditArea(e.currentTarget);
          // As the box grows, keep it (and the Save/Cancel row below it)
          // in view — the caret alone can leave the actions clipped.
          e.currentTarget.closest('.message-edit')?.scrollIntoView({ block: 'nearest' });
        }}
        onKeyDown={onEditKeyDown}
        onBlur={onEditBlur}
      />
      <div class="edit-actions">
        <span class="text-xs text-muted">{t('chat.editHint')}</span>
        <button class="btn btn-ghost" onClick={cancelEdit}>{t('common.cancel')}</button>
        <button class="btn btn-primary" onClick={saveEdit}>{t('common.save')}</button>
      </div>
    </div>
  );

  const deleteMessage = async () => {
    if (state.settings['confirmMessageDelete']) {
      if (!(await confirmPopup(t('chat.deleteMessageConfirm')))) return;
    }
    bus.send({
      type: 'action.delete',
      chatId: activeChatId() ?? '',
      messageId: message().id,
    });
  };

  const hideMessage = () => {
    bus.send({
      type: 'action.hide',
      chatId: activeChatId() ?? '',
      messageId: message().id,
    });
  };

  const unhideMessage = () => {
    bus.send({
      type: 'action.unhide',
      chatId: activeChatId() ?? '',
      messageId: message().id,
    });
  };

  const regenerate = () => {
    bus.send({
      type: 'action.regenerate',
      chatId: activeChatId() ?? '',
      messageId: message().id,
    });
  };

  const forkMessage = () => {
    bus.send({
      type: state.settings['useSoftFork'] ? 'chat.softFork' : 'chat.hardFork',
      chatId: activeChatId() ?? '',
      messageId: message().id,
      name: t('chat.forkOf', { name: state.activeChat?.name || t('chat.defaultChatName') }),
    });
  };

  const continueMessage = () => {
    bus.send({
      type: 'action.continue',
      chatId: activeChatId() ?? '',
    });
  };

  const handleSwipe = (direction: 'left' | 'right') => {
    if (direction === 'left' && props.onSwipeLeft) {
      props.onSwipeLeft();
      return;
    }
    if (direction === 'right' && props.onSwipeRight) {
      props.onSwipeRight();
      return;
    }
    bus.send({
      type: 'action.swipe',
      chatId: activeChatId() ?? '',
      messageId: message().id,
      direction,
    });
  };

  const swipeInfo = createMemo(() => {
    if (props.swipeIndex !== undefined && props.swipeTotal !== undefined) {
      return { swipeIndex: props.swipeIndex, swipeTotal: props.swipeTotal };
    }
    const swipes = state.swipes[activeChatId() ?? ''] ?? [];
    const idx = swipes.findIndex((s) => s.id === message().id);
    if (idx === -1) return undefined;
    return { swipeIndex: idx + 1, swipeTotal: swipes.length };
  });

  // Explicit info (alternate greetings) has no server-side swipes to pick
  // from — the counter is display-only there, no picker.
  const hasExplicitSwipeInfo = () => props.swipeIndex !== undefined && props.swipeTotal !== undefined;

  const [showSwipePicker, setShowSwipePicker] = createSignal(false);

  const selectSwipe = (messageId: number) => {
    bus.send({ type: 'chat.update', chatId: activeChatId() ?? '', patch: { activeChildId: messageId } });
    setShowSwipePicker(false);
  };

  const forkAtSwipe = (messageId: number) => {
    bus.send({ type: 'chat.softFork', chatId: activeChatId() ?? '', messageId, name: `Swipe ${messageId}` });
    setShowSwipePicker(false);
  };

  const isSwipeable = createMemo(
    () =>
      isAssistant() &&
      !editing() &&
      (props.isLast ||
        (state.settings['swipeNumbersOnAllMessages'] && (swipeInfo()?.swipeTotal ?? 0) > 1)),
  );

  const messageName = createMemo(() => {
    if (message().role === 'assistant') {
      const enrichedName = message().extra?.characterName;
      if (typeof enrichedName === 'string') return enrichedName;
      return state.chatCharacter?.name ?? t('chat.role.character');
    }
    if (message().role === 'user') {
      const enrichedName = message().extra?.personaName;
      if (typeof enrichedName === 'string') return enrichedName;
      return state.chatPersona?.name ?? t('chat.role.user');
    }
    if (message().role === 'tool') {
      const toolName = message().extra?.toolName;
      if (typeof toolName === 'string') return t('chat.role.toolWithName', { name: toolName });
      return t('chat.role.tool');
    }
    return message().role;
  });

  const onContentClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // Layer-3 button protocol (docs/design/scriptable-layers.md): a
    // <button data-post-response="..."> inside message HTML posts the
    // attribute value as the user's next message, then generates — the
    // chat log is the IPC channel (honest text, principle 3).
    // Buttons stay live in the read-only virtual greeting: readOnly there
    // only gates editing, and first_mes is exactly where cards put their
    // menus. The greeting is materialized first (chat.materialize, same as
    // MessageInput.send) — otherwise the posted message would land in an
    // unmaterialized chat and the greeting would never reach the DB.
    const postButton = target.closest('button[data-post-response]');
    if (postButton) {
      e.stopPropagation();
      const content = postButton.getAttribute('data-post-response') ?? '';
      const chatId = activeChatId();
      if (!content || !chatId) return;
      void materializeChat(chatId).then(() => {
        bus.send({ type: 'action.sendAndGenerate', chatId, content });
      });
      return;
    }
    if (target.tagName === 'IMG') {
      e.stopPropagation();
      openLightbox((target as HTMLImageElement).src);
      return;
    }
    if (!props.readOnly && state.settings['clickToEdit']) {
      // Per-part editing: edit the text part the click landed in; clicks on
      // non-text parts (reasoning, media, tool blocks) are ignored.
      const partEl = target.closest('[data-part-index]');
      const idx = partEl ? Number((partEl as HTMLElement).dataset.partIndex) : NaN;
      if (Number.isInteger(idx) && parts()[idx]?.type === 'text') {
        startEdit(idx);
      }
    }
  };

  const onContentSubmit = (e: SubmitEvent) => {
    // Layer-3 form protocol (docs/design/scriptable-layers.md §4 "Forms"):
    // a <form data-post-response="root"> inside message HTML serializes its
    // fields to a fenced XML block posted as the user's next message — same
    // channel, same honesty as the button protocol. Forms in messages are
    // decorative, so navigation is prevented unconditionally; only marked
    // forms post anything. Like buttons, forms stay submittable in the
    // read-only virtual greeting; the greeting is materialized first, same
    // as the button path above.
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    if (!form.hasAttribute('data-post-response')) return;
    const content = serializeResponseForm(form);
    const chatId = activeChatId();
    if (!content || !chatId) return;
    void materializeChat(chatId).then(() => {
      bus.send({ type: 'action.sendAndGenerate', chatId, content });
    });
  };

  return (
    <MessageBubbleShell
      id={props.id}
      role={message().role}
      avatarUrl={avatarUrl() ?? undefined}
      name={messageName()}
      content={
        <MessagePartsView
          message={message()}
          isStreamingTarget={!props.readOnly && isStreamingTarget()}
          streamFadeIn={streamFadeInEnabled()}
          widgetsDisabled={!props.isLast}
          editingPartIndex={editingPartIndex()}
          renderEditArea={renderEditArea}
          onContentClick={onContentClick}
          onContentSubmit={onContentSubmit}
        />
      }
      isStreamingTarget={!props.readOnly && isStreamingTarget()}
      streamFadeIn={streamFadeInEnabled()}
      hideAvatar={hideAvatar()}
      hideName={hideName()}
      hidden={Boolean(message().extra?.hidden)}
      headerMeta={
        <Show when={!props.readOnly}>
          <span class="message-timestamp">
            {new Date((message().createdAt ?? 0) * 1000).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <Show when={isEdited()}>
            <span class="message-edited-indicator" title={t('chat.meta.edited')}>
              {t('chat.meta.edited')}
            </span>
          </Show>
          <Show when={state.settings['messageTokenCountEnabled']}>
            <Show when={typeof message().extra?.tokenCount === 'number'}>
              <span class="message-token-count" title={t('chat.meta.tokenCount')}>
                {message().extra?.tokenCount}tk
              </span>
            </Show>
          </Show>
          <Show when={state.settings['timerEnabled']}>
            <Show when={typeof message().extra?.generationTime === 'number'}>
              <span class="message-timer" title={t('chat.meta.generationTime')}>
                {Number(message().extra?.generationTime).toFixed(1)}s
              </span>
            </Show>
          </Show>
          <Show when={state.settings['timestampModelIcon']}>
            <Show when={typeof message().extra?.model === 'string'}>
              <span class="message-model" title={t('chat.meta.model')}>
                {String(message().extra?.model)}
              </span>
            </Show>
          </Show>
          <Show when={state.settings['showMessageIds']}>
            <span class="message-id" title={t('chat.meta.messageId')}>
              #{message().id}
            </span>
          </Show>
        </Show>
      }
      swipeActions={
        <Show
          when={
            isAssistant() &&
            !editing() &&
            // No swipe chrome on single-swipe messages: the left arrow is dead
            // and the right one just duplicates Regenerate. Touch-swipe to
            // generate a variant still works (see isSwipeable). Explicit
            // handlers (alternate-greeting cycling) bypass the gate — the
            // virtual greeting bubble has no swipeInfo of its own.
            ((swipeInfo()?.swipeTotal ?? 0) > 1 || props.onSwipeLeft !== undefined || props.onSwipeRight !== undefined) &&
            (props.isLast || state.settings['swipeNumbersOnAllMessages'])
          }
        >
          <button class="action-btn swipe-btn" onClick={() => handleSwipe('left')} title={t('chat.swipeLeft')} aria-label={t('chat.swipeLeft')} type="button">
            <i class="bi bi-chevron-left" />
          </button>
          <Show when={!props.readOnly && (swipeInfo()?.swipeTotal ?? 0) > 1}>
            <button
              class="swipe-counter"
              onClick={() => setShowSwipePicker(true)}
              title={t('chat.swipePicker')}
              type="button"
            >
              {swipeInfo()?.swipeIndex}/{swipeInfo()?.swipeTotal}
            </button>
          </Show>
          {/* Synthetic swipe sets (alternate greetings): the bubble is
              readOnly and there are no server swipes to pick from, so show a
              static counter instead of the picker button. */}
          <Show when={props.readOnly && hasExplicitSwipeInfo() && (swipeInfo()?.swipeTotal ?? 0) > 1}>
            <span class="swipe-counter static">
              {swipeInfo()?.swipeIndex}/{swipeInfo()?.swipeTotal}
            </span>
          </Show>
          <button class="action-btn swipe-btn" onClick={() => handleSwipe('right')} title={t('chat.swipeRight')} aria-label={t('chat.swipeRight')} type="button">
            <i class="bi bi-chevron-right" />
          </button>
        </Show>
      }
      swipePicker={
        <Show when={showSwipePicker()}>
          <Portal>
            <div class="modal-overlay" onClick={() => setShowSwipePicker(false)}>
              <div
                class="modal settings-modal swipe-picker-modal"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => trapFocus(e.currentTarget, e)}
                role="dialog"
                aria-modal="true"
                aria-label={t('chat.swipePicker')}
              >
                <h2 class="modal-title">{t('chat.swipePicker')}</h2>
                <section class="settings-section">
                  <For each={state.swipes[activeChatId() ?? ''] ?? []}>
                    {(swipe, i) => {
                      const text = getMessageText(swipe.extra?.parts);
                      const preview = text.length > 120 ? text.slice(0, 120) + '…' : text;
                      const isActive = swipe.id === message().id;
                      return (
                        <div
                          class={`swipe-picker-row${isActive ? ' active' : ''}`}
                          role="button"
                          tabindex={0}
                          onKeyDown={onEnterActivate}
                          onClick={() => selectSwipe(swipe.id)}
                        >
                          <div class="swipe-picker-index">{i() + 1}</div>
                          <div class="swipe-picker-preview">{preview || <span class="text-muted">({t('chat.emptySwipe')})</span>}</div>
                          <div class="swipe-picker-actions">
                            <Show when={!isActive}>
                              <button
                                class="text-btn small"
                                type="button"
                                title={t('chat.forkAtMessage')} aria-label={t('chat.forkAtMessage')}
                                onClick={(e) => { e.stopPropagation(); forkAtSwipe(swipe.id); }}
                              >
                                <i class="bi bi-diagram-2" />
                              </button>
                            </Show>
                            <Show when={isActive}>
                              <span class="text-xs text-muted">{t('chat.swipeCurrent')}</span>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </section>
                <div class="modal-actions">
                  <button class="btn" onClick={() => setShowSwipePicker(false)}>{t('common.close')}</button>
                </div>
              </div>
            </div>
          </Portal>
        </Show>
      }
      actions={
        <Show when={!props.readOnly && !editing()}>
          <button
            class="action-btn"
            onClick={() => {
              const idx = firstTextPartIndex();
              startEdit(idx === -1 ? parts().length : idx);
            }}
            title={t('common.edit')} aria-label={t('common.edit')}
            type="button"
          >
            <i class="bi bi-pencil" />
          </button>
          <Show when={message().extra?.hidden}>
            <button class="action-btn" onClick={unhideMessage} title={t('chat.unhide')} aria-label={t('chat.unhide')} type="button">
              <i class="bi bi-eye" />
            </button>
          </Show>
          <Show when={!message().extra?.hidden}>
            <button class="action-btn" onClick={hideMessage} title={t('chat.hide')} aria-label={t('chat.hide')} type="button">
              <i class="bi bi-eye-slash" />
            </button>
          </Show>
          <Show when={!isGroupChat() || props.isLast}>
            <button class="action-btn" onClick={deleteMessage} title={t('common.delete')} aria-label={t('common.delete')} type="button">
              <i class="bi bi-trash" />
            </button>
          </Show>
          <Show when={message().parentId !== null}>
            <button class="action-btn" onClick={forkMessage} title={t('chat.forkAtMessage')} aria-label={t('chat.forkAtMessage')} type="button">
              <i class="bi bi-diagram-2" />
            </button>
          </Show>
          <Show when={isAssistant() && props.isLast}>
            <button class="action-btn" onClick={continueMessage} title={t('chat.continue')} aria-label={t('chat.continue')} type="button">
              <i class="bi bi-skip-end" />
            </button>
            <button class="action-btn" onClick={regenerate} title={t('chat.regenerate')} aria-label={t('chat.regenerate')} type="button">
              <i class="bi bi-arrow-clockwise" />
            </button>
          </Show>

        </Show>
      }
      suppressContent={(message().role === 'tool' || (!hasParts() && !hasRenderedHtml())) && !editing()}
      bodyExtra={
        <>
          <Show when={!props.readOnly && message().role === 'tool'}>
            {(() => {
              const Renderer = getToolRenderer(message().extra?.renderType);
              return (
                <Renderer
                  content={getMessageText(message().extra?.parts)}
                  isError={Boolean(message().extra?.isError)}
                  extra={message().extra}
                />
              );
            })()}
          </Show>
          <Show when={!props.readOnly && isStreamingTarget() && state.generation.streamingDebug}>
            <details class="backend-debug-block">
              <summary class="backend-debug-summary">Backend debug</summary>
              <pre class="backend-debug-content">{state.generation.streamingDebug}</pre>
            </details>
          </Show>
          <Show when={attachments().length > 0}>
            <div class={`message-attachments ${state.settings['mediaDisplayMode'] === 'grid' ? 'grid' : ''}`}>
              <For each={attachments()}>
                {(att) => (
                  <div class="attachment-wrapper" id={att.id}>
                  <Switch>
                    <Match when={att.mimeType.startsWith('image/')}>
                      <button
                        type="button"
                        class="message-attachment-btn"
                        aria-label={t('chat.imageAttachment')}
                        onClick={() => openLightbox(att.url)}
                      >
                        <img
                          class="message-attachment-img"
                          src={att.url}
                          alt=""
                          loading="lazy"
                        />
                      </button>
                    </Match>
                    <Match when={att.mimeType.startsWith('audio/')}>
                      <AudioPlayer src={att.url} title={t('chat.audioAttachment', { id: att.id })} />
                    </Match>
                    <Match when={att.mimeType.startsWith('video/')}>
                      <video class="message-attachment-video" controls src={att.url} preload="metadata" />
                    </Match>
                    <Match when={true}>
                      <a class="attachment-link" href={att.url} target="_blank" rel="noopener">
                        <i class="bi bi-paperclip" /> {att.id}
                      </a>
                    </Match>
                  </Switch>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </>
      }
      isEditing={!props.readOnly && editing()}
      rawText={getMessageText(message().extra?.parts)}
      onSwipeLeft={isSwipeable() ? () => handleSwipe('left') : undefined}
      onSwipeRight={isSwipeable() ? () => handleSwipe('right') : undefined}
    />
  );
}


