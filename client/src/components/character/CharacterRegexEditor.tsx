/**
 * Character-scoped regex rule editor (extensions.regexScripts).
 *
 * Mirrors the global regex editor in SettingsModal, but rules are owned by the
 * character and applied after global rules. Controlled component: the parent
 * owns the rules array and persists on `onChange`.
 */
import { createSignal, For, Show } from 'solid-js';
import { confirmPopup, alertPopup } from '../../stores/popupStore.js';
import { useI18n } from '../../i18n/index.js';
import { applyDisplayRules, parseRegexString } from '../../lib/regexDisplay.js';
import type { RegexRule } from '@tamari/types';

export interface CharacterRegexEditorProps {
  rules: RegexRule[];
  onChange: (next: RegexRule[]) => void;
}

function newRule(): RegexRule {
  return {
    id: crypto.randomUUID(),
    name: '',
    findRegex: '',
    replaceString: '',
    disabled: false,
    userInput: false,
    aiOutput: false,
    prompt: true,
    display: true,
  };
}

export function CharacterRegexEditor(props: CharacterRegexEditorProps) {
  const { t } = useI18n();
  const [editing, setEditing] = createSignal<RegexRule | null>(null);
  const [testInput, setTestInput] = createSignal('');

  const updateEditingField = <K extends keyof RegexRule>(key: K, value: RegexRule[K]) => {
    const r = editing();
    if (!r) return;
    setEditing({ ...r, [key]: value });
  };

  const saveEdit = async () => {
    const r = editing();
    if (!r) return;
    if (!r.name.trim()) {
      await alertPopup(t('settings.regex.nameRequired'));
      return;
    }
    if (!r.findRegex.trim()) {
      await alertPopup(t('settings.regex.findRequired'));
      return;
    }
    const parsed = parseRegexString(r.findRegex);
    if (!parsed) {
      await alertPopup(t('settings.regex.invalidFormat'));
      return;
    }
    try {
      new RegExp(parsed.pattern, parsed.flags);
    } catch {
      await alertPopup(t('settings.regex.invalidPattern'));
      return;
    }
    const exists = props.rules.some((x) => x.id === r.id);
    props.onChange(exists ? props.rules.map((x) => (x.id === r.id ? r : x)) : [...props.rules, r]);
    setEditing(null);
  };

  const removeRule = async (id: string) => {
    if (!(await confirmPopup(t('settings.regex.deleteConfirm')))) return;
    props.onChange(props.rules.filter((r) => r.id !== id));
  };

  const testOutput = () => {
    const r = editing();
    if (!r) return '';
    // Lua replacements run server-side only — no client preview.
    if (r.replaceLua?.trim()) return t('settings.regex.luaNoPreview');
    if (!parseRegexString(r.findRegex)) return testInput();
    return applyDisplayRules(testInput(), [{ ...r, disabled: false, display: true }]);
  };

  return (
    <div class="character-regex-editor">
      <div class="worldinfo-list">
        <For each={props.rules}>
          {(r) => (
            <div class="selectable-item worldinfo-item" id={r.id}>
              <div class="block">
                <div class="worldinfo-name">
                  {r.name} {r.disabled && <span class="text-danger">{t('settings.regex.disabledLabel')}</span>}
                </div>
                <div class="worldinfo-meta">
                  {r.findRegex} → {r.replaceLua?.trim() ? t('settings.regex.luaBadge') : r.replaceString || t('settings.regex.emptyLabel')}
                </div>
                <div class="worldinfo-meta">
                  {[
                    r.userInput && t('settings.regex.placementUserInput'),
                    r.aiOutput && t('settings.regex.placementAiOutput'),
                    r.prompt && t('settings.regex.placementPrompt'),
                    r.display && t('settings.regex.placementDisplay'),
                  ]
                    .filter(Boolean)
                    .join(' • ') || t('settings.regex.noPlacement')}
                </div>
              </div>
              <div class="section-actions">
                <button class="icon-btn small" onClick={() => setEditing({ ...r })} title={t('common.edit')} aria-label={t('common.edit')} type="button">
                  <i class="bi bi-pencil" />
                </button>
                <button class="icon-btn small danger" onClick={() => removeRule(r.id)} title={t('common.delete')} aria-label={t('common.delete')} type="button">
                  <i class="bi bi-trash" />
                </button>
              </div>
            </div>
          )}
        </For>
      </div>

      <button class="btn btn-sm" onClick={() => setEditing(newRule())} type="button">
        <i class="bi bi-plus-lg" /> {t('settings.regex.new')}
      </button>

      <Show when={editing()}>
        {(r) => (
          <div class="flex-col-sm mt-md regex-edit-form">
            <h4 class="text-base">
              {props.rules.some((x) => x.id === r().id) ? t('settings.regex.editTitle') : t('settings.regex.new')}
            </h4>
            <label class="field-label">
              {t('common.name')}
              <input value={r().name} onInput={(e) => updateEditingField('name', e.currentTarget.value)} placeholder={t('settings.regex.namePlaceholder')} class="input" />
            </label>
            <label class="field-label">
              {t('settings.regex.findField')}
              <input value={r().findRegex} onInput={(e) => updateEditingField('findRegex', e.currentTarget.value)} placeholder={t('settings.regex.findPlaceholder')} class="input" />
            </label>
            <div class="flex-row-sm">
              <button
                class="text-btn small"
                type="button"
                aria-pressed={!r().replaceLua?.trim()}
                onClick={() => updateEditingField('replaceLua', undefined)}
              >
                {t('settings.regex.replaceTypeText')}
              </button>
              <button
                class="text-btn small"
                type="button"
                aria-pressed={Boolean(r().replaceLua?.trim())}
                onClick={() => {
                  if (!r().replaceLua?.trim()) {
                    updateEditingField('replaceLua', 'function replace(match, captures)\n  return match\nend');
                  }
                }}
              >
                {t('settings.regex.replaceTypeLua')}
              </button>
            </div>
            <Show
              when={r().replaceLua?.trim()}
              fallback={
                <label class="field-label">
                  {t('settings.regex.replaceField')}
                  <textarea rows={2} value={r().replaceString} onInput={(e) => updateEditingField('replaceString', e.currentTarget.value)} placeholder={t('settings.regex.replacePlaceholder')} class="textarea" />
                </label>
              }
            >
              <label class="field-label">
                {t('settings.regex.luaReplaceField')}
                <textarea rows={6} value={r().replaceLua} onInput={(e) => updateEditingField('replaceLua', e.currentTarget.value)} placeholder={t('settings.regex.luaReplacePlaceholder')} class="textarea font-mono" />
                <span class="hint-text">{t('settings.regex.luaReplaceHint')}</span>
              </label>
            </Show>
            <div class="flex-between">
              <label class="checkbox-row">
                <input type="checkbox" checked={r().prompt} onChange={(e) => updateEditingField('prompt', e.currentTarget.checked)} class="checkbox" />
                {t('settings.regex.placementPrompt')}
              </label>
              <label class="checkbox-row">
                <input type="checkbox" checked={r().display} onChange={(e) => updateEditingField('display', e.currentTarget.checked)} class="checkbox" />
                {t('settings.regex.placementDisplay')}
              </label>
              <label class="checkbox-row">
                <input type="checkbox" checked={r().disabled} onChange={(e) => updateEditingField('disabled', e.currentTarget.checked)} class="checkbox" />
                {t('settings.regex.disabledCheckbox')}
              </label>
            </div>
            <div class="flex-between">
              <label class="checkbox-row">
                <input type="checkbox" checked={r().userInput} onChange={(e) => updateEditingField('userInput', e.currentTarget.checked)} class="checkbox" />
                {t('settings.regex.placementUserInput')}
              </label>
              <label class="checkbox-row">
                <input type="checkbox" checked={r().aiOutput} onChange={(e) => updateEditingField('aiOutput', e.currentTarget.checked)} class="checkbox" />
                {t('settings.regex.placementAiOutput')}
              </label>
            </div>

            <label class="field-label mt-sm">
              {t('settings.regex.testInput')}
              <textarea rows={3} value={testInput()} onInput={(e) => setTestInput(e.currentTarget.value)} placeholder={t('settings.regex.testInputPlaceholder')} class="textarea" />
            </label>
            <label class="field-label">
              {t('settings.regex.testOutput')}
              <textarea rows={3} value={testOutput()} readOnly class="bg-secondary" />
            </label>

            <div class="edit-actions">
              <button type="button" onClick={() => setEditing(null)} class="btn">
                {t('common.cancel')}
              </button>
              <button class="btn" type="button" onClick={saveEdit}>
                {t('settings.regex.saveRule')}
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
