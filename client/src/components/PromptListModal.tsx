import { createSignal, Show, For, createEffect, onMount, onCleanup } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { activePromptListId, setActivePromptListId } from '../stores/uiStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { confirmPopup, alertPopup } from '../stores/popupStore.js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../timing.js';
import type { PresetPromptDef, PresetPromptOrderEntry } from '@tamari/types';
import './PromptListModal.css';

const DEFAULT_PROMPTS: PresetPromptDef[] = [
  {
    identifier: 'main',
    name: 'Main Prompt',
    content: "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.",
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: false,
  },
  {
    identifier: 'nsfw',
    name: 'Auxiliary Prompt',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: false,
  },
  {
    identifier: 'jailbreak',
    name: 'Post-History Instructions',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: false,
  },
  {
    identifier: 'enhanceDefinitions',
    name: 'Enhance Definitions',
    content:
      "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
    role: 'system',
    enabled: false,
    systemPrompt: true,
    marker: false,
  },
  {
    identifier: 'dialogueExamples',
    name: 'Chat Examples',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'chatHistory',
    name: 'Chat History',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'worldInfoBefore',
    name: 'World Info (before)',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'worldInfoAfter',
    name: 'World Info (after)',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'charDescription',
    name: 'Char Description',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'charPersonality',
    name: 'Char Personality',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'scenario',
    name: 'Scenario',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'personaDescription',
    name: 'Persona Description',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
];

const DEFAULT_ORDER: PresetPromptOrderEntry[] = [
  { identifier: 'main', enabled: true },
  { identifier: 'worldInfoBefore', enabled: true },
  { identifier: 'personaDescription', enabled: true },
  { identifier: 'charDescription', enabled: true },
  { identifier: 'charPersonality', enabled: true },
  { identifier: 'scenario', enabled: true },
  { identifier: 'enhanceDefinitions', enabled: false },
  { identifier: 'nsfw', enabled: true },
  { identifier: 'worldInfoAfter', enabled: true },
  { identifier: 'dialogueExamples', enabled: true },
  { identifier: 'chatHistory', enabled: true },
  { identifier: 'jailbreak', enabled: true },
];

const BUILTIN_IDENTIFIERS = new Set(DEFAULT_PROMPTS.map((p) => p.identifier));

export function PromptListModal(props: { onClose: () => void }) {
  const { t } = useI18n();
  const activePromptList = () => state.activePromptList;

  const close = () => {
    if (dirty()) saveList();
    restoreFocus();
    props.onClose();
  };

  // Prompt list editor signals
  const [listName, setListName] = createSignal(activePromptList()?.name ?? t('promptList.defaultName'));
  const [prompts, setPrompts] = createSignal<PresetPromptDef[]>(
    activePromptList()?.prompts ?? DEFAULT_PROMPTS.map((p) => ({ ...p })),
  );
  const [promptOrder, setPromptOrder] = createSignal<PresetPromptOrderEntry[]>(
    activePromptList()?.promptOrder ?? DEFAULT_ORDER.map((o) => ({ ...o })),
  );
  const [showAddPrompt, setShowAddPrompt] = createSignal(false);
  const [newPromptName, setNewPromptName] = createSignal('');
  const [newPromptContent, setNewPromptContent] = createSignal('');
  const [newPromptRole, setNewPromptRole] = createSignal<PresetPromptDef['role']>('system');
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [loadedListId, setLoadedListId] = createSignal<string | null>(null);

  onMount(() => {
    saveFocus();
    // Fall back to the first list when no active list was persisted — mirrors
    // BackendConfigModal and keeps the selector in sync with the edit section.
    const listId = state.settings['activePromptListId'] ?? state.promptLists[0]?.id;
    if (listId) {
      const id = String(listId);
      setActivePromptListId(id);
      bus.send({ type: 'promptList.select', promptListId: id });
    }
  });

  const loadListData = (list: NonNullable<typeof state.activePromptList>) => {
    setListName(list.name);
    setPrompts(list.prompts?.length ? list.prompts.map((p) => ({ ...p })) : DEFAULT_PROMPTS.map((p) => ({ ...p })));
    setPromptOrder(
      list.promptOrder?.length ? list.promptOrder.map((o) => ({ ...o })) : DEFAULT_ORDER.map((o) => ({ ...o })),
    );
  };

  // Sync editor fields when activePromptList changes to a *different* list.
  createEffect(() => {
    const list = state.activePromptList;
    if (!list) return;
    if (list.id === loadedListId()) return;
    loadListData(list);
    setLoadedListId(list.id);
    setDirty(false);
  });

  const switchList = (listId: string) => {
    // Flush pending edits against the OLD list first — setDirty(false)
    // below would cancel the debounce timer and silently drop them.
    if (dirty()) saveList();
    setActivePromptListId(listId);
    bus.send({ type: 'settings.set', key: 'activePromptListId', value: listId });
    bus.send({ type: 'promptList.select', promptListId: listId });
    setDirty(false);
  };

  const saveList = () => {
    const list = activePromptList();
    if (!list) return;
    setSaving(true);
    bus.send({
      type: 'promptList.update',
      promptListId: list.id,
      patch: {
        name: listName(),
        prompts: prompts(),
        promptOrder: promptOrder(),
      },
    });
    setTimeout(() => setSaving(false), 300);
  };

  // Auto-save prompt list fields (debounced)
  createEffect(() => {
    if (!dirty()) return;
    listName();
    prompts();
    promptOrder();

    const timer = setTimeout(() => {
      saveList();
      setDirty(false);
    }, AUTOSAVE_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(timer));
  });

  const duplicateList = () => {
    const current = activePromptList();
    const baseName = current?.name ?? t('promptList.defaultName');
    const name = t('promptList.duplicateName', { name: baseName });
    bus.send({
      type: 'promptList.create',
      data: {
        name,
        description: current?.description ?? '',
        prompts: prompts(),
        promptOrder: promptOrder(),
      },
    });
  };

  const deleteList = async () => {
    const list = activePromptList();
    if (!list) return;
    if (state.promptLists.length <= 1) {
      await alertPopup(t('promptList.cannotDeleteLast'));
      return;
    }
    if (!(await confirmPopup(t('promptList.deleteConfirm', { name: list.name })))) return;
    // Cancel any pending debounced save — its target is about to disappear
    // (same delete-after-save hazard as BackendConfigModal).
    setDirty(false);
    bus.send({ type: 'promptList.delete', promptListId: list.id });
  };

  const movePrompt = (index: number, direction: 'up' | 'down') => {
    setPromptOrder((prev) => {
      const next = [...prev];
      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (swapIndex < 0 || swapIndex >= next.length) return prev;
      [next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!];
      return next;
    });
    setDirty(true);
  };

  const togglePromptEnabled = (index: number) => {
    setPromptOrder((prev) => {
      const next = [...prev];
      const entry = next[index];
      if (!entry) return prev;
      next[index] = { ...entry, enabled: !entry.enabled };
      return next;
    });
    setDirty(true);
  };

  const updatePrompt = (identifier: string, patch: Partial<Omit<PresetPromptDef, 'identifier'>>) => {
    setPrompts((prev) => prev.map((p) => (p.identifier === identifier ? { ...p, ...patch } : p)));
    setDirty(true);
  };

  const deletePrompt = (identifier: string) => {
    setPrompts((prev) => prev.filter((p) => p.identifier !== identifier));
    setPromptOrder((prev) => prev.filter((o) => o.identifier !== identifier));
    setDirty(true);
  };

  const addPrompt = () => {
    const name = newPromptName().trim();
    if (!name) return;
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || `custom-${Date.now()}`;
    const identifier = BUILTIN_IDENTIFIERS.has(slug) ? `custom-${Date.now()}` : slug;
    const def: PresetPromptDef = {
      identifier,
      name,
      content: newPromptContent(),
      role: newPromptRole(),
      enabled: true,
    };
    setPrompts((prev) => [...prev, def]);
    setPromptOrder((prev) => [...prev, { identifier, enabled: true }]);
    setNewPromptName('');
    setNewPromptContent('');
    setNewPromptRole('system');
    setShowAddPrompt(false);
    setDirty(true);
  };

  const resetPrompts = async () => {
    if (!(await confirmPopup(t('promptList.resetConfirm')))) return;
    setPrompts(DEFAULT_PROMPTS.map((p) => ({ ...p })));
    setPromptOrder(DEFAULT_ORDER.map((o) => ({ ...o })));
    setDirty(true);
  };

  const markDirty = (setter: (v: unknown) => void) => (value: unknown) => {
    setter(value);
    setDirty(true);
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal settings-modal" role="dialog" aria-modal="true" aria-label={t('promptList.modalAriaLabel')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <h2 class="modal-title">{t('promptList.title')} {saving() && <span class="text-sm text-muted">{t('promptList.saving')}</span>}</h2>

        {/* List Selector */}
        <section class="settings-section">
          <h3 class="section-heading">{t('promptList.activeListHeading')}</h3>
          <label class="field-label">
            {t('promptList.listLabel')}
            <select class="select" value={activePromptListId() ?? ''} onChange={(e) => switchList(e.currentTarget.value)}>
              <For each={state.promptLists}>
                {(list) => (
                  <option class="select-option" id={list.id} value={list.id}>
                    {list.name}
                  </option>
                )}
              </For>
            </select>
          </label>

          <div class="preset-actions">
            <button class="text-btn" onClick={duplicateList} type="button">
              <i class="bi bi-copy" /> {t('promptList.duplicateList')}
            </button>
            <button class="text-btn danger" onClick={deleteList}>
              {t('promptList.deleteList')}
            </button>
          </div>
        </section>

        {/* List Editor */}
        <section class="settings-section">
          <h3 class="section-heading">{t('promptList.editHeading', { name: listName() })}</h3>
          <label class="field-label">
            {t('common.name')}
            <input class="input" value={listName()} onInput={(e) => markDirty(setListName)(e.currentTarget.value)} />
          </label>
        </section>

        {/* Prompt Manager */}
        <section class="settings-section">
          <h3 class="section-heading">{t('promptList.promptsHeading')}</h3>
          <div class="flex-row-sm">
            <button class="text-btn small" onClick={() => setShowAddPrompt((v) => !v)} type="button">
              <i class="bi bi-plus-lg" /> {showAddPrompt() ? t('common.cancel') : t('promptList.addPrompt')}
            </button>
            <button class="text-btn small" onClick={resetPrompts} type="button">
              <i class="bi bi-arrow-counterclockwise" /> {t('promptList.resetToDefaults')}
            </button>
          </div>

          <Show when={showAddPrompt()}>
            <div class="prompt-add-row">
              <label class="field-label">
                {t('common.name')}
                <input
                  class="input"
                  value={newPromptName()}
                  onInput={(e) => setNewPromptName(e.currentTarget.value)}
                  placeholder={t('promptList.namePlaceholder')}
                />
              </label>
              <label class="field-label">
                {t('promptList.roleLabel')}
                <select
                  class="select"
                  value={newPromptRole()}
                  onChange={(e) => setNewPromptRole(e.currentTarget.value as PresetPromptDef['role'])}
                >
                  <option class="select-option" value="system">{t('promptList.roleSystem')}</option>
                  <option class="select-option" value="user">{t('promptList.roleUser')}</option>
                  <option class="select-option" value="assistant">{t('promptList.roleAssistant')}</option>
                </select>
              </label>
              <label class="field-label">
                {t('promptList.contentLabel')}
                <textarea
                  rows={3}
                  value={newPromptContent()}
                  onInput={(e) => setNewPromptContent(e.currentTarget.value)}
                  placeholder={t('promptList.contentPlaceholder')}
                  class="resize-v"
                />
              </label>
              <button class="text-btn" onClick={addPrompt} disabled={!newPromptName().trim()}>
                {t('common.add')}
              </button>
            </div>
          </Show>

          <div class="prompt-list">
            <For each={promptOrder()}>
              {(entry, index) => {
                const def = prompts().find((p) => p.identifier === entry.identifier);
                if (!def) return null;
                const isBuiltin = BUILTIN_IDENTIFIERS.has(def.identifier);
                const isMarker = def.marker;
                return (
                  <div id={`prompt-order-${index()}`} class={`prompt-item ${entry.enabled ? '' : 'disabled'}`}>
                    <div class="prompt-item-header">
                      <span class="prompt-name" title={def.name}>
                        {def.name}
                      </span>
                      <Show when={isMarker}>
                        <span class="prompt-badge">{t('promptList.autoFilled')}</span>
                      </Show>
                      <input
                        class="input"
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={() => togglePromptEnabled(index())}
                        title={t('popups.enabled')}
                        aria-label={t('promptList.enablePrompt', { name: def.name })}
                      />
                      <select
                        class="select select-sm"
                        value={def.role}
                        onChange={(e) =>
                          updatePrompt(def.identifier, { role: e.currentTarget.value as PresetPromptDef['role'] })
                        }
                        disabled={def.identifier === 'dialogueExamples' || def.identifier === 'chatHistory'}
                        title={
                          def.identifier === 'dialogueExamples' || def.identifier === 'chatHistory'
                            ? t('promptList.roleFixed')
                            : t('promptList.promptRole')
                        }
                        aria-label={t('promptList.roleForPrompt', { name: def.name })}
                      >
                        <option class="select-option" value="system">{t('promptList.roleSystem')}</option>
                        <option class="select-option" value="user">{t('promptList.roleUser')}</option>
                        <option class="select-option" value="assistant">{t('promptList.roleAssistant')}</option>
                      </select>
                      <button
                        class="icon-btn small"
                        onClick={() => movePrompt(index(), 'up')}
                        disabled={index() === 0}
                        type="button"
                        title={t('promptList.moveUp')} aria-label={t('promptList.moveUp')}
                      >
                        <i class="bi bi-arrow-up" />
                      </button>
                      <button
                        class="icon-btn small"
                        onClick={() => movePrompt(index(), 'down')}
                        disabled={index() === promptOrder().length - 1}
                        type="button"
                        title={t('promptList.moveDown')} aria-label={t('promptList.moveDown')}
                      >
                        <i class="bi bi-arrow-down" />
                      </button>
                      <Show when={!isBuiltin}>
                        <button
                          class="icon-btn small danger"
                          onClick={() => deletePrompt(def.identifier)}
                          type="button"
                          title={t('common.delete')} aria-label={t('common.delete')}
                        >
                          <i class="bi bi-trash" />
                        </button>
                      </Show>
                    </div>
                    <div class="prompt-item-body">
                      <textarea
                        class="textarea"
                        rows={2}
                        value={def.content}
                        onInput={(e) => updatePrompt(def.identifier, { content: e.currentTarget.value })}
                        placeholder={isMarker ? t('promptList.contentAutoInjected') : t('promptList.contentPlaceholder')}
                        disabled={isMarker}
                        classList={{ 'preset-prompt-marker': isMarker, 'resize-v': true }}
                      />
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </section>

        <div class="modal-actions">
          <button class="text-btn" onClick={close}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
