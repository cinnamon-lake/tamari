import { describe, it, expect } from 'vitest';
import { PromptManager, DEFAULT_PROMPTS, DEFAULT_ORDER } from './PromptManager.js';

describe('PromptManager', () => {
  it('initializes with default prompts', () => {
    const pm = new PromptManager();
    expect(pm.getPrompt('main')).toBeDefined();
    expect(pm.getPrompt('main')?.content).toContain('{{char}}');
    expect(pm.getPrompt('jailbreak')).toBeDefined();
    expect(pm.getPrompt('nsfw')).toBeDefined();
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
