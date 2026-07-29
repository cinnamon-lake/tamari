import { createSignal, Show, For, createEffect } from 'solid-js';
import { bus } from '../bus/WebSocketBus.js';
import { state } from '../stores/serverStore.js';
import { addToast } from '../stores/toastStore.js';
import { activeChatId } from '../stores/uiStore.js';
import { parseCommand, SLASH_COMMANDS, MACROS, parseMacroAtCursor } from '../lib/slashCommands.js';
import { executeSlashCommand, consumePendingInjections } from '../lib/commands.js';
import { onEnterActivate } from '../lib/focusUtils.js';
import { uploadAttachments } from '../lib/uploadAttachments.js';

import {
  pendingAttachments,
  clearPendingAttachments,
  pendingDropFiles,
  clearPendingDropFiles,
} from '../stores/dndStore.js';
import { QuickReplyBar } from './QuickReplyBar.js';
import { materializeChat } from '../lib/materializeChat.js';
import type { AttachmentRef } from '@tamari/types';
import { useI18n } from '../i18n/index.js';
import './MessageInput.css';

function isMobileDevice(): boolean {
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  );
}

function shouldSendOnEnter(): boolean {
  const mode = String(state.settings['sendOnEnter'] ?? 'auto');
  if (mode === 'enabled') return true;
  if (mode === 'disabled') return false;
  // auto
  return !isMobileDevice();
}

const chatDrafts = new Map<string, string>();

