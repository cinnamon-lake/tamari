import { describe, it, expect } from 'vitest';
import type { Message } from '@tamari/types';
import { deriveScene, parseScene } from './sceneState.js';

function makeMessage(id: number, parts: unknown): Message {
  return {
    id,
    parentId: null,
    role: 'assistant',
    extra: { parts: parts as Message['extra']['parts'] },
    createdAt: 0,
    updatedAt: 0,
  };
}

const tavern = {
  backgroundUrl: '/api/attachments/att-1',
  sprites: [{ name: 'Marta', emotion: 'happy', position: 'left', url: '/api/characters/c1/assets/e1.png' }],
  caption: 'The Tavern',
};

const forest = {
  backgroundUrl: null,
  sprites: [],
  caption: 'The Forest',
};

function scenePart(scene: unknown) {
  return { type: 'tool_result', content: 'Scene updated.', extra: { renderType: 'scene', scene } };
}

describe('deriveScene', () => {
  it('returns null for no messages or no scene parts', () => {
    expect(deriveScene(undefined)).toBeNull();
    expect(deriveScene([])).toBeNull();
    expect(deriveScene([makeMessage(1, [{ type: 'text', text: 'hi' }])])).toBeNull();
    expect(
      deriveScene([makeMessage(1, [{ type: 'tool_result', content: 'Rolled', extra: { renderType: 'dice' } }])]),
    ).toBeNull();
  });

  it('finds the newest scene part across messages', () => {
    const messages = [makeMessage(1, [scenePart(tavern)]), makeMessage(2, [scenePart(forest)])];
    expect(deriveScene(messages)).toEqual(forest);
  });

  it('prefers the later part within the same message', () => {
    const messages = [makeMessage(1, [scenePart(tavern), { type: 'text', text: 'x' }, scenePart(forest)])];
    expect(deriveScene(messages)).toEqual(forest);
  });

  it('ignores older scene parts once a newer one exists', () => {
    const messages = [
      makeMessage(1, [scenePart(tavern)]),
      makeMessage(2, [{ type: 'text', text: 'narration' }]),
      makeMessage(3, [scenePart(forest)]),
    ];
    expect(deriveScene(messages)).toEqual(forest);
  });

  it('returns null when the newest scene payload is malformed', () => {
    const messages = [
      makeMessage(1, [scenePart(tavern)]),
      makeMessage(2, [scenePart({ backgroundUrl: 42, sprites: [], caption: 'bad' })]),
    ];
    expect(deriveScene(messages)).toBeNull();
  });
});

describe('parseScene', () => {
  it('accepts a valid scene and keeps sprites intact', () => {
    expect(parseScene(tavern)).toEqual(tavern);
  });

  it('accepts a sprite without an emotion', () => {
    const scene = { backgroundUrl: null, sprites: [{ name: 'Bram', position: 'right', url: '/a.png' }], caption: '' };
    expect(parseScene(scene)).toEqual(scene);
  });

  it('rejects non-objects, bad fields, and malformed sprites', () => {
    expect(parseScene(null)).toBeNull();
    expect(parseScene('scene')).toBeNull();
    expect(parseScene([])).toBeNull();
    expect(parseScene({ backgroundUrl: 1, sprites: [], caption: '' })).toBeNull();
    expect(parseScene({ backgroundUrl: null, sprites: 'x', caption: '' })).toBeNull();
    expect(parseScene({ backgroundUrl: null, sprites: [], caption: 5 })).toBeNull();
    expect(parseScene({ backgroundUrl: null, sprites: [{ name: 'A', position: 'behind', url: '/a.png' }], caption: '' })).toBeNull();
    expect(parseScene({ backgroundUrl: null, sprites: [{ name: 'A', position: 'left', url: 7 }], caption: '' })).toBeNull();
    expect(parseScene({ backgroundUrl: null, sprites: [{ name: 'A', position: 'left', url: '/a.png', emotion: 3 }], caption: '' })).toBeNull();
  });
});
