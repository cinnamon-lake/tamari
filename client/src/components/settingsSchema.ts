/**
 * SettingsModal form schema.
 *
 * Every hand-rolled label/control pair in the modal is described here as data
 * and rendered by SchemaForm's `inline` variant. `key` is the exact server
 * settings key (dotted keys included), `default` reproduces the modal's
 * historical fallback (NOT necessarily the zod default in
 * packages/types — e.g. `blurStrength` defaults to 1 here), and labels/hints
 * are the existing i18n strings so the rendered text is unchanged.
 *
 * Control types SchemaForm does not cover stay hand-rolled in the modal:
 * the locale picker, the custom-stopping-strings list editor, the memory
 * backend selector's dynamic options (passed in here), and the proxy-key
 * rotate row.
 */

import type { I18nApi } from '../i18n/index.js';

type T = I18nApi['t'];

export interface SettingsFieldDef {
  /** Server settings key (or memory sub-key for the memory section). */
  key: string;
  type: 'boolean' | 'number' | 'string';
  format?: 'range' | 'radio' | 'textarea';
  label: string;
  hint?: string;
  hintOutside?: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
  optionClass?: string;
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  placeholder?: string;
  disabledWhen?: { key: string; is: boolean };
  visibleWhen?: { key: string; is: boolean };
  valueHint?: { format: string; decimals?: number; offLabel?: string };
}

/** Serialize field descriptors into the JSON-schema shape SchemaForm parses. */
export function toSchema(fields: SettingsFieldDef[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    const { key, label, hint, ...rest } = f;
    properties[key] = { ...rest, title: label, description: hint };
  }
  return { properties };
}

/**
 * Mount-time snapshot of the form record: stored value where present, else the
 * field default. The form intentionally does NOT track later settings.changed
 * pushes (the pre-refactor per-key signals were mount-time snapshots too).
 */
export function initialValues(fields: SettingsFieldDef[], stored: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const f of fields) {
    record[f.key] = stored[f.key] ?? f.default;
  }
  return record;
}

export function displayFields(t: T): SettingsFieldDef[] {
  return [
    {
      key: 'chatStyle',
      type: 'string',
      label: t('settings.display.chatStyle'),
      default: 'default',
      options: [
        { value: 'default', label: t('settings.display.chatStyleDefault') },
        { value: 'bubbles', label: t('settings.display.chatStyleBubbles') },
        { value: 'document', label: t('settings.display.chatStyleDocument') },
      ],
    },
    {
      key: 'avatarStyle',
      type: 'string',
      label: t('settings.display.avatarStyle'),
      default: 'round',
      disabledWhen: { key: 'hideChatAvatars', is: true },
      options: [
        { value: 'round', label: t('settings.display.avatarStyleRound') },
        { value: 'rectangular', label: t('settings.display.avatarStyleRectangular') },
        { value: 'square', label: t('settings.display.avatarStyleSquare') },
        { value: 'rounded', label: t('settings.display.avatarStyleRounded') },
      ],
    },
    {
      key: 'fontScale',
      type: 'number',
      format: 'range',
      label: t('settings.display.fontScale'),
      default: 1,
      min: 0.8,
      max: 1.5,
      step: 0.05,
      valueHint: { format: '{value}x', decimals: 2 },
    },
    {
      key: 'chatWidth',
      type: 'number',
      format: 'range',
      label: t('settings.display.chatWidth'),
      default: 50,
      min: 30,
      max: 70,
      step: 1,
      valueHint: { format: '{value}rem', decimals: 0 },
    },
    {
      key: 'shadowWidth',
      type: 'number',
      format: 'range',
      label: t('settings.display.shadowWidth'),
      default: 1,
      min: 0,
      max: 2,
      step: 0.25,
      valueHint: { format: '{value}x', decimals: 2, offLabel: t('settings.display.shadowsOff') },
    },
    {
      key: 'blurStrength',
      type: 'number',
      format: 'range',
      label: t('settings.display.backdropBlur'),
      default: 1,
      min: 0,
      max: 2,
      step: 0.25,
      valueHint: { format: '{value}x', decimals: 2 },
    },
    { key: 'compactInputArea', type: 'boolean', label: t('settings.display.compactInput'), default: false },
    { key: 'reducedMotion', type: 'boolean', label: t('settings.display.reducedMotion'), default: false },
    { key: 'hideChatAvatars', type: 'boolean', label: t('settings.display.hideAvatars'), default: false },
    { key: 'hideChatNames', type: 'boolean', label: t('settings.display.hideNames'), default: false },
    { key: 'swipeNumbersOnAllMessages', type: 'boolean', label: t('settings.display.swipeNumbersAll'), default: false },
    { key: 'showMessageIds', type: 'boolean', label: t('settings.display.showMessageIds'), default: false },
    { key: 'timestampModelIcon', type: 'boolean', label: t('settings.display.showModelInTimestamps'), default: false },
    { key: 'timerEnabled', type: 'boolean', label: t('settings.display.showTimer'), default: false },
    { key: 'encodeTags', type: 'boolean', label: t('settings.display.encodeTags'), default: false },
    {
      key: 'showHotswapBar',
      type: 'boolean',
      label: t('settings.display.showHotswapBar'),
      hint: t('settings.display.showHotswapBarHint'),
      default: true,
    },
    {
      key: 'mediaDisplayMode',
      type: 'string',
      label: t('settings.display.mediaMode'),
      default: 'list',
      options: [
        { value: 'list', label: t('settings.display.mediaModeList') },
        { value: 'grid', label: t('settings.display.mediaModeGrid') },
      ],
    },
    {
      key: 'fuzzySearch',
      type: 'boolean',
      label: t('settings.display.fuzzySearch'),
      hint: t('settings.display.fuzzySearchHint'),
      default: false,
    },
  ];
}

