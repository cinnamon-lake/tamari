import { describe, it, expect } from 'vitest';
import { resolveHtmlImages } from './resolveHtmlImages.js';
import type { CharacterAsset } from '@tamari/types';

function makeAsset(overrides: Partial<CharacterAsset> = {}): CharacterAsset {
  return {
    id: 'asset-1',
    characterId: 'char-1',
    name: 'Normal_Marisa_Kirisame_.png',
    type: 'x-risu-asset',
    ext: 'png',
    filePath: 'character_assets/char-1/asset-1.png',
    meta: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('resolveHtmlImages', () => {
  it('returns content unchanged when no assets', () => {
    expect(resolveHtmlImages('<img src="test.png">', [], 'char-1')).toBe('<img src="test.png">');
  });

  it('resolves plain filename src by fuzzy match', () => {
    const assets = [
      makeAsset({ id: 'a1', name: 'Normal_Marisa_Kirisame_.png' }),
      makeAsset({ id: 'a2', name: 'Bbang_Marisa_Kirisame_.png' }),
    ];
    const content = '<img src="Marisa Kirisame.png">';
    expect(resolveHtmlImages(content, assets, 'char-1')).toBe(
      '<img src="/api/characters/char-1/assets/a1.png">',
    );
  });

  it('prefers Normal_ prefix when multiple match', () => {
    const assets = [
      makeAsset({ id: 'a1', name: 'Bbang_Reimu_Hakurei_.png' }),
      makeAsset({ id: 'a2', name: 'Normal_Reimu_Hakurei_.png' }),
    ];
    const content = '<img src="Reimu Hakurei.png">';
    expect(resolveHtmlImages(content, assets, 'char-1')).toBe(
      '<img src="/api/characters/char-1/assets/a2.png">',
    );
  });

  it('resolves double-quoted src', () => {
    const assets = [makeAsset({ id: 'a1', name: 'logo.png' })];
    expect(resolveHtmlImages('<img src="logo.png">', assets, 'char-1')).toBe(
      '<img src="/api/characters/char-1/assets/a1.png">',
    );
  });

  it('resolves single-quoted src', () => {
    const assets = [makeAsset({ id: 'a1', name: 'logo.png' })];
    expect(resolveHtmlImages("<img src='logo.png'>", assets, 'char-1')).toBe(
      '<img src="/api/characters/char-1/assets/a1.png">',
    );
  });

  it('leaves unmatched src untouched', () => {
    const assets = [makeAsset({ id: 'a1', name: 'Other.png' })];
    const content = '<img src="Unknown.png">';
    expect(resolveHtmlImages(content, assets, 'char-1')).toBe(content);
  });

  it('handles multiple images in one string', () => {
    const assets = [
      makeAsset({ id: 'a1', name: 'Normal_Marisa_Kirisame_.png' }),
      makeAsset({ id: 'a2', name: 'Normal_Reimu_Hakurei_.png' }),
    ];
    const content = '<img src="Marisa Kirisame.png"><img src="Reimu Hakurei.png">';
    expect(resolveHtmlImages(content, assets, 'char-1')).toBe(
      '<img src="/api/characters/char-1/assets/a1.png"><img src="/api/characters/char-1/assets/a2.png">',
    );
  });
});
