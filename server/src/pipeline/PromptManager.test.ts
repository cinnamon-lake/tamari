import { describe, it, expect } from 'vitest';
import {
  PromptManager,
  DEFAULT_PROMPTS,
  DEFAULT_ORDER,
  DEFAULT_IMPERSONATION_PROMPT,
  ensureUtilityPrompts,
} from './PromptManager.js';
import { DEFAULT_MEMORY_SUMMARY_PROMPT } from '@tamari/types';

describe('PromptManager', () => {
  it('initializes with default prompts', () => {
    const pm = new PromptManager();
    expect(pm.getPrompt('main')).toBeDefined();
    expect(pm.getPrompt('main')?.content).toContain('{{char}}');
    expect(pm.getPrompt('jailbreak')).toBeDefined();
    expect(pm.getPrompt('nsfw')).toBeDefined();
  });

  it('includes builtin utility prompts in the defaults but never in the order', () => {
    const impersonation = DEFAULT_PROMPTS.find((p) => p.identifier === 'impersonation');
    const memorySummary = DEFAULT_PROMPTS.find((p) => p.identifier === 'memorySummary');
    expect(impersonation?.content).toBe(DEFAULT_IMPERSONATION_PROMPT);
    expect(memorySummary?.content).toBe(DEFAULT_MEMORY_SUMMARY_PROMPT);
    expect(DEFAULT_ORDER.some((o) => o.identifier === 'impersonation')).toBe(false);
    expect(DEFAULT_ORDER.some((o) => o.identifier === 'memorySummary')).toBe(false);

    // In the map (addressable by consumers) but never injected into assembly.
    const pm = new PromptManager();
    expect(pm.getPrompt('impersonation')).toBeDefined();
    expect(pm.getPrompt('memorySummary')).toBeDefined();
    const ordered = pm.getOrderedPrompts();
    expect(ordered.find((p) => p.identifier === 'impersonation')).toBeUndefined();
    expect(ordered.find((p) => p.identifier === 'memorySummary')).toBeUndefined();
  });

  it('ensureUtilityPrompts appends only the missing utility prompts', () => {
    const merged = ensureUtilityPrompts([{ identifier: 'main', name: 'Main', content: '', role: 'system', enabled: true }]);
    expect(merged.map((p) => p.identifier)).toEqual(['main', 'impersonation', 'memorySummary']);

    // Already present (possibly customized) — left untouched.
    const customized = ensureUtilityPrompts([
      { identifier: 'impersonation', name: 'Mine', content: 'custom', role: 'system', enabled: true },
      { identifier: 'memorySummary', name: 'Mine', content: 'custom', role: 'system', enabled: true },
    ]);
    expect(customized).toHaveLength(2);
    expect(customized[0]!.content).toBe('custom');
  });

  it('returns ordered prompts', () => {
    const pm = new PromptManager();
    const ordered = pm.getOrderedPrompts();
    expect(ordered[0]!.identifier).toBe('main');
    expect(ordered[1]!.identifier).toBe('worldInfoBefore');
  });

  it('skips disabled prompts, main included — the enable checkbox is honored', () => {
    const order = DEFAULT_ORDER.map((o) =>
      o.identifier === 'nsfw' || o.identifier === 'main' ? { ...o, enabled: false } : { ...o },
    );
    const pm = new PromptManager(DEFAULT_PROMPTS, order);
    const ordered = pm.getOrderedPrompts();
    expect(ordered.find((p) => p.identifier === 'nsfw')).toBeUndefined();
    // Disabling Main Prompt in the preset editor really excludes it (the old
    // always-on special case made the checkbox a no-op).
    expect(ordered.find((p) => p.identifier === 'main')).toBeUndefined();
  });

  it('applies overrides', () => {
    const pm = new PromptManager();
    pm.applyOverride('main', 'Custom system prompt');
    expect(pm.getPrompt('main')?.content).toBe('Custom system prompt');
  });

  it('respects forbidOverrides', () => {
    const prompts = DEFAULT_PROMPTS.map((p) => (p.identifier === 'main' ? { ...p, forbidOverrides: true } : p));
    const pm = new PromptManager(prompts);
    pm.applyOverride('main', 'Should not apply');
    expect(pm.getPrompt('main')?.content).toContain('{{char}}');
  });

  it('injects dynamic prompts', () => {
    const pm = new PromptManager();
    pm.injectPrompt({
      identifier: 'bias',
      name: 'Bias',
      content: 'Be more cheerful.',
      role: 'system',
      enabled: true,
      systemPrompt: false,
      marker: false,
    });
    const ordered = pm.getOrderedPrompts();
    expect(ordered.find((p) => p.identifier === 'bias')).toBeDefined();
  });

  it('serializes and restores', () => {
    const pm = new PromptManager();
    pm.applyOverride('main', 'Overridden');
    const serialized = pm.serialize();
    expect(serialized.prompts.find((p) => p.identifier === 'main')?.content).toBe('Overridden');
  });
});
