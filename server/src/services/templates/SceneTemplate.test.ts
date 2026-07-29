import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Character, CharacterAsset, Chat, ChatMember } from '@tamari/types';
import { SceneTemplate, type SceneTemplateDeps } from './SceneTemplate.js';

function makeCharacter(id: string, name: string, avatarPath: string | null = `files/avatars/${id}.png`): Character {
  return { id, name, avatarPath } as unknown as Character;
}

function makeAsset(id: string, name: string, type: string, ext = 'png'): CharacterAsset {
  return {
    id,
    characterId: 'char-1',
    name,
    type,
    ext,
    filePath: `files/character_assets/char-1/${id}.${ext}`,
    meta: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeDeps(overrides: Partial<SceneTemplateDeps> = {}): SceneTemplateDeps {
  return {
    chats: {
      getChatById: vi.fn(async (id: string) => ({ id, characterId: 'char-1' }) as unknown as Chat),
    },
    characters: {
      getByName: vi.fn(async () => undefined),
      getByIds: vi.fn(async () => []),
    },
    characterAssets: {
      listForCharacter: vi.fn(async () => []),
    },
    chatMembers: {
      getMembers: vi.fn(async () => [] as ChatMember[]),
    },
    ...overrides,
  } as unknown as SceneTemplateDeps;
}

describe('SceneTemplate', () => {
  let template: SceneTemplate;
  let deps: SceneTemplateDeps;

  beforeEach(() => {
    deps = makeDeps();
    template = new SceneTemplate(deps);
  });

  it('returns an error without an active chat', async () => {
    const result = await template.execute('scene_set', {}, {});
    expect(result.content).toContain('no active chat');
  });

  it('rejects invalid arguments', async () => {
    const result = await template.execute(
      'scene_set',
      { sprites: [{ character: 'Marta', position: 'behind' }] },
      { chatId: 'chat-1' },
    );
    expect(result.content).toContain('invalid scene_set arguments');
  });

  it('resolves an attachment background to its URL', async () => {
    const result = await template.execute(
      'scene_set',
      { background: { source: 'attachment', id: 'att-1' }, caption: 'The Tavern' },
      { chatId: 'chat-1' },
    );
    const scene = result.extra!.scene as { backgroundUrl: string | null; caption: string };
    expect(scene.backgroundUrl).toBe('/api/attachments/att-1');
    expect(scene.caption).toBe('The Tavern');
    expect(result.extra!.renderType).toBe('scene');
    expect(result.content).toContain('/api/attachments/att-1');
  });

  it('resolves an asset background, preferring the background type', async () => {
    deps.characterAssets.listForCharacter = vi.fn(async () => [
      makeAsset('a-icon', 'tavern', 'icon'),
      makeAsset('a-bg', 'tavern', 'background', 'jpg'),
    ]);
    const result = await template.execute(
      'scene_set',
      { background: { source: 'asset', name: 'tavern' } },
      { chatId: 'chat-1' },
    );
    const scene = result.extra!.scene as { backgroundUrl: string | null };
    expect(scene.backgroundUrl).toBe('/api/characters/char-1/assets/a-bg.jpg');
  });

  it('clears the background when omitted', async () => {
    const result = await template.execute('scene_set', {}, { chatId: 'chat-1' });
    const scene = result.extra!.scene as { backgroundUrl: string | null; sprites: unknown[] };
    expect(scene.backgroundUrl).toBeNull();
    expect(scene.sprites).toEqual([]);
    expect(result.content).toContain('Background: cleared');
  });

  it('resolves sprites among group members first, with emotion assets', async () => {
    deps.chatMembers.getMembers = vi.fn(async () => [{ chatId: 'chat-1', characterId: 'char-9' }] as ChatMember[]);
    deps.characters.getByIds = vi.fn(async () => [makeCharacter('char-9', 'Marta')]);
    deps.characterAssets.listForCharacter = vi.fn(async (characterId: string) =>
      characterId === 'char-9' ? [makeAsset('e-happy', 'happy', 'emotion')] : [],
    );
    const result = await template.execute(
      'scene_set',
      { sprites: [{ character: 'marta', emotion: 'happy', position: 'left' }] },
      { chatId: 'chat-1' },
    );
    const scene = result.extra!.scene as { sprites: Array<Record<string, unknown>> };
    expect(scene.sprites).toEqual([
      { name: 'Marta', emotion: 'happy', position: 'left', url: '/api/characters/char-9/assets/e-happy.png' },
    ]);
    expect(deps.characters.getByName).not.toHaveBeenCalled();
  });

  it('falls back to global name lookup when no member matches', async () => {
    deps.characters.getByName = vi.fn(async (name: string) =>
      name === 'Bram' ? makeCharacter('char-2', 'Bram') : undefined,
    );
    const result = await template.execute(
      'scene_set',
      { sprites: [{ character: 'Bram', position: 'right' }] },
      { chatId: 'chat-1' },
    );
    const scene = result.extra!.scene as { sprites: Array<Record<string, unknown>> };
    expect(scene.sprites).toEqual([
      { name: 'Bram', position: 'right', url: '/files/avatars/char-2.png' },
    ]);
  });

  it('falls back to the avatar when the emotion asset is missing, and notes it', async () => {
    deps.characters.getByName = vi.fn(async () => makeCharacter('char-2', 'Bram'));
    const result = await template.execute(
      'scene_set',
      { sprites: [{ character: 'Bram', emotion: 'angry', position: 'center' }] },
      { chatId: 'chat-1' },
    );
    const scene = result.extra!.scene as { sprites: Array<Record<string, unknown>> };
    expect(scene.sprites).toEqual([
      { name: 'Bram', emotion: 'angry', position: 'center', url: '/files/avatars/char-2.png' },
    ]);
    expect(result.content).toContain('emotion asset "angry" not found');
  });

  it('omits unresolvable characters and notes them', async () => {
    const result = await template.execute(
      'scene_set',
      { sprites: [{ character: 'Ghost', position: 'left' }] },
      { chatId: 'chat-1' },
    );
    const scene = result.extra!.scene as { sprites: unknown[] };
    expect(scene.sprites).toEqual([]);
    expect(result.content).toContain('character "Ghost" not found');
  });

  it('round-trips scene state through serialize/deserialize', async () => {
    await template.execute(
      'scene_set',
      { background: { source: 'attachment', id: 'att-1' }, caption: 'The Tavern' },
      { chatId: 'chat-1' },
    );
    const raw = template.serialize();
    expect(raw).not.toBe('');

    const restored = new SceneTemplate(deps);
    restored.deserialize(raw);
    const got = await restored.execute('scene_get', {}, { chatId: 'chat-1' });
    expect(got.content).toContain('/api/attachments/att-1');
    expect(got.content).toContain('The Tavern');
    // Query tool: no renderType.
    expect(got.extra).toBeUndefined();
  });

  it('does not leak state across chats without a snapshot', async () => {
    await template.execute(
      'scene_set',
      { background: { source: 'attachment', id: 'att-1' } },
      { chatId: 'chat-1' },
    );
    // A different chat with no snapshot in its branch history starts empty.
    const got = await template.execute('scene_get', {}, { chatId: 'chat-2' });
    expect(got.content).toBe('No scene set.');
  });

  it('scene_get reports the current sprites', async () => {
    deps.characters.getByName = vi.fn(async () => makeCharacter('char-2', 'Bram'));
    await template.execute('scene_set', { sprites: [{ character: 'Bram', position: 'left' }] }, { chatId: 'chat-1' });
    // The registry deserializes the latest snapshot before each execute.
    template.deserialize(template.serialize());
    const got = await template.execute('scene_get', {}, { chatId: 'chat-1' });
    expect(got.content).toContain('Bram left');
  });
});
