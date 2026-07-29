import { For, createSignal, Show, createMemo, createEffect, onMount, onCleanup } from 'solid-js';
import { SafeImage } from './SafeImage.js';
import { bus } from '../bus/WebSocketBus.js';
import { state } from '../stores/serverStore.js';
import { confirmPopup, alertPopup, promptPopup } from '../stores/popupStore.js';
import { onEnterActivate } from '../lib/focusUtils.js';
import { useI18n } from '../i18n/index.js';
import { apiFetch } from '../lib/apiFetch.js';
import {
  activeChatId,
  setActiveChatId,
  pendingChatId,
  setPendingChatId,
  activeCharacterId,
  setActiveCharacterId,
  selectedCharacterId,
  setSelectedCharacterId,
} from '../stores/uiStore.js';
import { CharacterEditor } from './character/CharacterEditor.js';
import { SettingsModal } from './SettingsModal.js';
import { BackendConfigModal } from './BackendConfigModal.js';
import { SecretsModal } from './SecretsModal.js';
import { CustomBackendsModal } from './CustomBackendsModal.js';
import { PromptListModal } from './PromptListModal.js';
import { WorldInfoEditor } from './WorldInfoEditor.js';
import { PersonaManager } from './PersonaManager.js';
import { ToolsModal } from './ToolsModal.js';
import { StatsModal } from './StatsModal.js';
import { filterCharactersByQuery } from '../lib/fuzzySearch.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import './Sidebar.css';

const CHAR_PAGE_SIZE = 10;
const CHAT_PAGE_SIZE = 10;
const RECENT_CHAT_COUNT = 5;
const EDGE_SWIPE_ZONE = 24;
const SWIPE_OPEN_THRESHOLD = 60;

