import { createSignal, createMemo, Show, For } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { useI18n, type Locale } from '../i18n/index.js';
import { Modal } from './Modal.js';
import { SchemaForm } from './SchemaForm.js';
import {
  toSchema,
  initialValues,
  displayFields,
  chatBehaviorFields,
  interactionFields,
  generationFields,
  postProcessingFields,
  soundStreamingFields,
  notificationFields,
  memoryFields,
  securityFields,
  themeFields,
  developerFields,
} from './settingsSchema.js';
import './SettingsModal.css';

// Field groups driving the schema form. Sections not listed here (Language,
// plus the special blocks inside Generation/Memory/Developer) stay hand-rolled.
const TOP_LEVEL_GROUPS = [
  displayFields,
  chatBehaviorFields,
  interactionFields,
  generationFields,
  postProcessingFields,
  soundStreamingFields,
  notificationFields,
  securityFields,
  themeFields,
  developerFields,
] as const;

export function SettingsModal(props: { onClose: () => void }) {
  const s = state.settings;
  const { t, locale, setLocale, available } = useI18n();

  const close = () => props.onClose();

  // One record for the whole modal (plus a separate one for the nested memory
  // object), seeded from a mount-time snapshot of state.settings — the form
  // deliberately does not track later settings.changed pushes. Defaults match
  // the pre-refactor per-key fallbacks (see settingsSchema.ts).
  const topLevelFields = TOP_LEVEL_GROUPS.flatMap((fields) => fields(t));
  const initial = initialValues(topLevelFields, s);
  // Legacy `noShadows: true` maps to shadow width 0; moving the slider clears it.
  if (s['noShadows']) initial['shadowWidth'] = 0;
  const [values, setValues] = createSignal<Record<string, unknown>>(initial);

  const [memoryValues, setMemoryValues] = createSignal<Record<string, unknown>>(
    // The `?? {}` guards the brief window before `settings.loaded` arrives.
    initialValues(memoryFields(t, []), { ...(s['memory'] ?? {}) }),
  );

  // The custom-stopping-strings list editor has no SchemaForm control type.
  const [customStoppingStrings, setCustomStoppingStrings] = createSignal<string[]>(
    Array.isArray(s['customStoppingStrings']) ? s['customStoppingStrings'] : [],
  );

  const [proxyApiKey, setProxyApiKey] = createSignal(String(s['proxyApi.apiKey'] ?? ''));

  const sendSetting = (key: string, value: unknown) => {
    bus.send({ type: 'settings.set', key, value });
  };

  const commitSetting = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    sendSetting(key, value);
    // Clear the legacy kill-switch so it can't pin shadows to off.
    if (key === 'shadowWidth' && s['noShadows']) sendSetting('noShadows', false);
  };

  const commitMemory = (key: string, value: unknown) => {
    const next = { ...memoryValues(), [key]: value };
    setMemoryValues(next);
    sendSetting('memory', next);
  };

  // Rotate the proxy API key: generate client-side, persist via settings.
  const flushProxyKey = () => {
    const key = crypto.randomUUID();
    setProxyApiKey(key);
    sendSetting('proxyApi.apiKey', key);
  };

  // Schemas rebuild on locale switch so labels/hints retranslate live.
  const schemas = TOP_LEVEL_GROUPS.map((fields) => createMemo(() => toSchema(fields(t))));
  const [
    displaySchema,
    chatBehaviorSchema,
    interactionSchema,
    generationSchema,
    postProcessingSchema,
    soundStreamingSchema,
    notificationSchema,
    securitySchema,
    themeSchema,
    developerSchema,
  ] = schemas as [
    () => Record<string, unknown>,
    () => Record<string, unknown>,
    () => Record<string, unknown>,
    () => Record<string, unknown>,
    () => Record<string, unknown>,
    () => Record<string, unknown>,
    () => Record<string, unknown>,
    () => Record<string, unknown>,
    () => Record<string, unknown>,
    () => Record<string, unknown>,
  ];
  const memorySchema = createMemo(() => toSchema(memoryFields(t, state.backendConfigs)));

  const appendOnlyLayout = () => Boolean(values()['appendOnlyPromptLayout']);
  const proxyEnabled = () => Boolean(values()['proxyApi.enabled']);

  return (
    <Modal title={t('settings.title')} onClose={close} class="modal settings-modal" ariaLabel={t('settings.title')}>
      {/* Language */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.language.heading')}</h3>
        <label class="field-label">
          {t('settings.language.label')}
          <select class="select" value={locale()} onChange={(e) => setLocale(e.currentTarget.value as Locale)}>
            <For each={available}>
              {(l) => (
                <option value={l.code} class="select-option">
                  {l.nativeName}
                </option>
              )}
            </For>
          </select>
        </label>
      </section>

      {/* Display Settings */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.display.heading')}</h3>
        <SchemaForm variant="inline" schema={displaySchema()} value={values()} onFieldChange={commitSetting} />
      </section>

      {/* Chat Behavior Settings */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.chatBehavior.heading')}</h3>
        <SchemaForm variant="inline" schema={chatBehaviorSchema()} value={values()} onFieldChange={commitSetting} />
      </section>

      {/* Input & Interaction Settings */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.interaction.heading')}</h3>
        <SchemaForm variant="inline" schema={interactionSchema()} value={values()} onFieldChange={commitSetting} />
      </section>

      {/* Generation Settings */}
      <section class="settings-section" data-testid="settings-section-generation">
        <h3 class="section-heading">{t('settings.generation.heading')}</h3>
        <label class="field-label">
          {t('settings.generation.customStoppingStrings')}
          <div class="stack-xs">
            <For each={customStoppingStrings()}>
              {(str, index) => (
                <div class="input-row" id={`stop-str-${index()}`}>
                  <input
                    type="text"
                    data-testid="stop-string-input"
                    value={str}
                    onChange={(e) => {
                      const next = [...customStoppingStrings()];
                      next[index()] = e.currentTarget.value;
                      setCustomStoppingStrings(next);
                      sendSetting('customStoppingStrings', next);
                    }}
                    class="flex-1"
                  />
                  <button
                    type="button"
                    class="icon-btn small danger"
                    onClick={() => {
                      const next = [...customStoppingStrings()];
                      next.splice(index(), 1);
                      setCustomStoppingStrings(next);
                      sendSetting('customStoppingStrings', next);
                    }}
                    title={t('common.remove')}
                    aria-label={t('common.remove')}
                  >
                    <i class="bi bi-trash" />
                  </button>
                </div>
              )}
            </For>
            <button
              type="button"
              class="text-btn small"
              data-testid="add-stop-string"
              onClick={() => {
                const next = [...customStoppingStrings(), ''];
                setCustomStoppingStrings(next);
                sendSetting('customStoppingStrings', next);
              }}
            >
              <i class="bi bi-plus" /> {t('settings.generation.addStopString')}
            </button>
          </div>
        </label>
        <SchemaForm variant="inline" schema={generationSchema()} value={values()} onFieldChange={commitSetting} />
      </section>

      {/* Post-processing Settings */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.postProcessing.heading')}</h3>

        <Show when={appendOnlyLayout()}>
          <p class="hint-text">{t('settings.postProcessing.disabledByAppendOnly')}</p>
        </Show>

        <SchemaForm variant="inline" schema={postProcessingSchema()} value={values()} onFieldChange={commitSetting} />
      </section>

      {/* Sound & Streaming Settings */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.soundStreaming.heading')}</h3>
        <SchemaForm variant="inline" schema={soundStreamingSchema()} value={values()} onFieldChange={commitSetting} />
      </section>

      {/* Notifications Settings */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.notifications.heading')}</h3>
        <SchemaForm variant="inline" schema={notificationSchema()} value={values()} onFieldChange={commitSetting} />
      </section>

      {/* Memory Settings */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.memory.heading')}</h3>
        <p class="text-sm text-muted">{t('settings.memory.description')}</p>
        <SchemaForm variant="inline" schema={memorySchema()} value={memoryValues()} onFieldChange={commitMemory} />
      </section>

      {/* Security & Content Settings */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.security.heading')}</h3>
        <SchemaForm variant="inline" schema={securitySchema()} value={values()} onFieldChange={commitSetting} />
      </section>

      {/* Theme Settings */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.theme.heading')}</h3>
        <SchemaForm variant="inline" schema={themeSchema()} value={values()} onFieldChange={commitSetting} />
      </section>

      {/* Developer Settings */}
      <section class="settings-section">
        <h3 class="section-heading">{t('settings.developer.heading')}</h3>
        <SchemaForm variant="inline" schema={developerSchema()} value={values()} onFieldChange={commitSetting} />
        <Show when={proxyEnabled()}>
          <label class="field-label">
            {t('settings.developer.proxyApiKey')}
            <div class="input-row">
              <input
                type="text"
                readOnly
                value={proxyApiKey()}
                onFocus={(e) => e.currentTarget.select()}
                class="flex-1"
              />
              <button type="button" class="btn btn-sm" onClick={flushProxyKey}>
                {t('settings.developer.proxyFlush')}
              </button>
            </div>
          </label>
          <span class="hint-text">{t('settings.developer.proxyFlushHint')}</span>
        </Show>
      </section>

      <div class="modal-actions">
        <button onClick={close} class="btn">
          {t('common.close')}
        </button>
      </div>
    </Modal>
  );
}