export function MessageInput() {
  const { t } = useI18n();
  const [text, setText] = createSignal('');
  const [showAutocomplete, setShowAutocomplete] = createSignal(false);
  const [showMacroAutocomplete, setShowMacroAutocomplete] = createSignal(false);
  const [macroCursorStart, setMacroCursorStart] = createSignal(0);
  const [attachments, setAttachments] = createSignal<AttachmentRef[]>([]);
  const [uploading, setUploading] = createSignal(false);
  const [inputLocked, setInputLocked] = createSignal(false);
  let textareaRef: HTMLTextAreaElement | undefined;
  let attachInputRef: HTMLInputElement | undefined;
  let currentTextValue = '';
  let lastChatId: string | null | undefined;

  // Save/restore input draft when switching chats
  createEffect(() => {
    const currentChatId = activeChatId();
    const restoreEnabled = state.settings['restoreUserInput'];

    if (lastChatId && restoreEnabled) {
      chatDrafts.set(lastChatId, currentTextValue);
    }

    if (currentChatId && restoreEnabled) {
      const draft = chatDrafts.get(currentChatId) ?? '';
      setText(draft);
      currentTextValue = draft;
      queueMicrotask(resizeTextarea);
    } else if (currentChatId) {
      setText('');
      currentTextValue = '';
      queueMicrotask(resetTextarea);
    }

    if (currentChatId && state.settings['autoSelectInput'] && textareaRef) {
      queueMicrotask(() => {
        textareaRef?.focus();
        textareaRef?.select();
      });
    }

    lastChatId = currentChatId;
  });

  const resizeTextarea = () => {
    const el = textareaRef;
    if (!el) return;
    // Reset to auto so scrollHeight reflects the natural content height, then snap to it.
    // Both style assignments run in the same task so the browser never paints the intermediate state.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  const resetTextarea = () => {
    const el = textareaRef;
    if (!el) return;
    el.style.height = 'auto';
  };

  const send = async () => {
    const chatId = activeChatId();
    if (!chatId) return;

    try {
      await materializeChat(chatId);

      const parsed = parseCommand(text().trim());
      if (parsed && executeSlashCommand(parsed, chatId, { setText, setShowAutocomplete, setInputLocked })) {
        return;
      }

      const content = text().trim();
      const hasAttachments = attachments().length > 0;
      if (content || hasAttachments) {
        // Atomic send+generate: dispatching action.send and action.generate
        // as separate frames lets the server reorder them (fire-and-forget
        // dispatch per frame → race at the chat mutex), which dropped or
        // reordered user messages under load.
        bus.send({
          type: 'action.sendAndGenerate',
          chatId,
          content,
          attachments: hasAttachments ? attachments() : undefined,
          injections: consumePendingInjections(),
        });
      } else {
        bus.send({ type: 'action.generate', chatId, injections: consumePendingInjections() });
      }
    } catch (err) {
      // materializeChat (or a command) could reject; don't eat the user's
      // input — bail before the draft-clearing cleanup runs.
      console.error('[MessageInput] send failed:', err);
      addToast(t('messageInput.sendFailed'), 'error');
      return;
    }

    setText('');
    currentTextValue = '';
    const currentChatId = activeChatId();
    if (currentChatId) {
      chatDrafts.delete(currentChatId);
    }
    setAttachments([]);
    setShowAutocomplete(false);
    resetTextarea();
  };

  function wrapSelection(before: string, after: string) {
    const el = textareaRef;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const value = el.value;
    const selected = value.slice(start, end);
    const replacement = before + selected + after;
    const newValue = value.slice(0, start) + replacement + value.slice(end);
    setText(newValue);
    currentTextValue = newValue;
    queueMicrotask(resizeTextarea);
    queueMicrotask(() => {
      el.focus();
      const cursorPos = start + before.length + selected.length;
      el.setSelectionRange(cursorPos, cursorPos);
    });
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (showMacroAutocomplete()) {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const macros = filteredMacros();
        if (macros.length > 0) {
          insertMacro(macros[0]!.name, macros[0]!.args);
        }
        return;
      }
      if (e.key === 'Escape') {
        setShowMacroAutocomplete(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (shouldSendOnEnter()) {
        e.preventDefault();
        void send();
      }
      // If send-on-enter is disabled, let the default newline insertion happen
      return;
    }

    // Markdown hotkeys
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        wrapSelection('**', '**');
        return;
      }
      if (key === 'i') {
        e.preventDefault();
        wrapSelection('*', '*');
        return;
      }
      if (key === 'u') {
        e.preventDefault();
        wrapSelection('<u>', '</u>');
        return;
      }
      if (key === 'k') {
        e.preventDefault();
        wrapSelection('`', '`');
        return;
      }
      if (key === '`' && e.shiftKey) {
        e.preventDefault();
        wrapSelection('~~', '~~');
        return;
      }
    }
  };

  const handleInput = (value: string) => {
    setText(value);
    currentTextValue = value;
    const parsed = parseCommand(value);
    setShowAutocomplete(!!parsed && parsed.args.length === 0 && parsed.command.length > 0);

    const macro = textareaRef ? parseMacroAtCursor(value, textareaRef.selectionStart) : null;
    if (macro) {
      setMacroCursorStart(macro.start);
      setShowMacroAutocomplete(true);
    } else {
      setShowMacroAutocomplete(false);
    }
    queueMicrotask(resizeTextarea);
  };

  const filteredCommands = () => {
    const parsed = parseCommand(text());
    if (!parsed) return [];
    return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(parsed.command));
  };

  const insertCommand = (name: string) => {
    setText(`/${name} `);
    setShowAutocomplete(false);
  };

  const filteredMacros = () => {
    if (!textareaRef) return [];
    const macro = parseMacroAtCursor(text(), textareaRef.selectionStart);
    if (!macro) return [];
    return MACROS.filter((m) => m.name.toLowerCase().startsWith(macro.prefix.toLowerCase()));
  };

  const insertMacro = (name: string, args?: string) => {
    if (!textareaRef) return;
    const start = macroCursorStart();
    const before = text().slice(0, start);
    const after = text().slice(textareaRef.selectionStart);
    const insertion = args ? `{{${name}::}}` : `{{${name}}}`;
    const newText = before + insertion + after;
    setText(newText);
    currentTextValue = newText;
    setShowMacroAutocomplete(false);
    queueMicrotask(() => {
      if (!textareaRef) return;
      const cursorPos = start + insertion.length - (args ? 1 : 0);
      textareaRef.focus();
      textareaRef.setSelectionRange(cursorPos, cursorPos);
      resizeTextarea();
    });
  };

  const impersonate = () => {
    const chatId = activeChatId();
    if (!chatId) return;
    bus.send({ type: 'action.impersonate', chatId });
  };

  // Populate textarea when impersonation draft arrives
  createEffect(() => {
    const draft = state.generation.impersonationDraft;
    if (draft && textareaRef) {
      setText(draft);
      queueMicrotask(resizeTextarea);
    }
  });

  const uploadFiles = async (files: File[]) => {
    setUploading(true);
    try {
      const newAttachments = await uploadAttachments(files);
      setAttachments((prev) => [...prev, ...newAttachments]);
    } catch (err) {
      console.error('[MessageInput] upload failed:', err);
      addToast(t('messageInput.uploadFailed'), 'error');
    } finally {
      setUploading(false);
    }
  };

  // Pull in attachments dropped from the chat area
  createEffect(() => {
    const pending = pendingAttachments();
    if (pending.length > 0) {
      setAttachments((prev) => [...prev, ...pending]);
      clearPendingAttachments();
    }
  });

  // Upload files dropped onto the chat area
  createEffect(() => {
    const files = pendingDropFiles();
    if (files.length > 0) {
      void uploadFiles(files);
      clearPendingDropFiles();
    }
  });

  const handleFileSelect = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    await uploadFiles(Array.from(files));
    input.value = '';
  };

  const handlePaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const mediaFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/') || item.type.startsWith('audio/') || item.type.startsWith('video/')) {
        const file = item.getAsFile();
        if (file) mediaFiles.push(file);
      }
    }

    if (mediaFiles.length > 0) {
      e.preventDefault();
      await uploadFiles(mediaFiles);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const isDisabled = () => state.generation.status === 'streaming' || inputLocked();

  return (
    <Show when={activeChatId()}>
      <div class="message-input-area">
        <Show when={attachments().length > 0}>
          <div class="attachment-previews">
            <For each={attachments()}>
              {(att) => (
                <div class="attachment-preview" id={att.id}>
                  <Show
                    when={att.mimeType.startsWith('image/')}
                    fallback={
                      <div class="attachment-preview-generic">
                        <i class={`bi bi-${att.mimeType.startsWith('audio/') ? 'music-note-beamed' : att.mimeType.startsWith('video/') ? 'film' : 'file-earmark'}`} />
                        <span class="attachment-preview-name">{(att.meta as Record<string, string>)?.name ?? att.id}</span>
                      </div>
                    }
                  >
                    <img class="attachment-preview-img" src={att.url} alt="" loading="lazy" />
                  </Show>
                  <button
                    class="remove-attach"
                    onClick={() => removeAttachment(att.id)}
                    type="button"
                    aria-label={t('messageInput.removeAttachment')}
                  >
                    <i class="bi bi-x" />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="message-input">
          <div class="input-wrapper">
            <textarea class="message-textarea"
              ref={textareaRef}
              value={text()}
              onInput={(e) => handleInput(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={inputLocked() ? t('messageInput.inputLocked') : t('messageInput.typeMessage')}
              rows={1}
              disabled={isDisabled()}
            />
            <Show when={showAutocomplete()}>
              <div class="slash-autocomplete">
                <For each={filteredCommands()}>
                  {(cmd, index) => (
                    <div class="slash-suggestion" id={`cmd-${index()}`} role="button" tabindex={0} onKeyDown={onEnterActivate} onClick={() => insertCommand(cmd.name)}>
                      <span class="slash-name">/{cmd.name}</span>
                      <span class="slash-desc">{cmd.description}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={showMacroAutocomplete()}>
              <div class="slash-autocomplete">
                <For each={filteredMacros()}>
                  {(macro, index) => (
                    <div id={`macro-${index()}`}
                      class="slash-suggestion"
                      onClick={() => insertMacro(macro.name, macro.args)}
                    >
                      <span class="slash-name">{'{{' + macro.name + '}}'}</span>
                      <span class="slash-desc">{macro.description}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <button
            type="button"
            class="attach-btn"
            onClick={() => attachInputRef?.click()}
            disabled={uploading() || isDisabled()}
            title={uploading() ? t('messageInput.uploading') : t('messageInput.attachFile')}
            aria-label={uploading() ? t('messageInput.uploading') : t('messageInput.attachFile')}
          >
            <i class="bi bi-paperclip" />
          </button>
          <input
            ref={attachInputRef}
            class="hidden-file-input"
            type="file"
            accept="image/*,audio/*,video/*"
            multiple
            hidden
            onChange={handleFileSelect}
          />
          <button class="icon-btn input-action-btn" onClick={impersonate} disabled={isDisabled()} title={t('messageInput.impersonate')} aria-label={t('messageInput.impersonate')} type="button">
            <i class="bi bi-person" />
          </button>
          <Show when={state.settings['quickImpersonate']}>
            <button class="icon-btn input-action-btn" onClick={impersonate} disabled={isDisabled()} title={t('messageInput.quickImpersonate')} aria-label={t('messageInput.quickImpersonate')} type="button">
              <i class="bi bi-person-bounding-box" />
            </button>
          </Show>
          <Show when={state.settings['quickContinue']}>
            <button class="icon-btn input-action-btn"
              onClick={() => {
                const chatId = activeChatId();
                if (chatId) bus.send({ type: 'action.continue', chatId });
              }}
              disabled={isDisabled()}
              title={t('messageInput.quickContinue')} aria-label={t('messageInput.quickContinue')}
              type="button"
            >
              <i class="bi bi-skip-end" />
            </button>
          </Show>
          <Show
            when={state.generation.status === 'streaming' && state.generation.activeId}
            fallback={
              <button class="btn btn-primary send-btn" onClick={send} disabled={isDisabled()} title={t('messageInput.send')} type="button">
                <i class="bi bi-send" /> {t('messageInput.send')}
              </button>
            }
          >
            <button
              class="btn btn-danger send-btn"
              onClick={() => {
                const genId = state.generation.activeId;
                if (genId) bus.send({ type: 'action.stop', generationId: genId });
              }}
              title={t('messageInput.stopGeneration')} aria-label={t('messageInput.stopGeneration')}
              type="button"
            >
              <i class="bi bi-stop-fill" /> {t('messageInput.stop')}
            </button>
          </Show>
        </div>
        <Show when={!state.settings['hideQuickReplies']}>
          <QuickReplyBar />
        </Show>
      </div>
    </Show>
  );
}
