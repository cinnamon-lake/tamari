import type { Component } from 'solid-js';
import { createSignal, createMemo, Show, onMount, onCleanup, createEffect, on } from 'solid-js';
import { Sidebar } from './components/Sidebar.js';
import { ChatHeader } from './components/ChatHeader.js';
import { SceneStage } from './components/SceneStage.js';
import { ChatView } from './components/ChatView.js';
import { MessageInput } from './components/MessageInput.js';
import { ToastContainer } from './components/ToastContainer.js';
import { PopupContainer } from './components/PopupContainer.js';
import { ThemeInjector } from './components/ThemeInjector.js';
import { BackgroundInjector } from './components/BackgroundInjector.js';
import { DesignTokenInjector } from './components/DesignTokenInjector.js';
import { ImageLightbox } from './components/ImageLightbox.js';
import { HotswapBar } from './components/HotswapBar.js';
import { AuthGate } from './components/AuthModal.js';
import { uploadAttachments } from './lib/uploadAttachments.js';
import { deriveScene } from './lib/sceneState.js';
import { appendPendingAttachments } from './stores/dndStore.js';
import { state } from './stores/serverStore.js';
import { useI18n } from './i18n/index.js';

const App: Component = () => {
  const { t } = useI18n();
  const [dragOver, setDragOver] = createSignal(false);
  let dragCounter = 0;

  // Current scene for the active branch — derived from message history, so it
  // follows swipes/forks/chat-switches automatically (see lib/sceneState.ts).
  // The branch's visible messages are the bulk list plus the active child
  // (newest replies live in `state.swipes` until the branch advances), mirroring
  // ChatView's activeChild logic.
  const currentScene = createMemo(() => {
    const chat = state.activeChat;
    if (!chat) return null;
    const bulk = state.messages[chat.id] ?? [];
    const child = chat.activeChildId
      ? state.swipes[chat.id]?.find((m) => m.id === chat.activeChildId)
      : undefined;
    const messages = child && !bulk.some((m) => m.id === child.id) ? [...bulk, child] : bulk;
    return deriveScene(messages);
  });

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer?.types.includes('Files')) {
      setDragOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      setDragOver(false);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    dragCounter = 0;
    setDragOver(false);

    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;

    const uploaded = await uploadAttachments(files);
    if (uploaded.length > 0) {
      appendPendingAttachments(uploaded);
    }
  };

  // Global Escape: close the topmost modal overlay if one is open.
  // Individual modals that handle Escape themselves (PopupContainer, ContextMenu)
  // call e.stopPropagation() so this fallback doesn't fire.
  const handleGlobalEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const overlays = document.querySelectorAll('.modal-overlay');
    if (overlays.length === 0) return;
    const topOverlay = overlays[overlays.length - 1] as HTMLElement;
    topOverlay.click();
  };

  // While a modal dialog is open, mark the app background `inert` so background
  // content is removed from the tab order and the accessibility tree.
  // Sidebar-mounted dialogs (Settings, CharacterEditor, …) are DOM siblings of
  // <main>, so <main> + <aside> are safe to inert. But GroupChatPanel and
  // CheckpointsPanel mount inside <main> (via ChatHeader) — inerting <main>
  // then would inert the dialog itself. So <main> is inerted only when the
  // open dialog lives elsewhere; <aside> (never a dialog host) is always inerted.
  const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';
  const syncBackgroundInert = () => {
    const hasDialog = document.querySelector(DIALOG_SELECTOR) !== null;
    const sidebar = document.querySelector<HTMLElement>('aside.sidebar');
    const main = document.getElementById('main-panel');
    const dialogInsideMain = !!main?.querySelector(DIALOG_SELECTOR);
    if (sidebar) sidebar.inert = hasDialog;
    if (main) main.inert = hasDialog && !dialogInsideMain;
  };
  const isDialogMutation = (node: Node): boolean =>
    node instanceof HTMLElement &&
    (!!node.matches?.(DIALOG_SELECTOR) || !!node.querySelector?.(DIALOG_SELECTOR));

  // Mobile keyboards shrink the visual viewport *after* a field gets focus.
  // Bottom-sheet modals resize with it (85vh of the smaller viewport) and the
  // inline message editor grows under the keyboard too — but the browser's
  // initial focus-scroll is already stale, so the field being typed into ends
  // up hidden behind the keyboard. Re-scroll the focused field into view on
  // resize. (block: 'nearest' — a no-op when the field is already visible, so
  // closing the keyboard doesn't cause a jump.)
  const keepFocusedFieldVisible = () => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return;
    if (!/^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName)) return;
    // For the inline message editor, scroll the whole container (textarea +
    // Save/Cancel actions) into view — the textarea alone can leave the
    // actions hidden behind the keyboard / input bar.
    const target = el.closest('.message-edit') ?? el;
    target.scrollIntoView({ block: 'nearest' });
  };

  onMount(() => {
    document.addEventListener('keydown', handleGlobalEscape);
    window.visualViewport?.addEventListener('resize', keepFocusedFieldVisible);
    syncBackgroundInert();
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if ([...m.addedNodes, ...m.removedNodes].some(isDialogMutation)) {
          syncBackgroundInert();
          break;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleGlobalEscape);
    window.visualViewport?.removeEventListener('resize', keepFocusedFieldVisible);
  });

  // Announce generation start/stop for the active chat to assistive tech.
  // Errors are surfaced via toasts (already aria-live); this covers the
  // streaming↔idle transition a sighted user sees in the UI chrome.
  const [announcement, setAnnouncement] = createSignal('');
  createEffect(
    on(
      () => [state.generation.status, state.generation.chatId, state.activeChat?.id ?? null] as const,
      ([status, chatId, activeId], prev) => {
        const isActive = !!chatId && chatId === activeId;
        if (!isActive) {
          setAnnouncement('');
          return;
        }
        const prevStatus = prev?.[0] ?? status;
        if (status === 'streaming' && prevStatus !== 'streaming') {
          setAnnouncement(t('chat.generationStarted'));
        } else if (status !== 'streaming' && prevStatus === 'streaming') {
          setAnnouncement(t('chat.generationComplete'));
        }
      },
      { defer: true },
    ),
  );

  return (
    <AuthGate>
    <a href="#main-panel" class="skip-link">{t('app.skipToMainContent')}</a>
    <div class="sr-only" role="status" aria-live="polite">{announcement()}</div>
    <div class="app-shell">
      <Sidebar />
      <main
        id="main-panel"
        class="main-panel"
        tabindex="-1"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <HotswapBar />
        <ChatHeader />
        <SceneStage scene={currentScene()} />
        <ChatView />
        <MessageInput />
        <Show when={dragOver()}>
          <div class="drag-drop-overlay">
            <div class="drag-drop-content">
              <i class="bi bi-cloud-upload text-3xl" />
              <span class="drag-drop-hint">{t('app.dropFilesToAttach')}</span>
            </div>
          </div>
        </Show>
      </main>
      <ToastContainer />
      <PopupContainer />
      <ThemeInjector />
      <BackgroundInjector />
      <DesignTokenInjector />
      <ImageLightbox />
    </div>
    </AuthGate>
  );
};

export default App;
