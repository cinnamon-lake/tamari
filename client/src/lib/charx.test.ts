import { describe, it, expect } from 'vitest';
import { resolveEmbeddedUris } from './charx.js';
import type { Character } from '@tamari/types';

function makeCharacter(assets: Character['assets']): Character {
  return {
    id: 'char-1',
    name: 'Test',
    description: '',
    personality: '',
    scenario: '',
    firstMes: '',
    mesExample: '',
    creator: '',
    creatorNotes: '',
    characterVersion: '',
    tags: [],
    avatarPath: null,
    avatarThumbnailPath: null,
    worldInfoId: null,
    assets: assets ?? [],
    createdAt: 0,
    updatedAt: 0,
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    groupOnlyGreetings: [],
    nickname: '',
    creatorNotesMultilingual: {},
    source: [],
    extensions: {},
    createDate: '',
  };
}

describe('resolveEmbeddedUris', () => {
  it('returns content unchanged when character has no assets', () => {
    const char = makeCharacter([]);
    const content = 'Hello world';
    expect(resolveEmbeddedUris(content, char)).toBe(content);
  });

  it('returns content unchanged when character is undefined', () => {
    const content = 'Hello world';
    expect(resolveEmbeddedUris(content, undefined)).toBe(content);
  });

  it('replaces embeded:// URI with asset URL', () => {
    const char = makeCharacter([
      { id: 'asset-1', uri: 'embeded://portrait', assetUrl: '/api/characters/char-1/assets/asset-1', characterId: '', name: '', type: '', ext: '', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
    ]);
    const content = '<img src="embeded://portrait" />';
    expect(resolveEmbeddedUris(content, char)).toBe(
      '<img src="/api/characters/char-1/assets/asset-1" />',
    );
  });

  it('replaces embedded:// URI with asset URL', () => {
    const char = makeCharacter([
      { id: 'asset-1', uri: 'embeded://portrait', assetUrl: '/api/characters/char-1/assets/asset-1', characterId: '', name: '', type: '', ext: '', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
    ]);
    const content = '<img src="embedded://portrait" />';
    expect(resolveEmbeddedUris(content, char)).toBe(
      '<img src="/api/characters/char-1/assets/asset-1" />',
    );
  });

  it('leaves unknown embeded:// URIs unchanged', () => {
    const char = makeCharacter([
      { id: 'asset-1', uri: 'embeded://known', assetUrl: '/api/assets/1', characterId: '', name: '', type: '', ext: '', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
    ]);
    const content = '<img src="embeded://unknown" />';
    expect(resolveEmbeddedUris(content, char)).toBe(content);
  });

  it('replaces multiple assets in one string', () => {
    const char = makeCharacter([
      { id: 'a1', uri: 'embeded://img1', assetUrl: '/api/assets/1', characterId: '', name: '', type: '', ext: '', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
      { id: 'a2', uri: 'embeded://img2', assetUrl: '/api/assets/2', characterId: '', name: '', type: '', ext: '', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
    ]);
    const content = '<img src="embeded://img1" /><img src="embeded://img2" />';
    expect(resolveEmbeddedUris(content, char)).toBe(
      '<img src="/api/assets/1" /><img src="/api/assets/2" />',
    );
  });

  it('skips assets without assetUrl', () => {
    const char = makeCharacter([
      { id: 'a1', uri: 'embeded://img1', assetUrl: '', characterId: '', name: '', type: '', ext: '', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
      { id: 'a2', uri: 'embeded://img2', assetUrl: '/api/assets/2', characterId: '', name: '', type: '', ext: '', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
    ]);
    const content = '<img src="embeded://img2" />';
    expect(resolveEmbeddedUris(content, char)).toBe(
      '<img src="/api/assets/2" />',
    );
  });

  it('skips assets without uri', () => {
    const char = makeCharacter([
      { id: 'a1', uri: '', assetUrl: '/api/assets/1', characterId: '', name: '', type: '', ext: '', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
      { id: 'a2', uri: 'embeded://img2', assetUrl: '/api/assets/2', characterId: '', name: '', type: '', ext: '', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
    ]);
    const content = '<img src="embeded://img2" />';
    expect(resolveEmbeddedUris(content, char)).toBe(
      '<img src="/api/assets/2" />',
    );
  });

  it('handles single quotes in src', () => {
    const char = makeCharacter([
      { id: 'asset-1', uri: 'embeded://portrait', assetUrl: '/api/assets/1', characterId: '', name: '', type: '', ext: '', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
    ]);
    const content = "<img src='embeded://portrait' />";
    expect(resolveEmbeddedUris(content, char)).toBe(
      '<img src="/api/assets/1" />',
    );
  });

  it('resolves plain filename src by fuzzy name match', () => {
    const char = makeCharacter([
      { id: 'a1', uri: '', assetUrl: '/api/assets/normal', characterId: '', name: 'Normal_Marisa_Kirisame_.png', type: '', ext: 'png', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
      { id: 'a2', uri: '', assetUrl: '/api/assets/bbang', characterId: '', name: 'Bbang_Marisa_Kirisame_.png', type: '', ext: 'png', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
    ]);
    const content = '<img src="Marisa Kirisame.png">';
    expect(resolveEmbeddedUris(content, char)).toBe(
      '<img src="/api/assets/normal">',
    );
  });

  it('resolves plain filename src with single quotes', () => {
    const char = makeCharacter([
      { id: 'a1', uri: '', assetUrl: '/api/assets/reimu', characterId: '', name: 'Normal_Reimu_Hakurei_.png', type: '', ext: 'png', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
    ]);
    const content = "<img src='Reimu Hakurei.png'>";
    expect(resolveEmbeddedUris(content, char)).toBe(
      '<img src="/api/assets/reimu">',
    );
  });

  it('leaves unmatched plain filename src untouched', () => {
    const char = makeCharacter([
      { id: 'a1', uri: '', assetUrl: '/api/assets/1', characterId: '', name: 'Other.png', type: '', ext: 'png', filePath: null, meta: {}, createdAt: 0, updatedAt: 0 },
    ]);
    const content = '<img src="Unknown Person.png">';
    expect(resolveEmbeddedUris(content, char)).toBe(content);
  });
});
