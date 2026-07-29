/**
 * Character-coupled backend logic editor (extensions.contextualBackend).
 *
 * A Lua script owned by the character card (ported triggerlua / simulator
 * logic) rather than by the global custom-backend registry. Stored inline in
 * extensions so it travels with card export. Controlled component: the parent
 * owns the value and persists on `onChange` (mirrors CharacterRegexEditor).
 */
import { Show } from 'solid-js';
import { useI18n } from '../../i18n/index.js';
import { BackendDryRunPanel } from '../BackendDryRunPanel.js';

export interface CharacterBackendLogic {
  enabled: boolean;
  luaSource: string;
}

export interface CharacterBackendEditorProps {
  value: CharacterBackendLogic;
  onChange: (next: CharacterBackendLogic) => void;
  /** When set, a dry-run panel is embedded (sends characterId so the server
   *  weaves this character's description/firstMes into the sample prompt). */
  characterId?: string;
}

/** Tolerant parse of the contextualBackend extension blob. */
export function parseCharacterBackendLogic(
  extensions: Record<string, unknown> | undefined,
): CharacterBackendLogic {
  const raw = extensions?.['contextualBackend'];
  if (!raw || typeof raw !== 'object') return { enabled: false, luaSource: '' };
  const ext = raw as Record<string, unknown>;
  return {
    enabled: ext['enabled'] === true,
    luaSource: typeof ext['luaSource'] === 'string' ? ext['luaSource'] : '',
  };
}

export function CharacterBackendEditor(props: CharacterBackendEditorProps) {
  const { t } = useI18n();

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
      <label class="field-label">
        {t('character.backendLuaSourceLabel')}
        <textarea
          class="textarea font-mono text-sm resize-v"
          rows={12}
          value={props.value.luaSource}
          onInput={(e) => props.onChange({ ...props.value, luaSource: e.currentTarget.value })}
          placeholder="function generate(prompt, ctx)&#10;  ...&#10;end"
        />
        <span class="hint-text">{t('character.backendLuaSourceHint')}</span>
      </label>
      <Show when={props.characterId}>
        {(id) => <BackendDryRunPanel luaSource={props.value.luaSource} characterId={id()} />}
      </Show>
    </div>
  );
}