export function chatBehaviorFields(t: T): SettingsFieldDef[] {
  return [
    {
      key: 'confirmMessageDelete',
      type: 'boolean',
      label: t('settings.behavior.confirmMessageDelete'),
      default: false,
    },
    { key: 'useSoftFork', type: 'boolean', label: t('settings.behavior.useSoftFork'), default: false },
    { key: 'autoSaveMessageEdits', type: 'boolean', label: t('settings.behavior.autoSaveEdits'), default: false },
    { key: 'restoreUserInput', type: 'boolean', label: t('settings.behavior.restoreUserInput'), default: false },
    { key: 'autoLoadLastChat', type: 'boolean', label: t('settings.behavior.autoLoadLastChat'), default: false },
    { key: 'showHiddenMessages', type: 'boolean', label: t('settings.behavior.showHiddenMessages'), default: false },
    { key: 'autoScrollToBottom', type: 'boolean', label: t('settings.behavior.autoScroll'), default: true },
    {
      key: 'disableGroupTrimming',
      type: 'boolean',
      label: t('settings.behavior.disableGroupTrimming'),
      default: false,
    },
    {
      key: 'chatMessageLoadLimit',
      type: 'number',
      label: t('settings.generation.chatMessageLoadLimit'),
      hint: t('settings.generation.chatMessageLoadLimitHint'),
      default: 30,
      min: 1,
      max: 10000,
    },
  ];
}

export function interactionFields(t: T): SettingsFieldDef[] {
  return [
    {
      key: 'sendOnEnter',
      type: 'string',
      label: t('settings.behavior.sendOnEnter'),
      default: 'auto',
      options: [
        { value: 'auto', label: t('settings.behavior.sendOnEnterAuto') },
        { value: 'enabled', label: t('settings.behavior.sendOnEnterEnabled') },
        { value: 'disabled', label: t('settings.behavior.sendOnEnterDisabled') },
      ],
    },
    { key: 'messageTokenCountEnabled', type: 'boolean', label: t('settings.behavior.showTokenCounts'), default: false },
    { key: 'quickContinue', type: 'boolean', label: t('settings.behavior.showQuickContinue'), default: false },
    { key: 'quickImpersonate', type: 'boolean', label: t('settings.behavior.showQuickImpersonate'), default: false },
    { key: 'hideQuickReplies', type: 'boolean', label: t('settings.behavior.hideQuickReplies'), default: false },
    { key: 'clickToEdit', type: 'boolean', label: t('settings.interaction.clickToEdit'), default: false },
    { key: 'autoSelectInput', type: 'boolean', label: t('settings.interaction.autoFocusInput'), default: false },
    { key: 'neverResizeAvatars', type: 'boolean', label: t('settings.interaction.neverResizeAvatars'), default: false },
  ];
}

