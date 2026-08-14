import { describe, it, expect } from 'vitest';
import { AppSettingsSchema, type SettingsMap } from '@tamari/types';
import { resolveEffectiveSettings } from './appendOnlyLocks.js';

function makeSettings(overrides: Record<string, unknown> = {}): SettingsMap {
  return { ...AppSettingsSchema.parse({}), ...overrides } as SettingsMap;
}

describe('resolveEffectiveSettings', () => {
  it('passes values through when append-only is off', () => {
    const eff = resolveEffectiveSettings(
      makeSettings({
        whitespaceMode: 'full',
        removeXML: true,
        singleLine: true,
        trimSentences: true,
        autoFixGeneratedMarkdown: true,
        disableGroupTrimming: false,
        customStoppingStringsMacro: true,
        reasoningAddToPrompts: false,
      }),
    );
    expect(eff).toEqual({
      appendOnly: false,
      whitespaceMode: 'full',
      removeXML: true,
      singleLine: true,
      trimSentences: true,
      autoFixGeneratedMarkdown: true,
      disableGroupTrimming: false,
      storageMacrosEnabled: true,
      customStoppingStringsMacro: true,
      reasoningAddToPrompts: false,
      memorySummaryEnabled: true,
    });
  });

  it('locks every byte-mutating feature when append-only is on', () => {
    const eff = resolveEffectiveSettings(
      makeSettings({
        appendOnlyPromptLayout: true,
        whitespaceMode: 'full',
        removeXML: true,
        singleLine: true,
        trimSentences: true,
        autoFixGeneratedMarkdown: true,
        disableGroupTrimming: false,
        customStoppingStringsMacro: true,
        reasoningAddToPrompts: false,
      }),
    );
    expect(eff).toEqual({
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
    });
  });
});
