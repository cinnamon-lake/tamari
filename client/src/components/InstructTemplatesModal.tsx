import { createSignal, Show, For } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { confirmPopup, alertPopup } from '../stores/popupStore.js';
import { useI18n } from '../i18n/index.js';
import { str } from '../lib/coerce.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import './InstructTemplatesModal.css';

interface InstructTemplateDef {
  id: string;
  name: string;
  bos?: string;
  eos?: string;
  separator?: string;
  systemPrefix?: string;
  systemSuffix?: string;
  userPrefix?: string;
  userSuffix?: string;
  assistantPrefix?: string;
  assistantSuffix?: string;
  responsePrefix?: string;
}

const BUILTIN_TEMPLATE_IDS = new Set(['none', 'alpaca', 'chatml', 'llama2', 'llama3', 'mistral']);

function emptyTemplate(): InstructTemplateDef {
  return {
    id: '',
    name: '',
    separator: '\n\n',
    systemPrefix: '',
    systemSuffix: '',
    userPrefix: '',
    userSuffix: '',
    assistantPrefix: '',
    assistantSuffix: '',
    responsePrefix: '',
  };
}

function parseTemplates(raw: unknown): InstructTemplateDef[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      id: str(t['id']),
      name: str(t['name']),
      bos: t['bos'] !== undefined ? str(t['bos']) : undefined,
      eos: t['eos'] !== undefined ? str(t['eos']) : undefined,
      separator: t['separator'] !== undefined ? str(t['separator']) : undefined,
      systemPrefix: t['systemPrefix'] !== undefined ? str(t['systemPrefix']) : undefined,
      systemSuffix: t['systemSuffix'] !== undefined ? str(t['systemSuffix']) : undefined,
      userPrefix: t['userPrefix'] !== undefined ? str(t['userPrefix']) : undefined,
      userSuffix: t['userSuffix'] !== undefined ? str(t['userSuffix']) : undefined,
      assistantPrefix: t['assistantPrefix'] !== undefined ? str(t['assistantPrefix']) : undefined,
      assistantSuffix: t['assistantSuffix'] !== undefined ? str(t['assistantSuffix']) : undefined,
      responsePrefix: t['responsePrefix'] !== undefined ? str(t['responsePrefix']) : undefined,
    }))
    .filter((t) => t.id && !BUILTIN_TEMPLATE_IDS.has(t.id));
}