export function Sidebar() {
  const { t } = useI18n();
  const [showEditor, setShowEditor] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [showBackendConfigs, setShowBackendConfigs] = createSignal(false);
  const [showSecrets, setShowSecrets] = createSignal(false);
  const [showCustomBackends, setShowCustomBackends] = createSignal(false);
  const [showPromptLists, setShowPromptLists] = createSignal(false);
  const [showWorldInfo, setShowWorldInfo] = createSignal(false);
  const [showPersonas, setShowPersonas] = createSignal(false);
  const [showTools, setShowTools] = createSignal(false);
  const [showStats, setShowStats] = createSignal(false);
  const [charSearch, setCharSearch] = createSignal('');
  const [activeTags, setActiveTags] = createSignal<Set<string>>(new Set());
  const [charSort, setCharSort] = createSignal<'name' | 'updated' | 'created'>('updated');
  const [charPage, setCharPage] = createSignal(0);
  const [chatPage, setChatPage] = createSignal(0);
  const [chatSearch, setChatSearch] = createSignal('');
  const [mobileOpen, setMobileOpen] = createSignal(false);
  const [renamingChatId, setRenamingChatId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  // Mobile edge-swipe to open/close the sidebar
  onMount(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(max-width: 768px)');
    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onTouchStart = (e: TouchEvent) => {
      if (!mql.matches || mobileOpen()) return;
      const touch = e.touches[0];
      if (!touch || touch.clientX > EDGE_SWIPE_ZONE) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (dx > SWIPE_OPEN_THRESHOLD * 0.5 && dx > Math.abs(dy) * 1.5) {
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
      if (dx > SWIPE_OPEN_THRESHOLD && dx > Math.abs(dy) * 1.5) {
        setMobileOpen(true);
      }
    };

    const onTouchCancel = () => {
      tracking = false;
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchCancel);

    onCleanup(() => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchCancel);
    });
  });

  const allTags = createMemo(() => {
    const tagCounts = new Map<string, number>();
    for (const c of state.characters) {
      for (const t of c.tags) {
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
    }
    return Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
  });

  const filteredCharacters = createMemo(() => {
    const q = charSearch();
    const tags = activeTags();
    const fuzzy = Boolean(state.settings['fuzzySearch']);
    let list = state.characters;

    if (q.trim()) {
      list = filterCharactersByQuery(list, q, fuzzy);
    }

    if (tags.size > 0) {
      list = list.filter((c) => {
        const lower = c.tags.map((t) => t.toLowerCase());
        return Array.from(tags).every((t) => lower.includes(t.toLowerCase()));
      });
    }

    const sort = charSort();
    list = [...list].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'updated') return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });

    return list;
  });

  const pagedCharacters = createMemo(() => {
    const all = filteredCharacters();
    const start = charPage() * CHAR_PAGE_SIZE;
    return all.slice(start, start + CHAR_PAGE_SIZE);
  });

  const charPageCount = createMemo(() => Math.ceil(filteredCharacters().length / CHAR_PAGE_SIZE));

  const filteredChats = createMemo(() => {
    const q = chatSearch().toLowerCase();
    const sel = selectedCharacterId();
    let chats = state.chats;

    if (sel) {
      chats = chats.filter((c) => c.characterId === sel);
    }

    if (q) {
      chats = chats.filter((c) => c.name.toLowerCase().includes(q));
    }

    chats = [...chats].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    if (!sel) {
      // Default view: only show the 5 most recent across all characters
      chats = chats.slice(0, RECENT_CHAT_COUNT);
    }

    return chats;
  });

  const pagedChats = createMemo(() => {
    const all = filteredChats();
    const sel = selectedCharacterId();
    if (!sel) return all; // recent view is not paginated
    const start = chatPage() * CHAT_PAGE_SIZE;
    return all.slice(start, start + CHAT_PAGE_SIZE);
  });

  const chatPageCount = createMemo(() => {
    if (!selectedCharacterId()) return 0;
    return Math.ceil(filteredChats().length / CHAT_PAGE_SIZE);
  });

  const selectCharacter = (charId: string) => {
    setSelectedCharacterId(charId);
    setChatPage(0);
    setChatSearch('');
    bus.send({ type: 'chat.list', characterId: charId });
  };

  const clearCharacterSelection = () => {
    setSelectedCharacterId(null);
    setChatPage(0);
    bus.send({ type: 'chat.list', limit: 5 });
  };

  // The character behind the current sidebar selection. Derived from the
  // local list (not state.activeCharacter, which only updates on a
  // character.snapshot) so the chats-section title tracks sidebar AND
  // hotswap-bar selections without needing a bus round-trip.
  const selectedCharacter = createMemo(
    () => state.characters.find((c) => c.id === selectedCharacterId()) ?? null,
  );

  const selectChat = (chatId: string) => {
    setActiveChatId(chatId);
    setPendingChatId(null);
    const limit = Number(state.settings['chatMessageLoadLimit'] ?? 30);
    bus.send({ type: 'chat.select', chatId, limit });
    setMobileOpen(false);
  };

  const requestCharacterEdit = (charId: string) => {
    setActiveCharacterId(charId);
    bus.send({ type: 'character.select', characterId: charId });
  };

  const requestCharacterDelete = async (charId: string, name: string) => {
    if (!(await confirmPopup(t('sidebar.deleteCharacterConfirm', { name })))) return;
    bus.send({ type: 'character.delete', characterId: charId });
  };

  const openCharacterContextMenu = (e: MouseEvent, char: { id: string; name: string }) => {
    e.preventDefault();
    const items: ContextMenuItem[] = [
      {
        label: t('sidebar.newChat'),
        icon: 'chat-dots',
        onClick: () => createChat(char.id, char.name),
      },
      {
        label: t('common.edit'),
        icon: 'pencil',
        onClick: () => requestCharacterEdit(char.id),
      },
      {
        label: t('common.export'),
        icon: 'download',
        onClick: () => {
          // Use the canonical exportUrl from the server-provided summary rather than
          // constructing the URL heuristically from the id (AGENTS.md §5).
          const found = state.characters.find((c) => c.id === char.id);
          if (found?.exportUrl) window.open(found.exportUrl, '_blank');
        },
      },
      {
        label: t('common.delete'),
        icon: 'trash',
        danger: true,
        onClick: () => requestCharacterDelete(char.id, char.name),
      },
    ];
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const closeEditor = () => {
    setShowEditor(false);
    setActiveCharacterId(null);
  };

  createEffect(() => {
    const pendingId = pendingChatId();
    if (pendingId) {
      selectChat(pendingId);
    }
  });

  onMount(() => {
    const unsubSnapshot = bus.on('character.snapshot', (msg) => {
      if (msg.character.id !== activeCharacterId()) return;
      if (msg.clientId === state.clientId && !showEditor()) {
        setShowEditor(true);
      }
    });
    const unsubCreated = bus.on('character.created', (msg) => {
      if (msg.clientId === state.clientId) {
        setActiveCharacterId(msg.character.id);
      }
    });
    onCleanup(() => {
      unsubSnapshot();
      unsubCreated();
    });
  });

  const createChat = (characterId: string, name: string) => {
    selectCharacter(characterId);
    bus.send({
      type: 'chat.create',
      data: {
        characterId,
        personaId: state.activeChat?.personaId ?? null,
        name: `${name} - ${new Date().toLocaleDateString()}`,
      },
    });
  };

  const createGroupChat = async () => {
    const name = await promptPopup(t('sidebar.groupChatNamePrompt'));
    if (!name) return;
    bus.send({
      type: 'chat.create',
      data: { characterId: null, personaId: state.activeChat?.personaId ?? null, name },
    });
  };

  let importInputRef: HTMLInputElement | undefined;

  const handleImport = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await apiFetch('/api/characters/import', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Import failed');
    } catch (err) {
      console.error('Import failed:', err);
      await alertPopup(t('sidebar.importFailed'));
    }
  };

  const sidebarSwipeHandlers = (() => {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    return {
      onTouchStart: (e: TouchEvent) => {
        const touch = e.touches[0];
        if (!touch) return;
        startX = touch.clientX;
        startY = touch.clientY;
        tracking = true;
      },
      onTouchMove: (e: TouchEvent) => {
        if (!tracking) return;
        const touch = e.touches[0];
        if (!touch) return;
        const dx = startX - touch.clientX;
        const dy = touch.clientY - startY;
        if (dx > SWIPE_OPEN_THRESHOLD * 0.5 && dx > Math.abs(dy) * 1.5) {
          e.preventDefault();
        }
      },
      onTouchEnd: (e: TouchEvent) => {
        if (!tracking) return;
        tracking = false;
        const touch = e.changedTouches[0];
        if (!touch) return;
        const dx = startX - touch.clientX;
        const dy = touch.clientY - startY;
        if (dx > SWIPE_OPEN_THRESHOLD && dx > Math.abs(dy) * 1.5) {
          setMobileOpen(false);
        }
      },
      onTouchCancel: () => {
        tracking = false;
      },
    };
  })();

  return (
    <>
      <button class="mobile-menu-btn" onClick={() => setMobileOpen(true)} aria-label={t('sidebar.openMenu')} type="button">
        <i class="bi bi-list" />
      </button>

      <Show when={mobileOpen()}>
        <div class="mobile-overlay" onClick={() => setMobileOpen(false)} />
      </Show>

      <aside
        class={`sidebar ${mobileOpen() ? 'open' : ''}`}
        onTouchStart={sidebarSwipeHandlers.onTouchStart}
        onTouchMove={sidebarSwipeHandlers.onTouchMove}
        onTouchEnd={sidebarSwipeHandlers.onTouchEnd}
        onTouchCancel={sidebarSwipeHandlers.onTouchCancel}
      >
        <div class="sidebar-header">
          <h1 class="logo">tamari</h1>
          <button
            class="icon-btn mobile-close"
            onClick={() => setMobileOpen(false)}
            aria-label={t('sidebar.closeMenu')}
            type="button"
          >
            <i class="bi bi-x-lg" />
          </button>
        </div>

        <section class="sidebar-section">
          <div class="section-header">
            <h2 class="section-heading">{t('sidebar.characters')}</h2>
            <div class="section-actions">
              <button
                class="icon-btn"
                onClick={() => bus.send({ type: 'character.create', data: { name: 'New Character' } })}
                title={t('sidebar.createCharacter')} aria-label={t('sidebar.createCharacter')}
                type="button"
              >
                <i class="bi bi-plus-lg" />
              </button>
              <button class="icon-btn" onClick={() => importInputRef?.click()} title={t('sidebar.importCard')} aria-label={t('sidebar.importCard')} type="button">
                <i class="bi bi-upload" />
              </button>
              <input class="hidden-file-input" ref={importInputRef} type="file" accept="image/png,.charx,.json" onChange={handleImport} hidden />
            </div>
          </div>
          <input
            class="search-input"
            type="text"
            autocomplete="off"
            placeholder={t('sidebar.searchCharacters')}
            aria-label={t('sidebar.searchCharacters')}
            value={charSearch()}
            onInput={(e) => {
              setCharSearch(e.currentTarget.value);
              setCharPage(0);
            }}
          />
          <Show when={allTags().length > 0}>
            <div class="tag-filters">
              <For each={allTags()}>
                {(tag, index) => (
                  <button id={`tag-${index()}`}
                    type="button"
                    class={`tag-chip ${activeTags().has(tag) ? 'active' : ''}`}
                    onClick={() => {
                      const next = new Set(activeTags());
                      if (next.has(tag)) next.delete(tag);
                      else next.add(tag);
                      setActiveTags(next);
                      setCharPage(0);
                    }}
                  >
                    {tag}
                  </button>
                )}
              </For>
              <Show when={activeTags().size > 0}>
                <button type="button" class="text-btn small" onClick={() => setActiveTags(new Set())}>
                  {t('common.clear')}
                </button>
              </Show>
            </div>
          </Show>
          <div class="sort-row">
            <select
              class="select select-sm"
              aria-label={t('sidebar.sortCharacters')}
              value={charSort()}
              onChange={(e) => {
                setCharSort(e.currentTarget.value as 'name' | 'updated' | 'created');
                setCharPage(0);
              }}
            >
              <option class="sort-option" value="updated">{t('sidebar.sortUpdated')}</option>
              <option class="sort-option" value="created">{t('sidebar.sortCreated')}</option>
              <option class="sort-option" value="name">{t('sidebar.sortNameAz')}</option>
            </select>
            <button
              class={`icon-btn ${state.settings['charListGrid'] ? 'active' : ''}`}
              onClick={() =>
                bus.send({ type: 'settings.set', key: 'charListGrid', value: !state.settings['charListGrid'] })
              }
              title={t('sidebar.toggleGridView')} aria-label={t('sidebar.toggleGridView')}
              type="button"
            >
              <i class={`bi bi-${state.settings['charListGrid'] ? 'list-ul' : 'grid-3x3-gap'}`} />
            </button>
          </div>
          <ul class={`character-list ${state.settings['charListGrid'] ? 'grid' : ''}`}>
            <For each={pagedCharacters()}>
              {(char) => (
                <li
                  id={char.id}
                  class={`character-item ${selectedCharacterId() === char.id ? 'selected' : ''}`}
                  onContextMenu={(e) => openCharacterContextMenu(e, char)}
                >
                  <div class="character-main" role="button" tabindex={0} onKeyDown={onEnterActivate} onClick={() => selectCharacter(char.id)}>
                    <SafeImage
                      class="character-avatar"
                      src={(char.thumbnailUrl ?? char.avatarUrl) ?? undefined}
                      alt={char.name}
                      loading="lazy"
                    />
                    <span class="character-name">{char.name}</span>
                  </div>
                  <div class="character-actions">
                    <button
                      class="icon-btn small"
                      onClick={() => createChat(char.id, char.name)}
                      title={t('sidebar.newChat')} aria-label={t('sidebar.newChat')}
                      type="button"
                    >
                      <i class="bi bi-chat-dots" />
                    </button>
                    <button
                      class="icon-btn small"
                      onClick={() => requestCharacterEdit(char.id)}
                      title={t('sidebar.editCharacter')} aria-label={t('sidebar.editCharacter')}
                      type="button"
                    >
                      <i class="bi bi-pencil" />
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
          <Show when={charPageCount() > 1}>
            <div class="pagination-row">
              <button
                class="icon-btn tiny"
                onClick={() => setCharPage((p) => Math.max(0, p - 1))}
                disabled={charPage() === 0}
                type="button"
                aria-label={t('common.previousPage')}
              >
                <i class="bi bi-chevron-left" />
              </button>
              <span class="page-indicator">
                {charPage() + 1} / {charPageCount()}
              </span>
              <button
                class="icon-btn tiny"
                onClick={() => setCharPage((p) => Math.min(charPageCount() - 1, p + 1))}
                disabled={charPage() >= charPageCount() - 1}
                type="button"
                aria-label={t('common.nextPage')}
              >
                <i class="bi bi-chevron-right" />
              </button>
            </div>
          </Show>
        </section>

        <section class="sidebar-section">
          <div class="section-header">
            <h2 class="section-heading">
              <Show when={selectedCharacterId()} fallback={<span class="section-title-text">{t('sidebar.recentChats')}</span>}>
                <span class="section-title-text" title={t('sidebar.characterChats', { name: selectedCharacter()?.name ?? t('sidebar.character') })}>{t('sidebar.characterChats', { name: selectedCharacter()?.name ?? t('sidebar.character') })}</span>
              </Show>
            </h2>
            <div class="section-actions">
              <Show when={selectedCharacterId()}>
                <button class="icon-btn" onClick={clearCharacterSelection} title={t('sidebar.showAllRecentChats')} aria-label={t('sidebar.showAllRecentChats')} type="button">
                  <i class="bi bi-arrow-counterclockwise" />
                </button>
              </Show>
              <button class="icon-btn" onClick={createGroupChat} title={t('sidebar.newGroupChat')} aria-label={t('sidebar.newGroupChat')} type="button">
                <i class="bi bi-people" />
              </button>
            </div>
          </div>
          <input
            class="search-input"
            type="text"
            autocomplete="off"
            placeholder={t('sidebar.searchChats')}
            aria-label={t('sidebar.searchChats')}
            value={chatSearch()}
            onInput={(e) => {
              setChatSearch(e.currentTarget.value);
              setChatPage(0);
            }}
          />
          <ul class="chat-list">
            <For each={pagedChats()}>
              {(chat) => (
                <li id={chat.id}
                  class={`chat-item ${activeChatId() === chat.id ? 'active' : ''}`}
                  onClick={() => {
                    if (renamingChatId() !== chat.id) selectChat(chat.id);
                  }}
                >
                  <div class="chat-main" role="button" tabindex={0} onKeyDown={onEnterActivate}>
                    <Show
                      when={renamingChatId() === chat.id}
                      fallback={<span class="chat-name">{chat?.name ?? t('sidebar.untitled')}</span>}
                    >
                      <input
                        class="chat-rename-input"
                        value={renameValue()}
                        onInput={(e) => setRenameValue(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          // Stop propagation so keys don't bubble to the .chat-main
                          // role=button handler (onEnterActivate) — otherwise Space
                          // couldn't be typed and Enter would double-fire select.
                          if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
                            e.stopPropagation();
                          }
                          if (e.key === 'Enter') {
                            bus.send({ type: 'chat.update', chatId: chat.id, patch: { name: renameValue() } });
                            setRenamingChatId(null);
                          } else if (e.key === 'Escape') {
                            setRenamingChatId(null);
                          }
                        }}
                        onBlur={() => setRenamingChatId(null)}
                        autofocus
                      />
                    </Show>
                  </div>
                  <div class="chat-actions">
                    <button
                      class="icon-btn tiny"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameValue(chat.name);
                        setRenamingChatId(chat.id);
                      }}
                      title={t('sidebar.rename')} aria-label={t('sidebar.rename')}
                      type="button"
                    >
                      <i class="bi bi-pencil" />
                    </button>
                    <button
                      class="icon-btn tiny danger"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (await confirmPopup(t('sidebar.deleteChatConfirm', { name: chat.name }))) {
                          bus.send({ type: 'chat.delete', chatId: chat.id });
                        }
                      }}
                      title={t('common.delete')} aria-label={t('common.delete')}
                      type="button"
                    >
                      <i class="bi bi-trash" />
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
          <Show when={chatPageCount() > 1}>
            <div class="pagination-row">
              <button
                class="icon-btn tiny"
                onClick={() => setChatPage((p) => Math.max(0, p - 1))}
                disabled={chatPage() === 0}
                type="button"
                aria-label={t('common.previousPage')}
              >
                <i class="bi bi-chevron-left" />
              </button>
              <span class="page-indicator">
                {chatPage() + 1} / {chatPageCount()}
              </span>
              <button
                class="icon-btn tiny"
                onClick={() => setChatPage((p) => Math.min(chatPageCount() - 1, p + 1))}
                disabled={chatPage() >= chatPageCount() - 1}
                type="button"
                aria-label={t('common.nextPage')}
              >
                <i class="bi bi-chevron-right" />
              </button>
            </div>
          </Show>
        </section>

        <Show when={contextMenu()}>
          {(menu) => (
            <ContextMenu
              x={menu().x}
              y={menu().y}
              items={menu().items}
              onClose={() => setContextMenu(null)}
            />
          )}
        </Show>

        <div class="sidebar-footer">
          <button class="settings-btn" onClick={() => { setShowPersonas(true); setMobileOpen(false); }} type="button">
            <i class="bi bi-mask" /> {t('sidebar.personas')}
          </button>
          <button class="settings-btn" onClick={() => { setShowWorldInfo(true); setMobileOpen(false); }} type="button">
            <i class="bi bi-book" /> {t('sidebar.worldInfo')}
          </button>
          <button class="settings-btn" onClick={() => { setShowStats(true); setMobileOpen(false); }} type="button">
            <i class="bi bi-bar-chart" /> {t('sidebar.stats')}
          </button>
          <button class="settings-btn" onClick={() => { setShowBackendConfigs(true); setMobileOpen(false); }} type="button">
            <i class="bi bi-sliders" /> {t('sidebar.backendConfig')}
          </button>
          <button class="settings-btn" onClick={() => { setShowSecrets(true); setMobileOpen(false); }} type="button">
            <i class="bi bi-key" /> {t('secrets.title')}
          </button>
          <button class="settings-btn" onClick={() => { setShowCustomBackends(true); setMobileOpen(false); }} type="button">
            <i class="bi bi-cpu" /> {t('customBackends.title')}
          </button>
          <button class="settings-btn" onClick={() => { setShowPromptLists(true); setMobileOpen(false); }} type="button">
            <i class="bi bi-list-check" /> {t('sidebar.promptList')}
          </button>
          <button class="settings-btn" onClick={() => { setShowTools(true); setMobileOpen(false); }} type="button">
            <i class="bi bi-tools" /> {t('sidebar.tools')}
          </button>
          <button class="settings-btn" onClick={() => { setShowSettings(true); setMobileOpen(false); }} type="button">
            <i class="bi bi-gear" /> {t('settings.title')}
          </button>
        </div>
      </aside>

      <Show when={showEditor()}>
        <Show when={state.activeCharacter}>
          {(character) => <CharacterEditor character={character()} onClose={closeEditor} />}
        </Show>
      </Show>

      <Show when={showSettings()}>
        <SettingsModal onClose={() => setShowSettings(false)} />
      </Show>

      <Show when={showBackendConfigs()}>
        <BackendConfigModal onClose={() => setShowBackendConfigs(false)} />
      </Show>

      <Show when={showSecrets()}>
        <SecretsModal onClose={() => setShowSecrets(false)} />
      </Show>

      <Show when={showCustomBackends()}>
        <CustomBackendsModal onClose={() => setShowCustomBackends(false)} />
      </Show>

      <Show when={showPromptLists()}>
        <PromptListModal onClose={() => setShowPromptLists(false)} />
      </Show>

      <Show when={showWorldInfo()}>
        <WorldInfoEditor onClose={() => setShowWorldInfo(false)} />
      </Show>

      <Show when={showPersonas()}>
        <PersonaManager onClose={() => setShowPersonas(false)} />
      </Show>

      <Show when={showTools()}>
        <ToolsModal onClose={() => setShowTools(false)} />
      </Show>

      <Show when={showStats()}>
        <StatsModal onClose={() => setShowStats(false)} />
      </Show>
    </>
  );
}