/** Generation fields rendered after the hand-rolled stop-strings editor. */
export function generationFields(t: T): SettingsFieldDef[] {
  const appendOnly = { key: 'appendOnlyPromptLayout', is: true };
  return [
    {
      key: 'customStoppingStringsMacro',
      type: 'boolean',
      label: t('settings.generation.resolveStoppingMacros'),
      default: false,
      disabledWhen: appendOnly,
    },
    { key: 'stripExamples', type: 'boolean', label: t('settings.generation.stripExamples'), default: false },
    { key: 'autoContinueEnabled', type: 'boolean', label: t('settings.generation.autoContinue'), default: false },
    {
      key: 'autoContinueTargetLength',
      type: 'number',
      label: t('settings.generation.autoContinueTargetLength'),
      hint: t('settings.generation.autoContinueTargetLengthHint'),
      default: 100,
      min: 10,
      max: 2000,
      visibleWhen: { key: 'autoContinueEnabled', is: true },
    },
    {
      key: 'mediaVerboseMode',
      type: 'boolean',
      label: t('settings.generation.mediaVerbose'),
      hint: t('settings.generation.mediaVerboseHint'),
      default: false,
    },
    {
      key: 'appendOnlyPromptLayout',
      type: 'boolean',
      label: t('settings.generation.appendOnlyLayout'),
      hint: t('settings.generation.appendOnlyLayoutHint'),
      hintOutside: true,
      default: false,
    },
  ];
}

export function postProcessingFields(t: T): SettingsFieldDef[] {
  const appendOnly = { key: 'appendOnlyPromptLayout', is: true };
  return [
    {
      key: 'removeXML',
      type: 'boolean',
      label: t('settings.postProcessing.removeXml'),
      default: false,
      disabledWhen: appendOnly,
    },
    {
      key: 'singleLine',
      type: 'boolean',
      label: t('settings.postProcessing.singleLine'),
      default: false,
      disabledWhen: appendOnly,
    },
    {
      key: 'trimSentences',
      type: 'boolean',
      label: t('settings.postProcessing.trimSentences'),
      default: false,
      disabledWhen: appendOnly,
    },
    {
      key: 'autoFixGeneratedMarkdown',
      type: 'boolean',
      label: t('settings.postProcessing.autoFixMarkdown'),
      default: false,
      disabledWhen: appendOnly,
    },
  ];
}

export function soundStreamingFields(t: T): SettingsFieldDef[] {
  return [
    { key: 'messageSoundEnabled', type: 'boolean', label: t('settings.soundStreaming.playSound'), default: false },
    {
      key: 'messageSoundUnfocusedOnly',
      type: 'boolean',
      label: t('settings.soundStreaming.unfocusedOnly'),
      default: true,
      disabledWhen: { key: 'messageSoundEnabled', is: false },
    },
    { key: 'smoothStreaming', type: 'boolean', label: t('settings.soundStreaming.smoothStreaming'), default: false },
    {
      key: 'smoothStreamingDelay',
      type: 'number',
      label: t('settings.soundStreaming.tokenDelay'),
      default: 25,
      min: 5,
      max: 500,
      disabledWhen: { key: 'smoothStreaming', is: false },
    },
    { key: 'streamFadeIn', type: 'boolean', label: t('settings.soundStreaming.fadeIn'), default: true },
  ];
}