export function InstructTemplatesModal(props: { onClose: () => void }) {
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

  const [templates, setTemplates] = createSignal<InstructTemplateDef[]>(parseTemplates(s['instructTemplates']));
  const [editingTemplate, setEditingTemplate] = createSignal<InstructTemplateDef | null>(null);

  const startNewTemplate = () => {
    setEditingTemplate(emptyTemplate());
  };

  const startEditTemplate = (t: InstructTemplateDef) => {
    setEditingTemplate({ ...t });
  };

  const deleteTemplate = async (id: string) => {
    if (!(await confirmPopup(t('settings.templates.deleteConfirm')))) return;
    const next = templates().filter((t) => t.id !== id);
    setTemplates(next);
    sendSetting('instructTemplates', next);
  };

  const saveTemplateEdit = async () => {
    const tpl = editingTemplate();
    if (!tpl) return;
    const id = tpl.id.trim();
    const name = tpl.name.trim();
    if (!id) {
      await alertPopup(t('settings.templates.idRequired'));
      return;
    }
    if (!name) {
      await alertPopup(t('settings.templates.nameRequired'));
      return;
    }
    if (BUILTIN_TEMPLATE_IDS.has(id)) {
      await alertPopup(t('settings.templates.reservedId', { id }));
      return;
    }

    const next = (() => {
      const prev = templates();
      const existing = prev.findIndex((x) => x.id === id);
      if (existing >= 0) {
        const arr = [...prev];
        arr[existing] = { ...tpl, id, name };
        return arr;
      }
      return [...prev, { ...tpl, id, name }];
    })();
    setTemplates(next);
    setEditingTemplate(null);
    sendSetting('instructTemplates', next);
  };

  const updateEditingField = (field: keyof InstructTemplateDef, value: string) => {
    setEditingTemplate((prev) => (prev ? { ...prev, [field]: value } : null));
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal instruct-templates-modal" role="dialog" aria-modal="true" aria-label={t('settings.templates.heading')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <div class="modal-header-row">
          <h2 class="modal-title">{t('settings.templates.heading')}</h2>
          <button class="icon-btn" onClick={close} title={t('common.close')} aria-label={t('common.close')} type="button">
            <i class="bi bi-x-lg" />
          </button>
        </div>

        <p class="text-sm text-muted">
          {t('settings.templates.description')}
        </p>

        <div class="worldinfo-list">
          <For each={templates()}>
            {(tpl) => (
              <div class="selectable-item worldinfo-item" id={tpl.id}>
                <div class="block">
                  <div class="worldinfo-name">{tpl.name}</div>
                  <div class="worldinfo-meta">{t('settings.templates.idLabel', { id: tpl.id })}</div>
                </div>
                <div class="section-actions">
                  <button class="icon-btn small" onClick={() => startEditTemplate(tpl)} title={t('common.edit')} aria-label={t('common.edit')} type="button">
                    <i class="bi bi-pencil" />
                  </button>
                  <button
                    class="icon-btn small danger"
                    onClick={() => deleteTemplate(tpl.id)}
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

        <button class="btn btn-primary primary-btn" onClick={startNewTemplate} type="button">
          <i class="bi bi-plus-lg" /> {t('settings.templates.new')}
        </button>

        <Show when={editingTemplate()}>
          {(tpl) => (
            <div class="flex-col-sm mt-md">
              <h4 class="text-base">{templates().some((x) => x.id === tpl().id) ? t('settings.templates.editTitle') : t('settings.templates.new')}</h4>
              <div class="row-equal">
                <label class="field-label">
                  {t('settings.templates.idField')}
                  <input
                    value={tpl().id}
                    onInput={(e) => updateEditingField('id', e.currentTarget.value)}
                    placeholder={t('settings.templates.idPlaceholder')}
                    class="input"
                  />
                </label>
                <label class="field-label">
                  {t('settings.templates.nameField')}
                  <input
                    value={tpl().name}
                    onInput={(e) => updateEditingField('name', e.currentTarget.value)}
                    placeholder={t('settings.templates.namePlaceholder')}
                    class="input"
                  />
                </label>
              </div>
              <div class="row-equal">
                <label class="field-label">
                  {t('settings.templates.bosField')}
                  <input
                    value={tpl().bos ?? ''}
                    onInput={(e) => updateEditingField('bos', e.currentTarget.value)}
                    placeholder="&lt;s&gt;"
                    class="input"
                  />
                </label>
                <label class="field-label">
                  {t('settings.templates.eosField')}
                  <input
                    value={tpl().eos ?? ''}
                    onInput={(e) => updateEditingField('eos', e.currentTarget.value)}
                    placeholder="&lt;/s&gt;"
                    class="input"
                  />
                </label>
              </div>
              <label class="field-label">
                {t('settings.templates.separatorField')}
                <input
                  value={tpl().separator ?? ''}
                  onInput={(e) => updateEditingField('separator', e.currentTarget.value)}
                  placeholder="\\n\\n"
                  class="input"
                />
              </label>
              <div class="row-equal">
                <label class="field-label">
                  {t('settings.templates.systemPrefixField')}
                  <input
                    value={tpl().systemPrefix ?? ''}
                    onInput={(e) => updateEditingField('systemPrefix', e.currentTarget.value)}
                    class="input"
                  />
                </label>
                <label class="field-label">
                  {t('settings.templates.systemSuffixField')}
                  <input
                    value={tpl().systemSuffix ?? ''}
                    onInput={(e) => updateEditingField('systemSuffix', e.currentTarget.value)}
                    class="input"
                  />
                </label>
              </div>
              <div class="row-equal">
                <label class="field-label">
                  {t('settings.templates.userPrefixField')}
                  <input
                    value={tpl().userPrefix ?? ''}
                    onInput={(e) => updateEditingField('userPrefix', e.currentTarget.value)}
                    class="input"
                  />
                </label>
                <label class="field-label">
                  {t('settings.templates.userSuffixField')}
                  <input
                    value={tpl().userSuffix ?? ''}
                    onInput={(e) => updateEditingField('userSuffix', e.currentTarget.value)}
                    class="input"
                  />
                </label>
              </div>
              <div class="row-equal">
                <label class="field-label">
                  {t('settings.templates.assistantPrefixField')}
                  <input
                    value={tpl().assistantPrefix ?? ''}
                    onInput={(e) => updateEditingField('assistantPrefix', e.currentTarget.value)}
                    class="input"
                  />
                </label>
                <label class="field-label">
                  {t('settings.templates.assistantSuffixField')}
                  <input
                    value={tpl().assistantSuffix ?? ''}
                    onInput={(e) => updateEditingField('assistantSuffix', e.currentTarget.value)}
                    class="input"
                  />
                </label>
              </div>
              <label class="field-label">
                {t('settings.templates.responsePrefixField')}
                <input
                  value={tpl().responsePrefix ?? ''}
                  onInput={(e) => updateEditingField('responsePrefix', e.currentTarget.value)}
                  class="input"
                />
              </label>
              <div class="edit-actions">
                <button type="button" onClick={() => setEditingTemplate(null)} class="btn">
                  {t('common.cancel')}
                </button>
                <button class="btn" type="button" onClick={saveTemplateEdit}>
                  {t('settings.templates.saveTemplate')}
                </button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
