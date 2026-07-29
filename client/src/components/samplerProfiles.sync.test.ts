import { describe, it, expect } from 'vitest';
import { isDeclaredProviderParamKey } from '@tamari/types';
import { getSamplerProfile } from './samplerProfiles.js';

/**
 * Sync guard: every wire name the UI can write into providerParams must be a
 * declared providerParams key — undeclared keys are stripped on write
 * (packages/types/src/providerParams.ts).
 */
describe('samplerProfiles ↔ providerParams contract', () => {
  const profiles: Array<[string, 'chat' | 'text']> = [
    ['llamacpp', 'chat'],
    ['koboldcpp', 'chat'],
    ['tabbyapi', 'chat'],
    ['openai', 'chat'],
    ['openai', 'text'],
  ];

  it('every knob wire name in every profile is declared', () => {
    const wireNames = new Set<string>();
    for (const [provider, mode] of profiles) {
      for (const knob of getSamplerProfile(provider, mode)) {
        wireNames.add(knob.wireName);
      }
    }
    expect(wireNames.size).toBeGreaterThan(0);
    for (const wireName of wireNames) {
      expect(isDeclaredProviderParamKey(wireName), `${wireName} is not declared in packages/types/src/providerParams.ts`).toBe(true);
    }
  });
});
