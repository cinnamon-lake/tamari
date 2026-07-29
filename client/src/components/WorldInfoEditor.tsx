import { For, Show, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { activeWorldInfoId, setActiveWorldInfoId } from '../stores/uiStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { confirmPopup } from '../stores/popupStore.js';
import { onEnterActivate, trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../timing.js';
import { useI18n } from '../i18n/index.js';
import { IdBadge } from './IdBadge.js';
import type { WorldInfo, WorldInfoEntry } from '@tamari/types';
import './WorldInfoEditor.css';

export function WorldInfoEditor(props: { onClose: () => void }) {
  const { t } = useI18n();

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  onMount(() => {
    saveFocus();
    bus.send({ type: 'worldinfo.list' });
  });

  onCleanup(() => {
    setActiveWorldInfoId(null);
  });

  const activeBook = () => state.activeWorldInfo;

  const createBook = () => {
    bus.send({
      type: 'worldinfo.create',
      data: { name: t('worldInfo.newLorebook'), entries: [] },
    });
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal worldinfo-modal" role="dialog" aria-modal="true" aria-label={t('worldInfo.modalAriaLabel')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <div class="modal-header-row">
          <h2 class="modal-title">{t('worldInfo.title')}</h2>
          <button class="icon-btn" onClick={close} title={t('common.close')} aria-label={t('common.close')} type="button">
            <i class="bi bi-x-lg" />
          </button>
        </div>

        <Show
          when={!activeWorldInfoId()}
          fallback={
            <Show
              when={activeBook()}
              fallback={
                <div class="empty-state empty-state-lg">
                  <i class="bi bi-arrow-repeat" />
                  <div class="loading-text">{t('worldInfo.loadingBook')}</div>
                </div>
              }
            >
              {(book) => <BookEditor book={book()} onBack={() => setActiveWorldInfoId(null)} />}
            </Show>
          }
        >
          <div class="worldinfo-list">
            <For each={state.worldInfo}>
              {(book) => (
                <div
                  id={book.id}
                  class="selectable-item worldinfo-item"
                  onClick={() => {
                    setActiveWorldInfoId(book.id);
                    bus.send({ type: 'worldinfo.select', bookId: book.id });
                  }}
                >
                  <span class="worldinfo-name">{book.name}</span>
                  <span class="worldinfo-meta">{t('worldInfo.entriesCount', { count: book.entries.length })}</span>
                </div>
              )}
            </For>
          </div>
          <button class="btn btn-primary primary-btn" onClick={createBook} type="button">
            <i class="bi bi-plus-lg" /> {t('worldInfo.newLorebook')}
          </button>
        </Show>
      </div>
    </div>
  );
}

function BookEditor(props: { book: WorldInfo; onBack: () => void }) {
  const { t } = useI18n();
  const [name, setName] = createSignal(props.book.name);
  const [editingEntryId, setEditingEntryId] = createSignal<string | null>(null);
  const [testText, setTestText] = createSignal('');
  const [testResults, setTestResults] = createSignal<Array<{ entry: WorldInfoEntry; tokens: number }> | null>(null);
  const [loadedBookId, setLoadedBookId] = createSignal<string | null>(null);

  createEffect(() => {
    const b = props.book;
    if (b.id === loadedBookId()) return;
    setName(b.name);
    setEditingEntryId(null);
    setLoadedBookId(b.id);
  });

  const saveName = () => {
    bus.send({
      type: 'worldinfo.update',
      bookId: props.book.id,
      patch: { name: name() },
    });
  };

  const addEntry = () => {
    bus.send({
      type: 'worldinfo.entry.create',
      bookId: props.book.id,
      data: {
        keys: [''],
        content: '',
        comment: '',
        order: 100,
        position: 'before_char',
        probability: 100,
        constant: false,
        selective: false,
        secondaryKeys: [],
        addMemo: false,
        disable: false,
        regex: false,
        recursive: false,
      },
    });
  };

  const updateEntry = (entryId: string, patch: Partial<Omit<WorldInfoEntry, 'id'>>) => {
    bus.send({
      type: 'worldinfo.entry.update',
      bookId: props.book.id,
      entryId,
      patch,
    });
  };

  const deleteEntry = (id: string) => {
    bus.send({
      type: 'worldinfo.entry.delete',
      bookId: props.book.id,
      entryId: id,
    });
  };

  const deleteBook = async () => {
    if (!(await confirmPopup(t('worldInfo.deleteBookConfirm')))) return;
    bus.send({ type: 'worldinfo.delete', bookId: props.book.id });
    props.onBack();
  };

  const runTest = () => {
    setTestResults(null);
    bus.send({
      type: 'worldinfo.test',
      entries: props.book.entries,
      text: testText(),
    });
  };

  onMount(() => {
    const unsub = bus.on('worldinfo.tested', (msg) => {
      setTestResults(msg.activated);
    });
    onCleanup(unsub);
  });

  return (
    <div class="book-editor">
      <div class="book-editor-header">
        <button class="text-btn back-btn" onClick={props.onBack} type="button">
          <i class="bi bi-arrow-left" /> {t('worldInfo.back')}
        </button>
        <input
          class="book-name-input"
          value={name()}
          onInput={(e) => {
            setName(e.currentTarget.value);
          }}
          onBlur={saveName}
        />
        <IdBadge id={props.book.id} />
      </div>

      <Show when={props.book.entries.length > 0}>
        <div class="entries-list">
          <For each={props.book.entries.map((e) => e.id)}>
            {(id) => {
              // Iterate stable ids, not entry objects: <For> keys by reference,
              // so a worldinfo.updated/snapshot broadcast (which replaces every
              // entry object) would otherwise dispose and remount the open
              // EntryEditor mid-edit — wiping unsaved textarea content.
              const entry = () => props.book.entries.find((e) => e.id === id);
              return (
                <Show
                  when={editingEntryId() === id && entry()}
                  fallback={
                    <div id={id} class="selectable-item entry-row" role="button" tabindex={0} onKeyDown={onEnterActivate} onClick={() => setEditingEntryId(id)}>
                      <span class="entry-keys">{entry()?.keys.join(', ')}</span>
                      <span class="entry-content-preview">{entry()?.content.slice(0, 60)}...</span>
                    </div>
                  }
                >
                  {(e) => <EntryEditor id={id} entry={e()} onSave={(patch) => updateEntry(id, patch)} onDelete={() => deleteEntry(id)} />}
                </Show>
              );
            }}
          </For>
        </div>
      </Show>

      <button class="btn btn-primary primary-btn" onClick={addEntry} type="button">
        <i class="bi bi-plus-lg" /> {t('worldInfo.addEntry')}
      </button>

      <div class="test-triggers-panel">
        <h3 class="panel-title">{t('worldInfo.testTriggers')}</h3>
        <textarea
          class="textarea"
          rows={3}
          placeholder={t('worldInfo.testPlaceholder')}
          value={testText()}
          onInput={(e) => setTestText(e.currentTarget.value)}
        />
        <button class="btn btn-primary primary-btn" onClick={runTest}>
          {t('worldInfo.test')}
        </button>

        <Show when={testResults()}>
          <div class="test-results">
            <Show when={(testResults()?.length ?? 0) > 0} fallback={<p class="text-muted">{t('worldInfo.noEntriesTriggered')}</p>}>
              <For each={testResults()}>
                {(result) => (
                  <div id={result.entry.id} class="test-result-item">
                    <strong class="result-keys">{result.entry.keys.join(', ')}</strong>
                    <span class="text-muted">
                      {t('worldInfo.testResultMeta', { tokens: result.tokens, position: result.entry.position })}
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>

      <button class="text-btn danger delete-book-btn" onClick={deleteBook} type="button">
        <i class="bi bi-trash" /> {t('worldInfo.deleteLorebook')}
      </button>
    </div>
  );
}

function EntryEditor(props: { entry: WorldInfoEntry; onSave: (patch: Partial<Omit<WorldInfoEntry, 'id'>>) => void; onDelete: () => void; id?: string }) {
  const { t } = useI18n();
  const [keys, setKeys] = createSignal(props.entry.keys.join(', '));
  const [content, setContent] = createSignal(props.entry.content);
  const [position, setPosition] = createSignal(props.entry.position);
  const [depth, setDepth] = createSignal(props.entry.depth ?? 0);
  const [role, setRole] = createSignal(props.entry.role ?? 'system');
  const [order, setOrder] = createSignal(props.entry.order);
  const [probability, setProbability] = createSignal(props.entry.probability);
  const [constant, setConstant] = createSignal(props.entry.constant);
  const [selective, setSelective] = createSignal(props.entry.selective);
  const [secondaryKeys, setSecondaryKeys] = createSignal(props.entry.secondaryKeys.join(', '));
  const [regex, setRegex] = createSignal(props.entry.regex);
  const [recursive, setRecursive] = createSignal(props.entry.recursive);
  const [sticky, setSticky] = createSignal(props.entry.sticky ?? 0);
  const [cooldown, setCooldown] = createSignal(props.entry.cooldown ?? 0);
  const [delay, setDelay] = createSignal(props.entry.delay ?? 0);
  const [loadedEntryId, setLoadedEntryId] = createSignal<string | null>(null);
  const [savedIndicator, setSavedIndicator] = createSignal(false);

  createEffect(() => {
    const e = props.entry;
    if (e.id === loadedEntryId()) return;
    setKeys(e.keys.join(', '));
    setContent(e.content);
    setPosition(e.position);
    setDepth(e.depth ?? 0);
    setRole(e.role ?? 'system');
    setOrder(e.order);
    setProbability(e.probability);
    setConstant(e.constant);
    setSelective(e.selective);
    setSecondaryKeys(e.secondaryKeys.join(', '));
    setRegex(e.regex);
    setRecursive(e.recursive);
    setSticky(e.sticky ?? 0);
    setCooldown(e.cooldown ?? 0);
    setDelay(e.delay ?? 0);
    setLoadedEntryId(e.id);
  });

  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const buildPatch = (): Partial<Omit<WorldInfoEntry, 'id'>> => {
    const patch: Partial<Omit<WorldInfoEntry, 'id'>> = {
      keys: keys()
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      content: content(),
      position: position(),
      order: order(),
      probability: probability(),
      constant: constant(),
      selective: selective(),
      secondaryKeys: secondaryKeys()
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      regex: regex(),
      recursive: recursive(),
      sticky: sticky(),
      cooldown: cooldown(),
      delay: delay(),
    };
    if (position() === 'atDepth') {
      patch.depth = depth();
      patch.role = role();
    } else {
      patch.depth = undefined;
      patch.role = undefined;
    }
    return patch;
  };

  const showSaved = () => {
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 1200);
  };

  const scheduleSave = () => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      props.onSave(buildPatch());
      showSaved();
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  const save = () => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    props.onSave(buildPatch());
    showSaved();
  };

  // Flush a pending auto-save on unmount so closing the editor within the
  // debounce window doesn't silently lose the edit.
  onCleanup(() => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      props.onSave(buildPatch());
    }
  });

  return (
    <div id={props.id} class="entry-editor">
      <label class="field-label">
        {t('worldInfo.keysLabel')}
        <input class="input" value={keys()} onInput={(e) => setKeys(e.currentTarget.value)} onBlur={save} />
      </label>
      <label class="field-label">
        {t('worldInfo.contentLabel')}
        <textarea class="textarea" rows={3} value={content()} onInput={(e) => setContent(e.currentTarget.value)} onBlur={save} />
      </label>
      <div class="entry-row-inline">
        <label class="field-label">
          {t('worldInfo.positionLabel')}
          <select
            class="select"
            value={position()}
            onChange={(e) => {
              setPosition(e.currentTarget.value as WorldInfoEntry['position']);
              scheduleSave();
            }}
          >
            <option class="select-option" value="before_char">{t('worldInfo.positionBeforeChar')}</option>
            <option class="select-option" value="after_char">{t('worldInfo.positionAfterChar')}</option>
            <option class="select-option" value="top">{t('worldInfo.positionTop')}</option>
            <option class="select-option" value="bottom">{t('worldInfo.positionBottom')}</option>
            <option class="select-option" value="atDepth">{t('worldInfo.positionAtDepth')}</option>
          </select>
        </label>
        <Show when={position() === 'atDepth'}>
          <label class="field-label">
            {t('worldInfo.depthLabel')}
            <input
              class="input"
              type="number"
              min={0}
              value={depth()}
              onInput={(e) => {
                setDepth(Number(e.currentTarget.value));
                scheduleSave();
              }}
            />
          </label>
          <label class="field-label">
            {t('worldInfo.roleLabel')}
            <select
              class="select"
              value={role()}
              onChange={(e) => {
                setRole(e.currentTarget.value as NonNullable<WorldInfoEntry['role']>);
                scheduleSave();
              }}
            >
              <option class="select-option" value="system">{t('worldInfo.roleSystem')}</option>
              <option class="select-option" value="user">{t('worldInfo.roleUser')}</option>
              <option class="select-option" value="assistant">{t('worldInfo.roleAssistant')}</option>
            </select>
          </label>
        </Show>
        <label class="field-label" title={t('worldInfo.entryHints.order')}>
          {t('worldInfo.orderLabel')}
          <input class="input" type="number" value={order()} onInput={(e) => setOrder(Number(e.currentTarget.value))} onBlur={save} />
        </label>
        <label class="field-label" title={t('worldInfo.entryHints.probability')}>
          {t('worldInfo.probabilityLabel')}
          <input
            class="input"
            type="number"
            min={0}
            max={100}
            value={probability()}
            onInput={(e) => setProbability(Number(e.currentTarget.value))}
            onBlur={save}
          />
        </label>
        <label class="field-label" title={t('worldInfo.entryHints.delay')}>
          {t('worldInfo.delayLabel')}
          <input
            class="input"
            type="number"
            min={0}
            value={delay()}
            onInput={(e) => setDelay(Number(e.currentTarget.value))}
            onBlur={save}
          />
        </label>
        <label class="field-label" title={t('worldInfo.entryHints.cooldown')}>
          {t('worldInfo.cooldownLabel')}
          <input
            class="input"
            type="number"
            min={0}
            value={cooldown()}
            onInput={(e) => setCooldown(Number(e.currentTarget.value))}
            onBlur={save}
          />
        </label>
        <label class="field-label" title={t('worldInfo.entryHints.sticky')}>
          {t('worldInfo.stickyLabel')}
          <input
            class="input"
            type="number"
            min={0}
            value={sticky()}
            onInput={(e) => setSticky(Number(e.currentTarget.value))}
            onBlur={save}
          />
        </label>
      </div>
      <div class="entry-checkboxes">
        <label class="field-label" title={t('worldInfo.entryHints.constant')}>
          <input
            type="checkbox"
            class="checkbox-input"
            checked={constant()}
            onChange={(e) => {
              setConstant(e.currentTarget.checked);
              scheduleSave();
            }}
          />
          {t('worldInfo.constantLabel')}
        </label>
        <label class="field-label" title={t('worldInfo.entryHints.selective')}>
          <input
            type="checkbox"
            class="checkbox-input"
            checked={selective()}
            onChange={(e) => {
              setSelective(e.currentTarget.checked);
              scheduleSave();
            }}
          />
          {t('worldInfo.selectiveLabel')}
        </label>
        <label class="field-label" title={t('worldInfo.entryHints.regex')}>
          <input
            type="checkbox"
            class="checkbox-input"
            checked={regex()}
            onChange={(e) => {
              setRegex(e.currentTarget.checked);
              scheduleSave();
            }}
          />
          {t('worldInfo.regexLabel')}
        </label>
        <label class="field-label" title={t('worldInfo.entryHints.recursive')}>
          <input
            type="checkbox"
            class="checkbox-input"
            checked={recursive()}
            onChange={(e) => {
              setRecursive(e.currentTarget.checked);
              scheduleSave();
            }}
          />
          {t('worldInfo.recursiveLabel')}
        </label>
      </div>
      <Show when={selective()}>
        <label class="field-label">
          {t('worldInfo.secondaryKeysLabel')}
          <input class="input" value={secondaryKeys()} onInput={(e) => setSecondaryKeys(e.currentTarget.value)} onBlur={save} />
        </label>
      </Show>
      <div class="entry-actions">
        <Show when={savedIndicator()}>
          <span class="save-indicator">{t('worldInfo.saved')}</span>
        </Show>
        <button class="text-btn" onClick={props.onDelete}>
          {t('common.delete')}
        </button>
      </div>
    </div>
  );
}