export function notificationFields(t: T): SettingsFieldDef[] {
  return [
    {
      key: 'toastPosition',
      type: 'string',
      label: t('settings.notifications.toastPosition'),
      default: 'top-right',
      optionClass: 'toast-position-option',
      options: [
        { value: 'top-left', label: t('settings.notifications.toastTopLeft') },
        { value: 'top-center', label: t('settings.notifications.toastTopCenter') },
        { value: 'top-right', label: t('settings.notifications.toastTopRight') },
        { value: 'bottom-left', label: t('settings.notifications.toastBottomLeft') },
        { value: 'bottom-center', label: t('settings.notifications.toastBottomCenter') },
        { value: 'bottom-right', label: t('settings.notifications.toastBottomRight') },
      ],
    },
  ];
}

/** Memory fields write into the nested `memory` settings object, not top-level keys. */
export function memoryFields(t: T, backends: ReadonlyArray<{ id: string; name: string }>): SettingsFieldDef[] {
  const memoryOff = { key: 'enabled', is: false };
  return [
    { key: 'enabled', type: 'boolean', label: t('settings.memory.enable'), default: false },
    {
      key: 'updateInterval',
      type: 'number',
      label: t('settings.memory.updateInterval'),
      hint: t('settings.memory.updateIntervalHint'),
      default: 5,
      min: 1,
      max: 250,
      disabledWhen: memoryOff,
    },
    {
      key: 'depth',
      type: 'number',
      label: t('settings.memory.depth'),
      hint: t('settings.memory.depthHint'),
      default: 10,
      min: 0,
      max: 250,
      disabledWhen: memoryOff,
    },
    {
      key: 'maxSummaryTokens',
      type: 'number',
      label: t('settings.memory.maxSummaryTokens'),
      default: 512,
      min: 1,
      max: 4096,
      disabledWhen: memoryOff,
    },
    {
      key: 'backendConfigId',
      type: 'string',
      label: t('settings.memory.backend'),
      hint: t('settings.memory.backendHint'),
      default: '',
      disabledWhen: memoryOff,
      options: [
        { value: '', label: t('settings.memory.activeBackend') },
        ...backends.map((b) => ({ value: b.id, label: b.name })),
      ],
    },
  ];
}

export function securityFields(t: T): SettingsFieldDef[] {
  return [
    {
      key: 'strictHtmlSanitization',
      type: 'boolean',
      label: t('settings.security.strictHtml'),
      hint: t('settings.security.strictHtmlHint'),
      default: false,
    },
    {
      key: 'allowExternalMedia',
      type: 'boolean',
      label: t('settings.security.allowExternalMedia'),
      hint: t('settings.security.allowExternalMediaHint'),
      default: false,
    },
  ];
}

export function themeFields(t: T): SettingsFieldDef[] {
  return [
    {
      key: 'themeCustomCss',
      type: 'string',
      format: 'textarea',
      label: t('settings.theme.customCss'),
      default: '',
      rows: 8,
      placeholder: ':root {\n  --color-bg-primary: #0f0f10;\n  --color-accent: #f472b6;\n}',
    },
    {
      key: 'backgroundImageUrl',
      type: 'string',
      label: t('settings.theme.backgroundImageUrl'),
      default: '',
      placeholder: 'https://example.com/bg.jpg',
    },
    {
      key: 'backgroundBlur',
      type: 'number',
      label: t('settings.theme.backgroundBlur'),
      default: 0,
      min: 0,
      max: 50,
    },
  ];
}

export function developerFields(t: T): SettingsFieldDef[] {
  return [
    {
      key: 'mcp.enabled',
      type: 'boolean',
      label: t('settings.developer.mcpServer'),
      hint: t('settings.developer.mcpServerHint'),
      hintOutside: true,
      default: false,
    },
    {
      key: 'unpackedCards.enabled',
      type: 'boolean',
      label: t('settings.developer.unpackedCards'),
      hint: t('settings.developer.unpackedCardsHint'),
      hintOutside: true,
      default: false,
    },
    {
      key: 'proxyApi.enabled',
      type: 'boolean',
      label: t('settings.developer.proxyApi'),
      hint: t('settings.developer.proxyApiHint'),
      hintOutside: true,
      default: false,
    },
  ];
}
