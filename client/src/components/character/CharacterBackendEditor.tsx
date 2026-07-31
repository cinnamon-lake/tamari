/**
 * Character-coupled backend logic editor (extensions.contextualBackend).
 *
 * A Lua script owned by the character card (ported triggerlua / simulator
 * logic) rather than by the global custom-backend registry. Stored inline in
 * extensions so it travels with card export. Controlled component: the parent
 * owns the value and persists on `onChange` (mirrors CharacterRegexEditor).
 *
 * Multi-file: the script entry point is main.lua (== luaSource); modules live
 * in the `files` map and resolve through the sandboxed `require` (see
 * server/src/scripting/LuaVfs.ts). The tab bar switches what the single
 * textarea edits — main.lua first (fixed, not deletable), then sorted module
 * paths, then an add button.
 */
import { Show, For, createSignal, createMemo } from 'solid-js';
import { useI18n } from '../../i18n/index.js';
import { BackendDryRunPanel } from '../BackendDryRunPanel.js';

export interface CharacterBackendLogic {
  enabled: boolean;
  luaSource: string;
  files: Record<string, string>;
}

export interface CharacterBackendEditorProps {
  value: CharacterBackendLogic;
  onChange: (next: CharacterBackendLogic) => void;
  /** When set, a dry-run panel is embedded (sends characterId so the server
   *  weaves this character's description/firstMes into the sample prompt). */
  characterId?: string;
}

/**
 * Client mirror of validateVfsPath (server/src/scripting/LuaVfs.ts) — keep in
 * sync: trim, strip leading './', reject leading '/' and empty, append '.lua'
 * when missing, no empty segments, segments are [A-Za-z0-9_-].
 */
export function validateVfsPath(path: string): string | null {
  let p = path.trim();
  while (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/') || p.length === 0) return null;
  if (!p.endsWith('.lua')) p += '.lua';
  const segs = p.split('/');
  for (const seg of segs) {
    if (seg.length === 0) return null;
  }
  for (let i = 0; i < segs.length - 1; i++) {
    if (!/^[A-Za-z0-9_-]+$/.test(segs[i]!)) return null;
  }
  if (!/^[A-Za-z0-9_-]+\.lua$/.test(segs[segs.length - 1]!)) return null;
  return p;
}

/** Tolerant parse of the contextualBackend extension blob. */
export function parseCharacterBackendLogic(
  extensions: Record<string, unknown> | undefined,
): CharacterBackendLogic {
  const raw = extensions?.['contextualBackend'];
  if (!raw || typeof raw !== 'object') return { enabled: false, luaSource: '', files: {} };
  const ext = raw as Record<string, unknown>;
  const files: Record<string, string> = {};
  const rawFiles = ext['files'];
  if (rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles)) {
    for (const [key, value] of Object.entries(rawFiles as Record<string, unknown>)) {
      if (typeof value === 'string' && validateVfsPath(key) !== null) files[key] = value;
    }
  }
  return {
    enabled: ext['enabled'] === true,
    luaSource: typeof ext['luaSource'] === 'string' ? ext['luaSource'] : '',
    files,
  };
}

const MAIN_TAB = 'main';

export function CharacterBackendEditor(props: CharacterBackendEditorProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = createSignal<string>(MAIN_TAB);
  const [adding, setAdding] = createSignal(false);
  const [newPath, setNewPath] = createSignal('');
  const [pathError, setPathError] = createSignal(false);

  const sortedPaths = createMemo(() => Object.keys(props.value.files).sort());
  const isMain = createMemo(() => activeTab() === MAIN_TAB);
  // A tab can vanish under us (delete) — fall back to main for the textarea.
  const activeSource = createMemo(() =>
    isMain() ? props.value.luaSource : (props.value.files[activeTab()] ?? ''),
  );

  const setFile = (path: string, content: string) => {
    props.onChange({ ...props.value, files: { ...props.value.files, [path]: content } });
  };

  const removeFile = (path: string) => {
    const { [path]: _removed, ...rest } = props.value.files;
    props.onChange({ ...props.value, files: rest });
    if (activeTab() === path) setActiveTab(MAIN_TAB);
  };

  const commitNewFile = () => {
    const key = validateVfsPath(newPath());
    if (key === null) {
      setPathError(true);
      return;
    }
    if (!(key in props.value.files)) setFile(key, '');
    setActiveTab(key);
    setAdding(false);
    setNewPath('');
    setPathError(false);
  };

  return (
    <div class="character-backend-editor">
      <label class="checkbox-row">
        <input
          type="checkbox"
          class="checkbox"
          checked={props.value.enabled}
          onChange={(e) => props.onChange({ ...props.value, enabled: e.currentTarget.checked })}
        />
        {t('character.backendEnabledLabel')}
      </label>

      <div class="backend-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={isMain()}
          class={`backend-file-tab${isMain() ? ' active' : ''}`}
          onClick={() => setActiveTab(MAIN_TAB)}
        >
          {t('character.backendFilesTabMain')}
        </button>
        <For each={sortedPaths()}>
          {(path) => (
            <span class={`backend-file-tab${activeTab() === path ? ' active' : ''}`} role="tab" aria-selected={activeTab() === path}>
              <button type="button" class="backend-file-tab-name" onClick={() => setActiveTab(path)}>
                {path}
              </button>
              <button
                type="button"
                class="backend-file-tab-delete"
                title={t('character.backendFileDelete')}
                aria-label={`${t('character.backendFileDelete')}: ${path}`}
                onClick={() => removeFile(path)}
              >
                ×
              </button>
            </span>
          )}
        </For>
        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              class="backend-file-add"
              title={t('character.backendFileAdd')}
              aria-label={t('character.backendFileAdd')}
              onClick={() => {
                setAdding(true);
                setPathError(false);
              }}
            >
              +
            </button>
          }
        >
          <input
            class="backend-file-path-input"
            value={newPath()}
            placeholder={t('character.backendFilePathPlaceholder')}
            onInput={(e) => {
              setNewPath(e.currentTarget.value);
              setPathError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNewFile();
              if (e.key === 'Escape') {
                setAdding(false);
                setNewPath('');
                setPathError(false);
              }
            }}
            autofocus
          />
        </Show>
      </div>
      <Show when={pathError()}>
        <span class="backend-file-path-error">{t('character.backendFileInvalidPath')}</span>
      </Show>

      <label class="field-label">
        {isMain() ? t('character.backendLuaSourceLabel') : activeTab()}
        <textarea
          class="textarea font-mono text-sm resize-v"
          rows={12}
          value={activeSource()}
          onInput={(e) => {
            const content = e.currentTarget.value;
            if (isMain()) {
              props.onChange({ ...props.value, luaSource: content });
            } else {
              setFile(activeTab(), content);
            }
          }}
          placeholder="function generate(prompt, ctx)&#10;  ...&#10;end"
        />
        <span class="hint-text">
          {isMain() ? t('character.backendLuaSourceHint') : t('character.backendFileModuleHint')}
        </span>
      </label>
      <Show when={props.characterId}>
        {(id) => (
          <BackendDryRunPanel
            luaSource={props.value.luaSource}
            characterId={id()}
            files={props.value.files}
          />
        )}
      </Show>
    </div>
  );
}
