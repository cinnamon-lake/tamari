import { createSignal, Show, For } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { confirmPopup, alertPopup } from '../stores/popupStore.js';
import { useI18n } from '../i18n/index.js';
import type { RegexRule } from '@tamari/types';
import { applyDisplayRules, parseRegexString } from '../lib/regexDisplay.js';
import { str } from '../lib/coerce.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import './RegexRulesModal.css';

function parseRegexRules(raw: unknown): RegexRule[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      id: str(r['id']),
      name: str(r['name']),
      findRegex: str(r['findRegex']),
      replaceString: str(r['replaceString']),
      ...(typeof r['replaceLua'] === 'string' && r['replaceLua'].length > 0 ? { replaceLua: r['replaceLua'] } : {}),
      disabled: Boolean(r['disabled']),
      userInput: Boolean(r['userInput']),
      aiOutput: Boolean(r['aiOutput']),
      prompt: Boolean(r['prompt']),
      display: Boolean(r['display']),
    }))
    .filter((r) => r.id && r.findRegex);
}

function emptyRegexRule(): RegexRule {
  return {
    id: '',
    name: '',
    findRegex: '',
    replaceString: '',
    disabled: false,
    userInput: false,
    aiOutput: true,
    prompt: false,
    display: false,
  };
}

export function RegexRulesModal(props: { onClose: () => void }) {
  const s = state.settings;
  const { t } = useI18n();

  saveFocus();

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  const sendSetting = (key: string, value: unknown) => {
    bus.send({ type: 'settings.set', key, value });
  };

  const [regexRules, setRegexRules] = createSignal<RegexRule[]>(parseRegexRules(s['regexRules']));
  const [editingRegex, setEditingRegex] = createSignal<RegexRule | null>(null);
  const [regexTestInput, setRegexTestInput] = createSignal('');

  const appendOnlyLayout = () => Boolean(state.settings['appendOnlyPromptLayout']);

  const startNewRegex = () => {
    setEditingRegex({ ...emptyRegexRule(), id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` });
    setRegexTestInput('');
  };

  const startEditRegex = (r: RegexRule) => {
    setEditingRegex({ ...r });
    setRegexTestInput('');
  };

  const deleteRegex = async (id: string) => {
    if (!(await confirmPopup(t('settings.regex.deleteConfirm')))) return;
    const next = regexRules().filter((r) => r.id !== id);
    setRegexRules(next);
    sendSetting('regexRules', next);
  };

  const saveRegexEdit = async () => {
    const r = editingRegex();
    if (!r) return;
    const name = r.name.trim();
    const findRegex = r.findRegex.trim();
    if (!name) {
      await alertPopup(t('settings.regex.nameRequired'));
      return;
    }
    if (!findRegex) {
      await alertPopup(t('settings.regex.findRequired'));
      return;
    }
    const parsed = parseRegexString(findRegex);
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

    const next = (() => {
      const prev = regexRules();
      const existing = prev.findIndex((x) => x.id === r.id);
      if (existing >= 0) {
        const arr = [...prev];
        arr[existing] = { ...r };
        return arr;
      }
      return [...prev, { ...r }];
    })();
    setRegexRules(next);
    setEditingRegex(null);
    sendSetting('regexRules', next);
  };

  const updateRegexField = (field: keyof RegexRule, value: string | boolean | undefined) => {
    setEditingRegex((prev) => (prev ? { ...prev, [field]: value } : null));
  };

  const regexTestOutput = () => {
    const r = editingRegex();
    if (!r || !r.findRegex) return '';
    // Lua replacements run server-side only — no client preview.
    if (r.replaceLua?.trim()) return t('settings.regex.luaNoPreview');
    try {
      return applyDisplayRules(regexTestInput(), [r]);
    } catch {
      return regexTestInput();
    }
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal regex-rules-modal" role="dialog" aria-modal="true" aria-label={t('settings.regex.heading')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <div class="modal-header-row">
          <h2 class="modal-title">{t('settings.regex.heading')}</h2>
          <button class="icon-btn" onClick={close} title={t('common.close')} aria-label={t('common.close')} type="button">
            <i class="bi bi-x-lg" />
          </button>
        </div>

        <p class="text-sm text-muted">
          {t('settings.regex.description')}
        </p>

        <div class="worldinfo-list">
          <For each={regexRules()}>
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
                  <button class="icon-btn small" onClick={() => startEditRegex(r)} title={t('common.edit')} aria-label={t('common.edit')} type="button">
                    <i class="bi bi-pencil" />
                  </button>
                  <button
                    class="icon-btn small danger"
                    onClick={() => deleteRegex(r.id)}
                    title={t('common.delete')} aria-label={t('common.delete')}
                    type="button"
                  >
                    <i class="bi bi-trash" />
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>

        <button class="btn btn-primary primary-btn" onClick={startNewRegex} type="button">
          <i class="bi bi-plus-lg" /> {t('settings.regex.new')}
        </button>

        <Show when={editingRegex()}>
          {(r) => (
            <div class="flex-col-sm mt-md">
              <h4 class="text-base">
                {regexRules().some((x) => x.id === r().id) ? t('settings.regex.editTitle') : t('settings.regex.new')}
              </h4>
              <label class="field-label">
                {t('common.name')}
                <input
                  value={r().name}
                  onInput={(e) => updateRegexField('name', e.currentTarget.value)}
                  placeholder={t('settings.regex.namePlaceholder')}
                  class="input"
                />
              </label>
              <label class="field-label">
                {t('settings.regex.findField')}
                <input
                  value={r().findRegex}
                  onInput={(e) => updateRegexField('findRegex', e.currentTarget.value)}
                  placeholder={t('settings.regex.findPlaceholder')}
                  class="input"
                />
              </label>
              <fieldset class="settings-radio-group">
                <legend class="settings-radio-label">{t('settings.regex.replaceTypeLegend')}</legend>
                <label class="radio-row">
                  <input
                    type="radio"
                    name="regexReplaceType"
                    checked={!r().replaceLua?.trim()}
                    onChange={() => updateRegexField('replaceLua', undefined)}
                    class="radio"
                  />
                  {t('settings.regex.replaceTypeText')}
                </label>
                <label class="radio-row">
                  <input
                    type="radio"
                    name="regexReplaceType"
                    checked={Boolean(r().replaceLua?.trim())}
                    onChange={() => {
                      if (!r().replaceLua?.trim()) {
                        updateRegexField('replaceLua', 'function replace(match, captures)\n  return match\nend');
                      }
                    }}
                    class="radio"
                  />
                  {t('settings.regex.replaceTypeLua')}
                </label>
              </fieldset>
              <Show
                when={r().replaceLua?.trim()}
                fallback={
                  <label class="field-label">
                    {t('settings.regex.replaceField')}
                    <textarea
                      rows={2}
                      value={r().replaceString}
                      onInput={(e) => updateRegexField('replaceString', e.currentTarget.value)}
                      placeholder={t('settings.regex.replacePlaceholder')}
                      class="textarea"
                    />
                  </label>
                }
              >
                <label class="field-label">
                  {t('settings.regex.luaReplaceField')}
                  <textarea
                    rows={6}
                    value={r().replaceLua}
                    onInput={(e) => updateRegexField('replaceLua', e.currentTarget.value)}
                    placeholder={t('settings.regex.luaReplacePlaceholder')}
                    class="textarea font-mono"
                  />
                  <span class="hint-text">{t('settings.regex.luaReplaceHint')}</span>
                </label>
              </Show>
              <div class="flex-between">
                <label class="checkbox-row">
                  <input
                    type="checkbox"
                    checked={r().prompt}
                    onChange={(e) => updateRegexField('prompt', e.currentTarget.checked)}
                    class="checkbox"
                  />
                  {t('settings.regex.placementPrompt')}
                </label>
                <label class="checkbox-row">
                  <input
                    type="checkbox"
                    checked={r().display}
                    onChange={(e) => updateRegexField('display', e.currentTarget.checked)}
                    class="checkbox"
                  />
                  {t('settings.regex.placementDisplay')}
                </label>
                <label class="checkbox-row">
                  <input
                    type="checkbox"
                    checked={r().disabled}
                    onChange={(e) => updateRegexField('disabled', e.currentTarget.checked)}
                    class="checkbox"
                  />
                  {t('settings.regex.disabledCheckbox')}
                </label>
              </div>
              <Show when={appendOnlyLayout() && r().prompt}>
                <span class="hint-text">{t('settings.regex.appendOnlyPromptNote')}</span>
              </Show>
              <div class="flex-between">
                <label class="checkbox-row">
                  <input
                    type="checkbox"
                    checked={r().userInput}
                    onChange={(e) => updateRegexField('userInput', e.currentTarget.checked)}
                    class="checkbox"
                  />
                  {t('settings.regex.placementUserInput')}
                </label>
                <label class="checkbox-row">
                  <input
                    type="checkbox"
                    checked={r().aiOutput}
                    onChange={(e) => updateRegexField('aiOutput', e.currentTarget.checked)}
                    class="checkbox"
                  />
                  {t('settings.regex.placementAiOutput')}
                </label>
              </div>

              {/* Test area */}
              <label class="field-label mt-sm">
                {t('settings.regex.testInput')}
                <textarea
                  rows={3}
                  value={regexTestInput()}
                  onInput={(e) => setRegexTestInput(e.currentTarget.value)}
                  placeholder={t('settings.regex.testInputPlaceholder')}
                  class="textarea"
                />
              </label>
              <label class="field-label">
                {t('settings.regex.testOutput')}
                <textarea rows={3} value={regexTestOutput()} readOnly class="bg-secondary" />
              </label>

              <div class="edit-actions">
                <button type="button" onClick={() => setEditingRegex(null)} class="btn">
                  {t('common.cancel')}
                </button>
                <button class="btn" type="button" onClick={saveRegexEdit}>
                  {t('settings.regex.saveRule')}
                </button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
