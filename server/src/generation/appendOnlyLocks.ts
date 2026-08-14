/**
 * Append-only prompt layout — the single place that decides what the feature
 * locks.
 *
 * When `appendOnlyPromptLayout` is on, every turn's prompt must be a strict
 * byte-prefix of the next so provider snapshot caches always hit. That
 * invariant forbids anything that mutates already-sent bytes or rewrites
 * persisted content. Instead of letting every consumer re-check the raw flag
 * (and inevitably miss a spot), consumers call `resolveEffectiveSettings()`
 * once and read the *effective* values from the result.
 *
 * New byte-mutating features must be added here, not gated ad-hoc at the call
 * site.
 */

import type { SettingsMap } from '@tamari/types';

export interface EffectiveGenerationSettings {
  /** The raw flag, for prompt-stage plumbing (`caching.appendOnly`). */
  appendOnly: boolean;
  /** Whitespace normalization rewrites bytes — locked to 'none' (covers both
      the input pass in GenerationService and the output pass at stream settle). */
  whitespaceMode: string;
  removeXML: boolean;
  singleLine: boolean;
  trimSentences: boolean;
  autoFixGeneratedMarkdown: boolean;
  /** Group-name trimming mutates output — forced on (= trimming skipped). */
  disableGroupTrimming: boolean;
  /** Storage macros rewrite persisted parts — off; raw provider bytes persist. */
  storageMacrosEnabled: boolean;
  /** Macro resolution in custom stop strings — off; strings stay literal. */
  customStoppingStringsMacro: boolean;
  /** Reasoning must be re-sent verbatim (the provider snapshot includes it) —
      forced on. */
  reasoningAddToPrompts: boolean;
  /** A rolling summary prepended before history mutates already-sent bytes
      every updateInterval — off (the summary is neither used nor refreshed). */
  memorySummaryEnabled: boolean;
}

export function resolveEffectiveSettings(settings: SettingsMap): EffectiveGenerationSettings {
  if (settings['appendOnlyPromptLayout'] !== true) {
    return {
      appendOnly: false,
      whitespaceMode: settings.whitespaceMode,
      removeXML: Boolean(settings['removeXML']),
      singleLine: Boolean(settings['singleLine']),
      trimSentences: Boolean(settings['trimSentences']),
      autoFixGeneratedMarkdown: Boolean(settings['autoFixGeneratedMarkdown']),
      disableGroupTrimming: Boolean(settings['disableGroupTrimming']),
      storageMacrosEnabled: true,
      customStoppingStringsMacro: Boolean(settings['customStoppingStringsMacro']),
      reasoningAddToPrompts: Boolean(settings['reasoningAddToPrompts']),
      memorySummaryEnabled: true,
    };
  }
  return {
    appendOnly: true,
    whitespaceMode: 'none',
    removeXML: false,
    singleLine: false,
    trimSentences: false,
    autoFixGeneratedMarkdown: false,
    disableGroupTrimming: true,
    storageMacrosEnabled: false,
    customStoppingStringsMacro: false,
    reasoningAddToPrompts: true,
    memorySummaryEnabled: false,
  };
}
