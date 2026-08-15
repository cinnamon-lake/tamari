import { createSignal, Show, For } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { useI18n, type Locale } from '../i18n/index.js';


import type { AppSettings, MemorySettings } from '@tamari/types';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import './SettingsModal.css';

export function SettingsModal(props: { onClose: () => void }) {
  const s = state.settings;
  const { t, locale, setLocale, available } = useI18n();

  saveFocus();

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  const [themeCustomCss, setThemeCustomCss] = createSignal(String(s['themeCustomCss'] ?? ''));
  const [backgroundImageUrl, setBackgroundImageUrl] = createSignal(String(s['backgroundImageUrl'] ?? ''));
  const [backgroundBlur, setBackgroundBlur] = createSignal(Number(s['backgroundBlur'] ?? 0));
  const [sendOnEnter, setSendOnEnter] = createSignal(s['sendOnEnter'] ?? 'auto');
  const [messageTokenCountEnabled, setMessageTokenCountEnabled] = createSignal(Boolean(s['messageTokenCountEnabled']));
  const [quickContinue, setQuickContinue] = createSignal(Boolean(s['quickContinue']));
  const [quickImpersonate, setQuickImpersonate] = createSignal(Boolean(s['quickImpersonate']));
  const [hideQuickReplies, setHideQuickReplies] = createSignal(Boolean(s['hideQuickReplies']));

  // Display settings
  const [chatStyle, setChatStyle] = createSignal(s['chatStyle'] ?? 'default');
  const [avatarStyle, setAvatarStyle] = createSignal(s['avatarStyle'] ?? 'round');
  const [fontScale, setFontScale] = createSignal(Number(s['fontScale'] ?? 1));
  const [chatWidth, setChatWidth] = createSignal(Number(s['chatWidth'] ?? 50));
  // Legacy `noShadows: true` maps to shadow width 0; moving the slider clears it.
  const [shadowWidth, setShadowWidth] = createSignal(s['noShadows'] ? 0 : Number(s['shadowWidth'] ?? 1));
  const [blurStrength, setBlurStrength] = createSignal(Number(s['blurStrength'] ?? 1));
  const [compactInputArea, setCompactInputArea] = createSignal(Boolean(s['compactInputArea']));
  const [hideChatAvatars, setHideChatAvatars] = createSignal(Boolean(s['hideChatAvatars']));
  const [hideChatNames, setHideChatNames] = createSignal(Boolean(s['hideChatNames']));
  const [swipeNumbersOnAllMessages, setSwipeNumbersOnAllMessages] = createSignal(
    Boolean(s['swipeNumbersOnAllMessages']),
  );
  const [showMessageIds, setShowMessageIds] = createSignal(Boolean(s['showMessageIds']));
  const [encodeTags, setEncodeTags] = createSignal(Boolean(s['encodeTags']));

  // Post-processing settings
  const [whitespaceMode, setWhitespaceMode] = createSignal(s['whitespaceMode'] ?? 'none');
  const [autoFixGeneratedMarkdown, setAutoFixGeneratedMarkdown] = createSignal(Boolean(s['autoFixGeneratedMarkdown']));
  const [removeXML, setRemoveXML] = createSignal(Boolean(s['removeXML']));
  const [singleLine, setSingleLine] = createSignal(Boolean(s['singleLine']));
  const [trimSentences, setTrimSentences] = createSignal(Boolean(s['trimSentences']));
  const [timerEnabled, setTimerEnabled] = createSignal(Boolean(s['timerEnabled']));
  const [timestampModelIcon, setTimestampModelIcon] = createSignal(Boolean(s['timestampModelIcon']));
  const [neverResizeAvatars, setNeverResizeAvatars] = createSignal(Boolean(s['neverResizeAvatars']));
  const [reducedMotion, setReducedMotion] = createSignal(Boolean(s['reducedMotion']));
  const [messageSoundEnabled, setMessageSoundEnabled] = createSignal(Boolean(s['messageSoundEnabled']));
  const [messageSoundUnfocusedOnly, setMessageSoundUnfocusedOnly] = createSignal(
    Boolean(s['messageSoundUnfocusedOnly'] !== false),
  );
  const [smoothStreaming, setSmoothStreaming] = createSignal(Boolean(s['smoothStreaming']));
  const [smoothStreamingDelay, setSmoothStreamingDelay] = createSignal(Number(s['smoothStreamingDelay'] ?? 25));
  const [streamFadeIn, setStreamFadeIn] = createSignal(Boolean(s['streamFadeIn'] !== false));
  const [toastPosition, setToastPosition] = createSignal(
    (s['toastPosition']) ?? 'top-right',
  );
  const [clickToEdit, setClickToEdit] = createSignal(Boolean(s['clickToEdit']));
  const [autoSelectInput, setAutoSelectInput] = createSignal(Boolean(s['autoSelectInput']));

  // Chat behavior settings
  const [confirmMessageDelete, setConfirmMessageDelete] = createSignal(Boolean(s['confirmMessageDelete']));
  const [useSoftFork, setUseSoftFork] = createSignal(Boolean(s['useSoftFork']));
  const [autoSaveMessageEdits, setAutoSaveMessageEdits] = createSignal(Boolean(s['autoSaveMessageEdits']));
  const [restoreUserInput, setRestoreUserInput] = createSignal(Boolean(s['restoreUserInput']));
  const [autoLoadLastChat, setAutoLoadLastChat] = createSignal(Boolean(s['autoLoadLastChat']));
  const [showHiddenMessages, setShowHiddenMessages] = createSignal(Boolean(s['showHiddenMessages']));
  const [autoScrollToBottom, setAutoScrollToBottom] = createSignal(Boolean(s['autoScrollToBottom'] !== false));
  const [disableGroupTrimming, setDisableGroupTrimming] = createSignal(Boolean(s['disableGroupTrimming']));
  const [autoContinueEnabled, setAutoContinueEnabled] = createSignal(Boolean(s['autoContinueEnabled']));
  const [autoContinueTargetLength, setAutoContinueTargetLength] = createSignal(
    Number(s['autoContinueTargetLength'] ?? 100),
  );
  const [mediaDisplayMode, setMediaDisplayMode] = createSignal(s['mediaDisplayMode'] ?? 'list');
  const [mediaVerboseMode, setMediaVerboseMode] = createSignal(Boolean(s['mediaVerboseMode']));
  const [strictHtmlSanitization, setStrictHtmlSanitization] = createSignal(Boolean(s['strictHtmlSanitization']));
  const [allowExternalMedia, setAllowExternalMedia] = createSignal(Boolean(s['allowExternalMedia']));
  const [fuzzySearch, setFuzzySearch] = createSignal(Boolean(s['fuzzySearch']));
  const [showHotswapBar, setShowHotswapBar] = createSignal(s['showHotswapBar'] !== false);

  // Generation settings
  const [customStoppingStrings, setCustomStoppingStrings] = createSignal<string[]>(
    Array.isArray(s['customStoppingStrings']) ? (s['customStoppingStrings']) : [],
  );
  const [customStoppingStringsMacro, setCustomStoppingStringsMacro] = createSignal(
    Boolean(s['customStoppingStringsMacro']),
  );
  const [stripExamples, setStripExamples] = createSignal(Boolean(s['stripExamples']));
  const [chatMessageLoadLimit, setChatMessageLoadLimit] = createSignal(Number(s['chatMessageLoadLimit'] ?? 30));
  const [appendOnlyLayout, setAppendOnlyLayout] = createSignal(Boolean(s['appendOnlyPromptLayout']));

  // Developer settings
  const [mcpEnabled, setMcpEnabled] = createSignal(Boolean(s['mcp.enabled']));
  const [unpackedCardsEnabled, setUnpackedCardsEnabled] = createSignal(Boolean(s['unpackedCards.enabled']));

  // Memory settings — the server populates schema defaults; the `??` fallbacks below
  // only guard the brief window before `settings.loaded` arrives.
  const memory = () => (s['memory'] ?? {}) as Partial<MemorySettings>;
  const [memoryEnabled, setMemoryEnabled] = createSignal(Boolean(memory().enabled));
  const [memoryUpdateInterval, setMemoryUpdateInterval] = createSignal(Number(memory().updateInterval ?? 5));
  const [memoryDepth, setMemoryDepth] = createSignal(Number(memory().depth ?? 10));
  const [memoryBackendConfigId, setMemoryBackendConfigId] = createSignal(String(memory().backendConfigId ?? ''));
  const [memoryMaxSummaryTokens, setMemoryMaxSummaryTokens] = createSignal(Number(memory().maxSummaryTokens ?? 512));

  const sendSetting = (key: string, value: unknown) => {
    bus.send({ type: 'settings.set', key, value });
  };

  const sendMemorySetting = (patch: Partial<MemorySettings>) => {
    sendSetting('memory', {
      enabled: memoryEnabled(),
      updateInterval: memoryUpdateInterval(),
      depth: memoryDepth(),
      backendConfigId: memoryBackendConfigId(),
      maxSummaryTokens: memoryMaxSummaryTokens(),
      ...patch,
    });
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal settings-modal" role="dialog" aria-modal="true" aria-label={t('settings.title')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <h2 class="modal-title">{t('settings.title')}</h2>

        {/* Language */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.language.heading')}</h3>
          <label class="field-label">
            {t('settings.language.label')}
            <select
              class="select"
              value={locale()}
              onChange={(e) => setLocale(e.currentTarget.value as Locale)}
            >
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
          <label class="field-label">
            {t('settings.display.chatStyle')}
            <select
              class="select"
              value={chatStyle()}
              onChange={(e) => {
                setChatStyle(e.currentTarget.value as AppSettings['chatStyle']);
                sendSetting('chatStyle', e.currentTarget.value);
              }}
            >
              <option value="default" class="select-option">{t('settings.display.chatStyleDefault')}</option>
              <option value="bubbles" class="select-option">{t('settings.display.chatStyleBubbles')}</option>
              <option value="document" class="select-option">{t('settings.display.chatStyleDocument')}</option>
            </select>
          </label>
          <label class="field-label">
            {t('settings.display.avatarStyle')}
            <select
              class="select"
              value={avatarStyle()}
              disabled={hideChatAvatars()}
              onChange={(e) => {
                setAvatarStyle(e.currentTarget.value as AppSettings['avatarStyle']);
                sendSetting('avatarStyle', e.currentTarget.value);
              }}
            >
              <option value="round" class="select-option">{t('settings.display.avatarStyleRound')}</option>
              <option value="rectangular" class="select-option">{t('settings.display.avatarStyleRectangular')}</option>
              <option value="square" class="select-option">{t('settings.display.avatarStyleSquare')}</option>
              <option value="rounded" class="select-option">{t('settings.display.avatarStyleRounded')}</option>
            </select>
          </label>
          <label class="field-label">
            {t('settings.display.fontScale')}
            <input
              type="range"
              min={0.8}
              max={1.5}
              step={0.05}
              value={fontScale()}
              onInput={(e) => setFontScale(Number(e.currentTarget.value))}
              onChange={(e) => sendSetting('fontScale', Number(e.currentTarget.value))}
              class="range-input"
            />
            <span class="hint-text">{fontScale().toFixed(2)}x</span>
          </label>
          <label class="field-label">
            {t('settings.display.chatWidth')}
            <input
              type="range"
              min={30}
              max={70}
              step={1}
              value={chatWidth()}
              onInput={(e) => setChatWidth(Number(e.currentTarget.value))}
              onChange={(e) => sendSetting('chatWidth', Number(e.currentTarget.value))}
              class="range-input"
            />
            <span class="hint-text">{chatWidth()}rem</span>
          </label>
          <label class="field-label">
            {t('settings.display.shadowWidth')}
            <input
              type="range"
              min={0}
              max={2}
              step={0.25}
              value={shadowWidth()}
              onInput={(e) => setShadowWidth(Number(e.currentTarget.value))}
              onChange={(e) => {
                const val = Number(e.currentTarget.value);
                sendSetting('shadowWidth', val);
                // Clear the legacy kill-switch so it can't pin shadows to off.
                if (s['noShadows']) sendSetting('noShadows', false);
              }}
              class="range-input"
            />
            <span class="hint-text">
              {shadowWidth() === 0 ? t('settings.display.shadowsOff') : `${shadowWidth().toFixed(2)}x`}
            </span>
          </label>
          <label class="field-label">
            {t('settings.display.backdropBlur')}
            <input
              type="range"
              min={0}
              max={2}
              step={0.25}
              value={blurStrength()}
              onInput={(e) => setBlurStrength(Number(e.currentTarget.value))}
              onChange={(e) => sendSetting('blurStrength', Number(e.currentTarget.value))}
              class="range-input"
            />
            <span class="hint-text">{blurStrength().toFixed(2)}x</span>
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={compactInputArea()}
              onChange={(e) => {
                setCompactInputArea(e.currentTarget.checked);
                sendSetting('compactInputArea', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.compactInput')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={reducedMotion()}
              onChange={(e) => {
                setReducedMotion(e.currentTarget.checked);
                sendSetting('reducedMotion', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.reducedMotion')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={hideChatAvatars()}
              onChange={(e) => {
                setHideChatAvatars(e.currentTarget.checked);
                sendSetting('hideChatAvatars', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.hideAvatars')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={hideChatNames()}
              onChange={(e) => {
                setHideChatNames(e.currentTarget.checked);
                sendSetting('hideChatNames', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.hideNames')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={swipeNumbersOnAllMessages()}
              onChange={(e) => {
                setSwipeNumbersOnAllMessages(e.currentTarget.checked);
                sendSetting('swipeNumbersOnAllMessages', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.swipeNumbersAll')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={showMessageIds()}
              onChange={(e) => {
                setShowMessageIds(e.currentTarget.checked);
                sendSetting('showMessageIds', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.showMessageIds')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={timestampModelIcon()}
              onChange={(e) => {
                setTimestampModelIcon(e.currentTarget.checked);
                sendSetting('timestampModelIcon', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.showModelInTimestamps')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={timerEnabled()}
              onChange={(e) => {
                setTimerEnabled(e.currentTarget.checked);
                sendSetting('timerEnabled', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.showTimer')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={encodeTags()}
              onChange={(e) => {
                setEncodeTags(e.currentTarget.checked);
                sendSetting('encodeTags', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.encodeTags')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={showHotswapBar()}
              onChange={(e) => {
                setShowHotswapBar(e.currentTarget.checked);
                sendSetting('showHotswapBar', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.showHotswapBar')}
            <span class="hint-text">{t('settings.display.showHotswapBarHint')}</span>
          </label>
          <label class="field-label">
            {t('settings.display.mediaMode')}
            <select
              class="select"
              value={mediaDisplayMode()}
              onChange={(e) => {
                setMediaDisplayMode(e.currentTarget.value as AppSettings['mediaDisplayMode']);
                sendSetting('mediaDisplayMode', e.currentTarget.value);
              }}
            >
              <option value="list" class="select-option">{t('settings.display.mediaModeList')}</option>
              <option value="grid" class="select-option">{t('settings.display.mediaModeGrid')}</option>
            </select>
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={fuzzySearch()}
              onChange={(e) => {
                setFuzzySearch(e.currentTarget.checked);
                sendSetting('fuzzySearch', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.display.fuzzySearch')}
            <span class="hint-text">{t('settings.display.fuzzySearchHint')}</span>
          </label>
        </section>

        {/* Chat Behavior Settings */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.chatBehavior.heading')}</h3>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={confirmMessageDelete()}
              onChange={(e) => {
                setConfirmMessageDelete(e.currentTarget.checked);
                sendSetting('confirmMessageDelete', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.confirmMessageDelete')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={useSoftFork()}
              onChange={(e) => {
                setUseSoftFork(e.currentTarget.checked);
                sendSetting('useSoftFork', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.useSoftFork')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={autoSaveMessageEdits()}
              onChange={(e) => {
                setAutoSaveMessageEdits(e.currentTarget.checked);
                sendSetting('autoSaveMessageEdits', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.autoSaveEdits')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={restoreUserInput()}
              onChange={(e) => {
                setRestoreUserInput(e.currentTarget.checked);
                sendSetting('restoreUserInput', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.restoreUserInput')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={autoLoadLastChat()}
              onChange={(e) => {
                setAutoLoadLastChat(e.currentTarget.checked);
                sendSetting('autoLoadLastChat', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.autoLoadLastChat')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={showHiddenMessages()}
              onChange={(e) => {
                setShowHiddenMessages(e.currentTarget.checked);
                sendSetting('showHiddenMessages', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.showHiddenMessages')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={autoScrollToBottom()}
              onChange={(e) => {
                setAutoScrollToBottom(e.currentTarget.checked);
                sendSetting('autoScrollToBottom', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.autoScroll')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={disableGroupTrimming()}
              onChange={(e) => {
                setDisableGroupTrimming(e.currentTarget.checked);
                sendSetting('disableGroupTrimming', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.disableGroupTrimming')}
          </label>
          <label class="field-label">
            {t('settings.generation.chatMessageLoadLimit')}
            <input
              type="number"
              min={1}
              max={10000}
              value={chatMessageLoadLimit()}
              onChange={(e) => {
                setChatMessageLoadLimit(Number(e.currentTarget.value));
                sendSetting('chatMessageLoadLimit', Number(e.currentTarget.value));
              }}
              class="input"
            />
            <span class="hint-text">{t('settings.generation.chatMessageLoadLimitHint')}</span>
          </label>
        </section>

        {/* Input & Interaction Settings */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.interaction.heading')}</h3>
          <label class="field-label">
            {t('settings.behavior.sendOnEnter')}
            <select
              class="select"
              value={sendOnEnter()}
              onChange={(e) => {
                setSendOnEnter(e.currentTarget.value as AppSettings['sendOnEnter']);
                sendSetting('sendOnEnter', e.currentTarget.value);
              }}
            >
              <option value="auto" class="select-option">{t('settings.behavior.sendOnEnterAuto')}</option>
              <option value="enabled" class="select-option">{t('settings.behavior.sendOnEnterEnabled')}</option>
              <option value="disabled" class="select-option">{t('settings.behavior.sendOnEnterDisabled')}</option>
            </select>
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={messageTokenCountEnabled()}
              onChange={(e) => {
                setMessageTokenCountEnabled(e.currentTarget.checked);
                sendSetting('messageTokenCountEnabled', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.showTokenCounts')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={quickContinue()}
              onChange={(e) => {
                setQuickContinue(e.currentTarget.checked);
                sendSetting('quickContinue', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.showQuickContinue')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={quickImpersonate()}
              onChange={(e) => {
                setQuickImpersonate(e.currentTarget.checked);
                sendSetting('quickImpersonate', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.showQuickImpersonate')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={hideQuickReplies()}
              onChange={(e) => {
                setHideQuickReplies(e.currentTarget.checked);
                sendSetting('hideQuickReplies', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.behavior.hideQuickReplies')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={clickToEdit()}
              onChange={(e) => {
                setClickToEdit(e.currentTarget.checked);
                sendSetting('clickToEdit', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.interaction.clickToEdit')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={autoSelectInput()}
              onChange={(e) => {
                setAutoSelectInput(e.currentTarget.checked);
                sendSetting('autoSelectInput', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.interaction.autoFocusInput')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={neverResizeAvatars()}
              onChange={(e) => {
                setNeverResizeAvatars(e.currentTarget.checked);
                sendSetting('neverResizeAvatars', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.interaction.neverResizeAvatars')}
          </label>
        </section>

        {/* Generation Settings */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.generation.heading')}</h3>
          <label class="field-label">
            {t('settings.generation.customStoppingStrings')}
            <div class="stack-xs">
              <For each={customStoppingStrings()}>
                {(str, index) => (
                  <div class="input-row" id={`stop-str-${index()}`}>
                    <input
                      type="text"
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
                      title={t('common.remove')} aria-label={t('common.remove')}
                    >
                      <i class="bi bi-trash" />
                    </button>
                  </div>
                )}
              </For>
              <button
                type="button"
                class="text-btn small"
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
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={customStoppingStringsMacro()}
              disabled={appendOnlyLayout()}
              onChange={(e) => {
                setCustomStoppingStringsMacro(e.currentTarget.checked);
                sendSetting('customStoppingStringsMacro', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.generation.resolveStoppingMacros')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={stripExamples()}
              onChange={(e) => {
                setStripExamples(e.currentTarget.checked);
                sendSetting('stripExamples', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.generation.stripExamples')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={autoContinueEnabled()}
              onChange={(e) => {
                setAutoContinueEnabled(e.currentTarget.checked);
                sendSetting('autoContinueEnabled', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.generation.autoContinue')}
          </label>
          <Show when={autoContinueEnabled()}>
            <label class="field-label">
              {t('settings.generation.autoContinueTargetLength')}
              <input
                type="number"
                min={10}
                max={2000}
                value={autoContinueTargetLength()}
                onChange={(e) => {
                  setAutoContinueTargetLength(Number(e.currentTarget.value));
                  sendSetting('autoContinueTargetLength', Number(e.currentTarget.value));
                }}
                class="input"
              />
              <span class="hint-text">{t('settings.generation.autoContinueTargetLengthHint')}</span>
            </label>
          </Show>

          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={mediaVerboseMode()}
              onChange={(e) => {
                setMediaVerboseMode(e.currentTarget.checked);
                sendSetting('mediaVerboseMode', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.generation.mediaVerbose')}
            <span class="hint-text">{t('settings.generation.mediaVerboseHint')}</span>
          </label>

          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={appendOnlyLayout()}
              onChange={(e) => {
                setAppendOnlyLayout(e.currentTarget.checked);
                sendSetting('appendOnlyPromptLayout', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.generation.appendOnlyLayout')}
          </label>
          <span class="hint-text">{t('settings.generation.appendOnlyLayoutHint')}</span>
        </section>

        {/* Post-processing Settings */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.postProcessing.heading')}</h3>

          <Show when={appendOnlyLayout()}>
            <p class="hint-text">{t('settings.postProcessing.disabledByAppendOnly')}</p>
          </Show>

          <div class="settings-radio-group">
            <span class="settings-radio-label">{t('settings.postProcessing.whitespaceHandling')}</span>
            <label class="radio-row">
              <input
                type="radio"
                name="whitespaceMode"
                value="none"
                checked={whitespaceMode() === 'none'}
                disabled={appendOnlyLayout()}
                onChange={() => {
                  setWhitespaceMode('none');
                  sendSetting('whitespaceMode', 'none');
                }}
                class="radio"
              />
              {t('settings.postProcessing.whitespaceNone')}
            </label>
            <label class="radio-row">
              <input
                type="radio"
                name="whitespaceMode"
                value="essential"
                checked={whitespaceMode() === 'essential'}
                disabled={appendOnlyLayout()}
                onChange={() => {
                  setWhitespaceMode('essential');
                  sendSetting('whitespaceMode', 'essential');
                }}
                class="radio"
              />
              {t('settings.postProcessing.whitespaceEssential')}
            </label>
            <label class="radio-row">
              <input
                type="radio"
                name="whitespaceMode"
                value="full"
                checked={whitespaceMode() === 'full'}
                disabled={appendOnlyLayout()}
                onChange={() => {
                  setWhitespaceMode('full');
                  sendSetting('whitespaceMode', 'full');
                }}
                class="radio"
              />
              {t('settings.postProcessing.whitespaceFull')}
            </label>
          </div>

          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={removeXML()}
              disabled={appendOnlyLayout()}
              onChange={(e) => {
                setRemoveXML(e.currentTarget.checked);
                sendSetting('removeXML', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.postProcessing.removeXml')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={singleLine()}
              disabled={appendOnlyLayout()}
              onChange={(e) => {
                setSingleLine(e.currentTarget.checked);
                sendSetting('singleLine', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.postProcessing.singleLine')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={trimSentences()}
              disabled={appendOnlyLayout()}
              onChange={(e) => {
                setTrimSentences(e.currentTarget.checked);
                sendSetting('trimSentences', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.postProcessing.trimSentences')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={autoFixGeneratedMarkdown()}
              disabled={appendOnlyLayout()}
              onChange={(e) => {
                setAutoFixGeneratedMarkdown(e.currentTarget.checked);
                sendSetting('autoFixGeneratedMarkdown', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.postProcessing.autoFixMarkdown')}
          </label>
        </section>

        {/* Sound & Streaming Settings */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.soundStreaming.heading')}</h3>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={messageSoundEnabled()}
              onChange={(e) => {
                setMessageSoundEnabled(e.currentTarget.checked);
                sendSetting('messageSoundEnabled', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.soundStreaming.playSound')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={messageSoundUnfocusedOnly()}
              disabled={!messageSoundEnabled()}
              onChange={(e) => {
                setMessageSoundUnfocusedOnly(e.currentTarget.checked);
                sendSetting('messageSoundUnfocusedOnly', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.soundStreaming.unfocusedOnly')}
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={smoothStreaming()}
              onChange={(e) => {
                setSmoothStreaming(e.currentTarget.checked);
                sendSetting('smoothStreaming', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.soundStreaming.smoothStreaming')}
          </label>
          <label class="field-label">
            {t('settings.soundStreaming.tokenDelay')}
            <input
              type="number"
              min={5}
              max={500}
              value={smoothStreamingDelay()}
              disabled={!smoothStreaming()}
              onInput={(e) => setSmoothStreamingDelay(Number(e.currentTarget.value))}
              onChange={(e) => sendSetting('smoothStreamingDelay', Number(e.currentTarget.value))}
              class="input"
            />
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={streamFadeIn()}
              onChange={(e) => {
                setStreamFadeIn(e.currentTarget.checked);
                sendSetting('streamFadeIn', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.soundStreaming.fadeIn')}
          </label>
        </section>

        {/* Notifications Settings */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.notifications.heading')}</h3>
          <label class="field-label">
            {t('settings.notifications.toastPosition')}
            <select
              class="select"
              value={toastPosition()}
              onChange={(e) => {
                const value = e.currentTarget.value as 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
                setToastPosition(value);
                sendSetting('toastPosition', value);
              }}
            >
              <option class="toast-position-option" value="top-left">{t('settings.notifications.toastTopLeft')}</option>
              <option class="toast-position-option" value="top-center">{t('settings.notifications.toastTopCenter')}</option>
              <option class="toast-position-option" value="top-right">{t('settings.notifications.toastTopRight')}</option>
              <option class="toast-position-option" value="bottom-left">{t('settings.notifications.toastBottomLeft')}</option>
              <option class="toast-position-option" value="bottom-center">{t('settings.notifications.toastBottomCenter')}</option>
              <option class="toast-position-option" value="bottom-right">{t('settings.notifications.toastBottomRight')}</option>
            </select>
          </label>
        </section>

        {/* Memory Settings */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.memory.heading')}</h3>
          <p class="text-sm text-muted">
            {t('settings.memory.description')}
          </p>

          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={memoryEnabled()}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setMemoryEnabled(checked);
                sendMemorySetting({ enabled: checked });
              }}
              class="checkbox"
            />
            {t('settings.memory.enable')}
          </label>

          <label class="field-label">
            {t('settings.memory.updateInterval')}
            <input
              type="number"
              min={1}
              max={250}
              value={memoryUpdateInterval()}
              disabled={!memoryEnabled()}
              onInput={(e) => setMemoryUpdateInterval(Number(e.currentTarget.value))}
              onChange={(e) => sendMemorySetting({ updateInterval: Number(e.currentTarget.value) })}
              class="input"
            />
            <span class="hint-text">{t('settings.memory.updateIntervalHint')}</span>
          </label>

          <label class="field-label">
            {t('settings.memory.depth')}
            <input
              type="number"
              min={0}
              max={250}
              value={memoryDepth()}
              disabled={!memoryEnabled()}
              onInput={(e) => setMemoryDepth(Number(e.currentTarget.value))}
              onChange={(e) => sendMemorySetting({ depth: Number(e.currentTarget.value) })}
              class="input"
            />
            <span class="hint-text">{t('settings.memory.depthHint')}</span>
          </label>

          <label class="field-label">
            {t('settings.memory.maxSummaryTokens')}
            <input
              type="number"
              min={1}
              max={4096}
              value={memoryMaxSummaryTokens()}
              disabled={!memoryEnabled()}
              onInput={(e) => setMemoryMaxSummaryTokens(Number(e.currentTarget.value))}
              onChange={(e) => sendMemorySetting({ maxSummaryTokens: Number(e.currentTarget.value) })}
              class="input"
            />
          </label>

          <label class="field-label">
            {t('settings.memory.backend')}
            <select
              class="select"
              value={memoryBackendConfigId()}
              disabled={!memoryEnabled()}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setMemoryBackendConfigId(value);
                sendMemorySetting({ backendConfigId: value });
              }}
            >
              <option value="" class="select-option">{t('settings.memory.activeBackend')}</option>
              <For each={state.backendConfigs}>
                {(config) => (
                  <option class="select-option" value={config.id}>
                    {config.name}
                  </option>
                )}
              </For>
            </select>
            <span class="hint-text">{t('settings.memory.backendHint')}</span>
          </label>
        </section>

        {/* Security & Content Settings */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.security.heading')}</h3>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={strictHtmlSanitization()}
              onChange={(e) => {
                setStrictHtmlSanitization(e.currentTarget.checked);
                sendSetting('strictHtmlSanitization', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.security.strictHtml')}
            <span class="hint-text">{t('settings.security.strictHtmlHint')}</span>
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={allowExternalMedia()}
              onChange={(e) => {
                setAllowExternalMedia(e.currentTarget.checked);
                sendSetting('allowExternalMedia', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.security.allowExternalMedia')}
            <span class="hint-text">{t('settings.security.allowExternalMediaHint')}</span>
          </label>
        </section>

        {/* Theme Settings */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.theme.heading')}</h3>
          <label class="field-label">
            {t('settings.theme.customCss')}
            <textarea
              rows={8}
              value={themeCustomCss()}
              onInput={(e) => setThemeCustomCss(e.currentTarget.value)}
              onChange={(e) => sendSetting('themeCustomCss', e.currentTarget.value)}
              placeholder={':root {\n  --color-bg-primary: #0f0f10;\n  --color-accent: #f472b6;\n}'}
              class="textarea"
            />
          </label>
          <label class="field-label">
            {t('settings.theme.backgroundImageUrl')}
            <input
              value={backgroundImageUrl()}
              onInput={(e) => setBackgroundImageUrl(e.currentTarget.value)}
              onChange={(e) => sendSetting('backgroundImageUrl', e.currentTarget.value)}
              placeholder="https://example.com/bg.jpg"
              class="input"
            />
          </label>
          <label class="field-label">
            {t('settings.theme.backgroundBlur')}
            <input
              type="number"
              min={0}
              max={50}
              value={backgroundBlur()}
              onInput={(e) => setBackgroundBlur(Number(e.currentTarget.value))}
              onChange={(e) => sendSetting('backgroundBlur', Number(e.currentTarget.value))}
              class="input"
            />
          </label>
        </section>

        {/* Developer Settings */}
        <section class="settings-section">
          <h3 class="section-heading">{t('settings.developer.heading')}</h3>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={mcpEnabled()}
              onChange={(e) => {
                setMcpEnabled(e.currentTarget.checked);
                sendSetting('mcp.enabled', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.developer.mcpServer')}
          </label>
          <span class="hint-text">{t('settings.developer.mcpServerHint')}</span>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={unpackedCardsEnabled()}
              onChange={(e) => {
                setUnpackedCardsEnabled(e.currentTarget.checked);
                sendSetting('unpackedCards.enabled', e.currentTarget.checked);
              }}
              class="checkbox"
            />
            {t('settings.developer.unpackedCards')}
          </label>
          <span class="hint-text">{t('settings.developer.unpackedCardsHint')}</span>
        </section>

        <div class="modal-actions">
          <button onClick={close} class="btn">{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
