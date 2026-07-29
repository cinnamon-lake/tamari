import { describe, it, expect, vi } from 'vitest';
import { CharacterWorkbench } from './CharacterWorkbench.js';
import { LuaRuntime } from '../../scripting/LuaRuntime.js';
import { storeRisuModule, CHARACTER_RISU_MODULES_EXTENSION_KEY } from '../characterRisuModules.js';
import type { RisuModuleData } from '../../lib/risum.js';
import type { Attachment, Character, CharacterInsert, CharacterUpdate, WorldInfo, WorldInfoEntry, WorldInfoInsert, WorldInfoUpdate } from '@tamari/types';
import type { EventBus } from '../../bus/EventBus.js';
import type { ICharacterRepository } from '../../repos/CharacterRepository.js';
import type { IWorldInfoRepository } from '../../repos/WorldInfoRepository.js';

/** Smallest valid PNG (1x1). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char1',
    name: 'Test Character',
    description: 'A test character',
    personality: '',
    scenario: '',
    firstMes: 'Hello!',
    mesExample: '',
    creator: '',
    characterVersion: '',
    tags: [],
    avatarPath: null,
    avatarThumbnailPath: null,
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    groupOnlyGreetings: [],
    nickname: '',
    creatorNotesMultilingual: {},
    source: [],
    extensions: {},
    createDate: '',
    worldInfoId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  return {
    id: 'entry1',
    keys: ['dragon'],
    content: 'Dragons are real',
    comment: '',
    order: 0,
    position: 'before_char',
    probability: 100,
    constant: false,
    selective: false,
    secondaryKeys: [],
    addMemo: false,
    disable: false,
    regex: false,
    recursive: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    ...overrides,
  };
}

function makeBook(overrides: Partial<WorldInfo> = {}): WorldInfo {
  return {
    id: 'book1',
    name: 'Test Book',
    entries: [makeEntry()],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeTemplate(opts: { characters?: Character[]; books?: WorldInfo[]; globalRegexRules?: unknown[]; attachments?: Attachment[] } = {}) {
  const charStore = new Map((opts.characters ?? []).map((c) => [c.id, c]));
  const characters = {
    getById: async (id: string) => charStore.get(id),
    getByName: async (name: string) => [...charStore.values()].find((c) => c.name.toLowerCase() === name.toLowerCase()),
    listSummaries: async () => ({
      items: [...charStore.values()].map((c) => ({
        id: c.id,
        name: c.name,
        tags: c.tags,
        avatarPath: c.avatarPath,
        avatarThumbnailPath: c.avatarThumbnailPath,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
      total: charStore.size,
    }),
    create: async (id: string, data: CharacterInsert) => {
      const character = makeCharacter({ id, ...(data as Partial<Character>) });
      charStore.set(id, character);
      return character;
    },
    update: async (id: string, patch: CharacterUpdate) => {
      const existing = charStore.get(id);
      if (!existing) throw new Error('not found');
      // Mirror the real repo: character.update does not touch assets
      // (they are managed via CharacterAssetRepository).
      const updated = { ...existing, ...patch, assets: existing.assets };
      charStore.set(id, updated);
      return updated;
    },
  } as unknown as ICharacterRepository;

  const bookStore = new Map((opts.books ?? []).map((b) => [b.id, b]));
  const worldInfo = {
    getById: async (id: string) => bookStore.get(id),
    list: async () => [...bookStore.values()],
    create: async (id: string, data: WorldInfoInsert) => {
      const book: WorldInfo = { id, name: data.name, entries: data.entries, createdAt: 1, updatedAt: 1 };
      bookStore.set(id, book);
      return book;
    },
    update: async (id: string, patch: WorldInfoUpdate) => {
      const existing = bookStore.get(id);
      if (!existing) throw new Error('not found');
      const updated = { ...existing, ...patch, entries: patch.entries ?? existing.entries };
      bookStore.set(id, updated);
      return updated;
    },
  } as unknown as IWorldInfoRepository;

  const bus = { broadcast: vi.fn() } as unknown as EventBus;
  const ragService = { indexWorldInfoEntries: vi.fn(async () => {}) };
  const settings = {
    list: async () => (opts.globalRegexRules ? { regexRules: opts.globalRegexRules } : {}),
    get: async () => undefined,
  };
  const attachmentStore = new Map((opts.attachments ?? []).map((a) => [a.id, a]));
  const attachments = { getById: async (id: string) => attachmentStore.get(id) };
  const assetStore = new Map<string, Record<string, unknown>>();
  const characterAssets = {
    listForCharacter: async (characterId: string) =>
      [...assetStore.values()].filter((a) => a['characterId'] === characterId),
    getById: async (id: string) => assetStore.get(id),
    create: async (characterId: string, data: Record<string, unknown>) => {
      const asset = { ...data, characterId, meta: (data['meta'] ?? {}) as Record<string, unknown> };
      assetStore.set(data['id'] as string, asset);
      return asset;
    },
    delete: async (id: string) => {
      assetStore.delete(id);
    },
  };
  const storageFiles = new Map<string, Buffer>();
  const storage = {
    write: (sub: string, name: string, data: Uint8Array) => {
      const p = `files/${sub}/${name}`;
      storageFiles.set(p, Buffer.from(data));
      return p;
    },
    read: (p: string) => {
      const buf = storageFiles.get(p);
      if (!buf) throw new Error(`no such file: ${p}`);
      return buf;
    },
    exists: (p: string) => storageFiles.has(p),
    resolve: (p: string) => p,
    delete: (p: string) => {
      storageFiles.delete(p);
    },
  };

  const template = new CharacterWorkbench({
    characters,
    worldInfo,
    settings: settings as never,
    attachments: attachments as never,
    characterAssets: characterAssets as never,
    storage: storage as never,
    bus,
    luaRuntime: new LuaRuntime(),
    ragService,
  });
  return { template, bus, ragService, charStore, bookStore, storageFiles, assetStore };
}

function broadcastTypes(bus: EventBus): string[] {
  const broadcast = bus.broadcast as ReturnType<typeof vi.fn>;
  return broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
}

describe('CharacterWorkbench', () => {
  describe('character_get', () => {
    it('returns the full character by id', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('character_get', { characterId: 'char1' });
      const parsed = JSON.parse(res.content as string) as { id: string; name: string };
      expect(parsed.id).toBe('char1');
      expect(parsed.name).toBe('Test Character');
    });

    it('errors for an unknown character', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('character_get', { characterId: 'nope' });
      expect(res.content).toBe('Error: character "nope" not found');
    });
  });

  describe('character_create', () => {
    it('creates a character and broadcasts created/snapshot/listed', async () => {
      const { template, bus, charStore } = makeTemplate();
      const res = await template.execute('character_create', {
        name: 'New Character',
        description: 'Fresh',
        nickname: 'Newbie',
        alternateGreetings: ['Hi again', 'Oh, you again'],
        tags: ['npc'],
      });
      // Slim result: id + name only — the model wrote the rest itself.
      const parsed = JSON.parse(res.content as string) as { id: string; name: string };
      expect(parsed.name).toBe('New Character');
      expect(parsed.id).toBeTruthy();
      expect(res.content).not.toContain('Fresh');
      // The stored card has everything.
      const stored = [...charStore.values()][0]!;
      expect(stored.description).toBe('Fresh');
      expect(stored.nickname).toBe('Newbie');
      expect(stored.alternateGreetings).toEqual(['Hi again', 'Oh, you again']);
      expect(stored.tags).toEqual(['npc']);
      expect(charStore.size).toBe(1);
      expect(broadcastTypes(bus)).toEqual(['character.created', 'character.listed', 'character.snapshot']);
    });

    it('errors on duplicate name', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('character_create', { name: 'Test Character' });
      expect(res.content).toBe('Error: character "Test Character" already exists');
    });

    it('reports zod issues on invalid arguments', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('character_create', { description: 'no name' });
      expect(res.content).toContain('Error: invalid arguments');
      expect(res.content).toContain('name');
    });
  });

  describe('character_update', () => {
    it('patches whitelisted fields and broadcasts updated/snapshot/listed', async () => {
      const { template, bus, charStore } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('character_update', {
        characterId: 'char1',
        patch: { description: 'Updated', scenario: 'New scenario' },
      });
      const parsed = JSON.parse(res.content as string) as { id: string; name: string };
      expect(parsed).toEqual({ id: 'char1', name: 'Test Character' });
      const stored = charStore.get('char1')!;
      expect(stored.description).toBe('Updated');
      expect(stored.scenario).toBe('New scenario');
      expect(broadcastTypes(bus)).toEqual(['character.updated', 'character.listed', 'character.snapshot']);
    });

    it('renames the character', async () => {
      const { template, charStore } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('character_update', {
        characterId: 'char1',
        patch: { name: 'Renamed Character' },
      });
      const parsed = JSON.parse(res.content as string) as { name: string };
      expect(parsed.name).toBe('Renamed Character');
      expect(charStore.get('char1')?.name).toBe('Renamed Character');
    });

    it('rejects a rename colliding with another character', async () => {
      const { template } = makeTemplate({
        characters: [makeCharacter(), makeCharacter({ id: 'char2', name: 'Other Character' })],
      });
      const res = await template.execute('character_update', {
        characterId: 'char2',
        patch: { name: 'Test Character' },
      });
      expect(res.content).toBe('Error: character "Test Character" already exists');
    });

    it('errors for an unknown character', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('character_update', { characterId: 'nope', patch: { description: 'x' } });
      expect(res.content).toBe('Error: character "nope" not found');
    });
  });

  describe('character_clone', () => {
    it('deep-copies the card, lorebook, avatar, assets, and module data', async () => {
      const { template, bus, charStore, bookStore, assetStore, storageFiles } = makeTemplate({
        characters: [
          makeCharacter({
            description: 'Original desc',
            tags: ['touhou'],
            avatarPath: 'files/avatars/orig.png',
            avatarThumbnailPath: 'files/avatars/thumbs/orig.png',
            worldInfoId: 'book1',
            extensions: { regexScripts: [{ id: 'r1', findRegex: '/a/g' }], custom: { nested: true } },
          }),
        ],
        books: [makeBook()],
      });
      storageFiles.set('files/avatars/orig.png', TINY_PNG);
      storageFiles.set('files/avatars/thumbs/orig.png', TINY_PNG);
      assetStore.set('a1', { id: 'a1', characterId: 'char1', name: 'cover', ext: 'png', type: 'image', filePath: 'files/character_assets/char1/a1.png', meta: { origin: 'card' } });
      storageFiles.set('files/character_assets/char1/a1.png', TINY_PNG);
      // Seed a raw module file + meta.
      const moduleMeta = { id: 'm1', name: 'Mod', filePath: 'files/character_modules/char1/m1.json' };
      charStore.set('char1', {
        ...charStore.get('char1')!,
        extensions: { ...charStore.get('char1')!.extensions, risuModules: [moduleMeta] },
      });
      storageFiles.set('files/character_modules/char1/m1.json', Buffer.from('{"name":"Mod"}'));

      const res = await template.execute('character_clone', { sourceCharacterId: 'char1' });
      const parsed = JSON.parse(res.content as string) as { id: string; name: string; lorebookEntries: number; assetsCopied: number; modulesCopied: number };
      expect(parsed.name).toBe('Test Character (Copy)');
      expect(parsed.lorebookEntries).toBe(1);
      expect(parsed.assetsCopied).toBe(1);
      expect(parsed.modulesCopied).toBe(1);

      const clone = charStore.get(parsed.id)!;
      expect(clone.description).toBe('Original desc');
      expect(clone.tags).toEqual(['touhou']);
      expect(clone.extensions['custom']).toEqual({ nested: true });
      expect(clone.extensions['regexScripts']).toEqual([{ id: 'r1', findRegex: '/a/g' }]);

      // Avatar: copied to new files, not shared.
      expect(clone.avatarPath).not.toBe('files/avatars/orig.png');
      expect(storageFiles.has(clone.avatarPath!)).toBe(true);

      // Lorebook: a NEW book with the same entries, linked to the clone.
      expect(clone.worldInfoId).toBeTruthy();
      expect(clone.worldInfoId).not.toBe('book1');
      const cloneBook = bookStore.get(clone.worldInfoId!)!;
      expect(cloneBook.entries[0]?.content).toBe('Dragons are real');

      // Assets: new record owned by the clone, file duplicated.
      const cloneAssets = [...assetStore.values()].filter((a) => a['characterId'] === parsed.id);
      expect(cloneAssets).toHaveLength(1);
      expect(storageFiles.has(cloneAssets[0]!['filePath'] as string)).toBe(true);

      // Module: file copied into the clone's directory, meta rewritten.
      const cloneMetas = clone.extensions['risuModules'] as Array<{ id: string; filePath: string }>;
      expect(cloneMetas[0]?.filePath).toBe(`files/character_modules/${parsed.id}/m1.json`);
      expect(storageFiles.has(cloneMetas[0]!.filePath)).toBe(true);

      // Broadcasts: worldinfo.created triplet, then character created/snapshot/listed.
      const types = broadcastTypes(bus);
      expect(types).toContain('worldinfo.created');
      expect(types).toContain('character.created');
      expect(types).toContain('character.snapshot');
      expect(types).toContain('character.listed');

      // The original is untouched.
      expect(charStore.get('char1')?.worldInfoId).toBe('book1');
    });

    it('honors an explicit clone name and rejects collisions', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const ok = await template.execute('character_clone', { sourceCharacterId: 'char1', name: 'Ported Copy' });
      expect(JSON.parse(ok.content as string)).toMatchObject({ name: 'Ported Copy' });

      // First default-named clone succeeds…
      const first = await template.execute('character_clone', { sourceCharacterId: 'char1' });
      expect(JSON.parse(first.content as string)).toMatchObject({ name: 'Test Character (Copy)' });
      // …the second collides with it.
      const clash = await template.execute('character_clone', { sourceCharacterId: 'char1' });
      expect(clash.content).toBe('Error: character "Test Character (Copy)" already exists — pass a different name');
    });

    it('errors for an unknown source character', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('character_clone', { sourceCharacterId: 'nope' });
      expect(res.content).toBe('Error: character "nope" not found');
    });
  });

  describe('lorebook_get', () => {
    it('returns the linked book\'s name and entries', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter({ worldInfoId: 'book1' })], books: [makeBook()] });
      const res = await template.execute('lorebook_get', { characterId: 'char1' });
      const parsed = JSON.parse(res.content as string) as { name: string; entries: WorldInfoEntry[] };
      expect(parsed.name).toBe('Test Book');
      expect(parsed.entries[0]?.id).toBe('entry1');
      expect(parsed.entries[0]?.content).toBe('Dragons are real');
    });

    it('returns empty entries when the character has no lorebook yet', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('lorebook_get', { characterId: 'char1' });
      expect(JSON.parse(res.content as string)).toEqual({ name: null, entries: [] });
    });

    it('errors for an unknown character', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('lorebook_get', { characterId: 'nope' });
      expect(res.content).toBe('Error: character "nope" not found');
    });
  });

  describe('lorebook_entry_add', () => {
    it('appends an entry to the linked book and broadcasts updated/snapshot/listed', async () => {
      const { template, bus, bookStore } = makeTemplate({
        characters: [makeCharacter({ worldInfoId: 'book1' })],
        books: [makeBook()],
      });
      const res = await template.execute('lorebook_entry_add', {
        characterId: 'char1',
        entry: { keys: ['dwarf'], content: 'Dwarves dig deep' },
      });
      const parsed = JSON.parse(res.content as string) as WorldInfoEntry;
      expect(parsed.id).toBeTruthy();
      expect(parsed.content).toBe('Dwarves dig deep');
      expect(bookStore.get('book1')?.entries).toHaveLength(2);
      expect(broadcastTypes(bus)).toEqual(['worldinfo.updated', 'worldinfo.snapshot', 'worldinfo.listed']);
    });

    it('creates and links a lorebook on first write (create-on-write)', async () => {
      const { template, bus, charStore, bookStore, ragService } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('lorebook_entry_add', {
        characterId: 'char1',
        entry: { keys: ['elf'], content: 'Elves live long' },
      });
      const parsed = JSON.parse(res.content as string) as WorldInfoEntry;
      expect(parsed.id).toBeTruthy();

      // A book named after the character was created and linked to the card.
      expect(bookStore.size).toBe(1);
      const book = [...bookStore.values()][0]!;
      expect(book.name).toBe('Test Character');
      expect(book.entries).toHaveLength(1);
      expect(charStore.get('char1')?.worldInfoId).toBe(book.id);

      // Character link triplet, then book created triplet, then entry-added triplet.
      expect(broadcastTypes(bus)).toEqual([
        'character.updated',
        'character.snapshot',
        'character.listed',
        'worldinfo.created',
        'worldinfo.snapshot',
        'worldinfo.listed',
        'worldinfo.updated',
        'worldinfo.snapshot',
        'worldinfo.listed',
      ]);
      expect(ragService.indexWorldInfoEntries).toHaveBeenCalled();
    });

    it('errors for an unknown character', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('lorebook_entry_add', {
        characterId: 'nope',
        entry: { keys: [], content: 'x' },
      });
      expect(res.content).toBe('Error: character "nope" not found');
    });
  });

  describe('lorebook_entry_update', () => {
    it('patches the entry in place and broadcasts updated/snapshot/listed', async () => {
      const { template, bus, bookStore } = makeTemplate({
        characters: [makeCharacter({ worldInfoId: 'book1' })],
        books: [makeBook()],
      });
      const res = await template.execute('lorebook_entry_update', {
        characterId: 'char1',
        entryId: 'entry1',
        patch: { content: 'Dragons are extinct', constant: true },
      });
      const parsed = JSON.parse(res.content as string) as WorldInfoEntry;
      expect(parsed.content).toBe('Dragons are extinct');
      expect(parsed.constant).toBe(true);
      // Untouched fields survive
      expect(parsed.keys).toEqual(['dragon']);
      expect(bookStore.get('book1')?.entries).toHaveLength(1);
      expect(broadcastTypes(bus)).toEqual(['worldinfo.updated', 'worldinfo.snapshot', 'worldinfo.listed']);
    });

    it('errors when the entry is not found', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter({ worldInfoId: 'book1' })], books: [makeBook()] });
      const res = await template.execute('lorebook_entry_update', {
        characterId: 'char1',
        entryId: 'nope',
        patch: { content: 'x' },
      });
      expect(res.content).toBe('Error: entry "nope" not found in the character\'s lorebook');
    });

    it('errors when the character has no lorebook', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('lorebook_entry_update', {
        characterId: 'char1',
        entryId: 'entry1',
        patch: { content: 'x' },
      });
      expect(res.content).toContain('has no lorebook yet');
    });
  });

  describe('lorebook_entry_remove', () => {
    it('removes the entry and broadcasts updated/snapshot/listed', async () => {
      const { template, bus, bookStore } = makeTemplate({
        characters: [makeCharacter({ worldInfoId: 'book1' })],
        books: [makeBook({ entries: [makeEntry(), makeEntry({ id: 'entry2', keys: ['elf'], content: 'Elves' })] })],
      });
      const res = await template.execute('lorebook_entry_remove', { characterId: 'char1', entryId: 'entry1' });
      expect(JSON.parse(res.content as string)).toEqual({ removed: 'entry1' });
      expect(bookStore.get('book1')?.entries.map((e) => e.id)).toEqual(['entry2']);
      expect(broadcastTypes(bus)).toEqual(['worldinfo.updated', 'worldinfo.snapshot', 'worldinfo.listed']);
    });

    it('errors when the entry is not found', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter({ worldInfoId: 'book1' })], books: [makeBook()] });
      const res = await template.execute('lorebook_entry_remove', { characterId: 'char1', entryId: 'nope' });
      expect(res.content).toBe('Error: entry "nope" not found in the character\'s lorebook');
    });
  });

  describe('lorebook_entry_move', () => {
    const threeEntries = () =>
      makeBook({
        entries: [
          makeEntry({ id: 'e1', keys: ['a'] }),
          makeEntry({ id: 'e2', keys: ['b'] }),
          makeEntry({ id: 'e3', keys: ['c'] }),
        ],
      });

    it('moves an entry to the target index and returns the new order', async () => {
      const { template, bookStore } = makeTemplate({
        characters: [makeCharacter({ worldInfoId: 'book1' })],
        books: [threeEntries()],
      });
      const res = await template.execute('lorebook_entry_move', { characterId: 'char1', entryId: 'e3', index: 0 });
      const parsed = JSON.parse(res.content as string) as { entryId: string; index: number; entryOrder: string[] };
      expect(parsed).toEqual({ entryId: 'e3', index: 0, entryOrder: ['e3', 'e1', 'e2'] });
      expect(bookStore.get('book1')?.entries.map((e) => e.id)).toEqual(['e3', 'e1', 'e2']);
    });

    it('clamps an out-of-range index to the end', async () => {
      const { template, bookStore } = makeTemplate({
        characters: [makeCharacter({ worldInfoId: 'book1' })],
        books: [threeEntries()],
      });
      const res = await template.execute('lorebook_entry_move', { characterId: 'char1', entryId: 'e1', index: 99 });
      const parsed = JSON.parse(res.content as string) as { index: number; entryOrder: string[] };
      expect(parsed.index).toBe(2);
      expect(parsed.entryOrder).toEqual(['e2', 'e3', 'e1']);
      expect(bookStore.get('book1')?.entries.map((e) => e.id)).toEqual(['e2', 'e3', 'e1']);
    });

    it('errors when the entry is not found', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter({ worldInfoId: 'book1' })], books: [makeBook()] });
      const res = await template.execute('lorebook_entry_move', { characterId: 'char1', entryId: 'nope', index: 0 });
      expect(res.content).toBe('Error: entry "nope" not found in the character\'s lorebook');
    });
  });

  describe('regex tools', () => {
    const ruleInput = { name: 'Shout', findRegex: '/hello/gi', replaceString: 'HELLO' };

    it('adds a rule with defaults and lists it; broadcasts the character events', async () => {
      const { template, bus, charStore } = makeTemplate({ characters: [makeCharacter()] });
      const add = await template.execute('regex_add', { characterId: 'char1', rule: ruleInput });
      const created = JSON.parse(add.content as string) as { id: string; prompt: boolean; display: boolean };
      expect(created.id).toBeTruthy();
      expect(created.prompt).toBe(true);
      expect(created.display).toBe(true);
      expect(broadcastTypes(bus)).toEqual(['character.updated', 'character.snapshot', 'character.listed']);

      const list = await template.execute('regex_list', { characterId: 'char1' });
      const rules = JSON.parse(list.content as string) as Array<{ id: string; name: string }>;
      expect(rules).toHaveLength(1);
      expect(rules[0]?.name).toBe('Shout');
      expect(charStore.get('char1')?.extensions['regexScripts']).toHaveLength(1);
    });

    it('rejects a bare (undelimited) pattern without saving', async () => {
      const { template, charStore } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('regex_add', { characterId: 'char1', rule: { ...ruleInput, findRegex: 'hello' } });
      expect(res.content).toContain('Error: invalid findRegex');
      expect(charStore.get('char1')?.extensions['regexScripts'] ?? []).toHaveLength(0);
    });

    it('accepts a Lua-only rule without replaceString, defaulting it to empty', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const add = await template.execute('regex_add', {
        characterId: 'char1',
        rule: {
          name: 'Lua shout',
          findRegex: '/hello/gi',
          replaceLua: 'function replace(match, captures) return "HI" end',
        },
      });
      const created = JSON.parse(add.content as string) as { replaceString: string; replaceLua?: string };
      expect(created.replaceString).toBe('');
      expect(created.replaceLua).toContain('function replace');
    });

    it('updates a rule in place', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const add = await template.execute('regex_add', { characterId: 'char1', rule: ruleInput });
      const created = JSON.parse(add.content as string) as { id: string };
      const upd = await template.execute('regex_update', {
        characterId: 'char1',
        ruleId: created.id,
        patch: { replaceString: 'HI', display: false },
      });
      const updated = JSON.parse(upd.content as string) as { replaceString: string; display: boolean; findRegex: string };
      expect(updated.replaceString).toBe('HI');
      expect(updated.display).toBe(false);
      expect(updated.findRegex).toBe('/hello/gi');
    });

    it('removes a rule', async () => {
      const { template, charStore } = makeTemplate({ characters: [makeCharacter()] });
      const add = await template.execute('regex_add', { characterId: 'char1', rule: ruleInput });
      const created = JSON.parse(add.content as string) as { id: string };
      const res = await template.execute('regex_remove', { characterId: 'char1', ruleId: created.id });
      expect(res.content).toBe(`{"removed":"${created.id}"}`);
      expect(charStore.get('char1')?.extensions['regexScripts']).toHaveLength(0);
    });

    it('errors for unknown character / rule', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('regex_list', { characterId: 'nope' });
      expect(res.content).toBe('Error: character "nope" not found');
      const { template: t2 } = makeTemplate({ characters: [makeCharacter()] });
      const res2 = await t2.execute('regex_remove', { characterId: 'char1', ruleId: 'nope' });
      expect(res2.content).toBe('Error: regex rule "nope" not found on character "char1"');
    });
  });

  describe('regex_test', () => {
    it('returns prompt and display variants from merged global + scoped rules', async () => {
      const { template } = makeTemplate({
        characters: [
          makeCharacter({
            extensions: {
              regexScripts: [{ id: 's1', findRegex: '/world/g', replaceString: 'Mocktopia', prompt: true, display: true }],
            },
          }),
        ],
        globalRegexRules: [{ id: 'g1', findRegex: '/hello/g', replaceString: 'hail', prompt: true, display: false }],
      });
      const res = await template.execute('regex_test', { characterId: 'char1', text: 'hello world' });
      const parsed = JSON.parse(res.content as string) as { role: string; ruleCount: number; prompt: string; display: string };
      expect(parsed.ruleCount).toBe(2);
      // prompt: global (prompt) + scoped (prompt) both apply
      expect(parsed.prompt).toBe('hail Mocktopia');
      // display: global rule is prompt-only; only scoped applies
      expect(parsed.display).toBe('hello Mocktopia');
      expect(parsed.role).toBe('assistant');
    });

    it('ruleCount excludes disabled rules', async () => {
      const { template } = makeTemplate({
        globalRegexRules: [
          { id: 'g1', findRegex: '/a/g', replaceString: 'b', prompt: true, display: true },
          { id: 'g2', findRegex: '/c/g', replaceString: 'd', prompt: true, display: true, disabled: true },
        ],
      });
      const res = await template.execute('regex_test', { text: 'a' });
      const parsed = JSON.parse(res.content as string) as { ruleCount: number; prompt: string };
      expect(parsed.ruleCount).toBe(1);
      expect(parsed.prompt).toBe('b');
    });

    it('works without a characterId (global rules only)', async () => {
      const { template } = makeTemplate({
        globalRegexRules: [{ id: 'g1', findRegex: '/a/g', replaceString: 'b', prompt: true, display: true }],
      });
      const res = await template.execute('regex_test', { text: 'aaa' });
      const parsed = JSON.parse(res.content as string) as { prompt: string };
      expect(parsed.prompt).toBe('bbb');
    });

    it('respects role filtering', async () => {
      const { template } = makeTemplate({
        globalRegexRules: [{ id: 'g1', findRegex: '/x/g', replaceString: 'y', prompt: true, display: true, userInput: true }],
      });
      const asUser = JSON.parse((await template.execute('regex_test', { text: 'x', role: 'user' })).content as string) as { display: string };
      expect(asUser.display).toBe('y');
      const asAssistant = JSON.parse((await template.execute('regex_test', { text: 'x', role: 'assistant' })).content as string) as { display: string };
      expect(asAssistant.display).toBe('x');
    });

    it('errors for an unknown character', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('regex_test', { characterId: 'nope', text: 'x' });
      expect(res.content).toBe('Error: character "nope" not found');
    });

    it('stores and applies a replaceLua rule (Layer 2)', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const addRes = await template.execute('regex_add', {
        characterId: 'char1',
        rule: {
          name: 'HUD expander',
          findRegex: '/HP: (\\d+)/g',
          replaceString: '',
          replaceLua: 'function replace(match, captures) return "<b>HP: " .. captures[1] .. "</b>" end',
        },
      });
      const added = JSON.parse(addRes.content as string) as { replaceLua?: string };
      expect(added.replaceLua).toContain('function replace');

      const res = await template.execute('regex_test', { characterId: 'char1', text: 'HP: 12' });
      const parsed = JSON.parse(res.content as string) as { display: string };
      expect(parsed.display).toBe('<b>HP: 12</b>');
    });
  });

  describe('character_set_avatar', () => {
    function makeImageAttachment(filePath: string, mimeType = 'image/png'): Attachment {
      return { id: 'att1', messageId: null, mimeType, filePath, meta: {}, url: `/api/attachments/att1` };
    }

    it('sets avatar + thumbnail from an attachment image and broadcasts', async () => {
      const { template, bus, charStore, storageFiles } = makeTemplate({
        characters: [makeCharacter()],
        attachments: [makeImageAttachment('files/attachments/att1')],
      });
      storageFiles.set('files/attachments/att1', TINY_PNG);

      const res = await template.execute('character_set_avatar', { characterId: 'char1', attachmentId: 'att1' });
      const parsed = JSON.parse(res.content as string) as { id: string; avatarUrl: string | null; thumbnailUrl: string | null };
      expect(parsed.id).toBe('char1');
      expect(parsed.avatarUrl).toContain('files/avatars/');
      expect(parsed.thumbnailUrl).toContain('files/avatars/thumbs/');
      expect(charStore.get('char1')?.avatarPath).toBe(parsed.avatarUrl?.slice(1));
      expect(broadcastTypes(bus)).toEqual(['character.updated', 'character.snapshot', 'character.listed']);
    });

    it('copies the avatar from another character', async () => {
      const source = makeCharacter({ id: 'char2', name: 'Source', avatarPath: 'files/avatars/source.png', avatarThumbnailPath: 'files/avatars/thumbs/source.png' });
      const { template, charStore, storageFiles } = makeTemplate({ characters: [makeCharacter(), source] });
      storageFiles.set('files/avatars/source.png', TINY_PNG);

      const res = await template.execute('character_set_avatar', { characterId: 'char1', sourceCharacterId: 'char2' });
      const parsed = JSON.parse(res.content as string) as { avatarUrl: string | null };
      expect(parsed.avatarUrl).toContain('files/avatars/');
      expect(parsed.avatarUrl).not.toBe('/files/avatars/source.png');
      expect(charStore.get('char1')?.avatarPath).toBe(parsed.avatarUrl?.slice(1));
      // The source card keeps its own avatar.
      expect(charStore.get('char2')?.avatarPath).toBe('files/avatars/source.png');
    });

    it('errors when the source character has no avatar', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter(), makeCharacter({ id: 'char2', name: 'Source' })] });
      const res = await template.execute('character_set_avatar', { characterId: 'char1', sourceCharacterId: 'char2' });
      expect(res.content).toBe('Error: character "char2" has no avatar to copy');
    });

    it('requires exactly one of attachmentId / sourceCharacterId', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const both = await template.execute('character_set_avatar', { characterId: 'char1', attachmentId: 'a', sourceCharacterId: 'b' });
      expect(both.content).toBe('Error: pass exactly one of attachmentId or sourceCharacterId');
      const neither = await template.execute('character_set_avatar', { characterId: 'char1' });
      expect(neither.content).toBe('Error: pass exactly one of attachmentId or sourceCharacterId');
    });

    it('rejects a non-image attachment', async () => {
      const { template } = makeTemplate({
        characters: [makeCharacter()],
        attachments: [makeImageAttachment('files/attachments/att1', 'audio/wav')],
      });
      const res = await template.execute('character_set_avatar', { characterId: 'char1', attachmentId: 'att1' });
      expect(res.content).toContain('Error: attachment "att1" is not an image');
    });

    it('errors for unknown character / attachment', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('character_set_avatar', { characterId: 'nope', attachmentId: 'att1' });
      expect(res.content).toBe('Error: character "nope" not found');
      const { template: t2 } = makeTemplate({ characters: [makeCharacter()] });
      const res2 = await t2.execute('character_set_avatar', { characterId: 'char1', attachmentId: 'nope' });
      expect(res2.content).toBe('Error: attachment "nope" not found');
    });
  });

  describe('character asset tools', () => {
    it('character_asset_list lists imported assets', async () => {
      const { template, assetStore } = makeTemplate({ characters: [makeCharacter()] });
      // Seed as risu_module_attach / the REST route would have (origin: risu-module).
      assetStore.set('a1', { id: 'a1', characterId: 'char1', name: 'bgm', ext: 'mp3', type: 'other', meta: { origin: 'risu-module' } });
      assetStore.set('a2', { id: 'a2', characterId: 'char1', name: 'cover', ext: 'png', type: 'other', meta: { origin: 'risu-module' } });

      const res = await template.execute('character_asset_list', { characterId: 'char1' });
      const parsed = JSON.parse(res.content as string) as {
        total: number;
        assets: Array<{ name: string; ext: string; origin: string }>;
      };
      expect(parsed.total).toBe(2);
      expect(parsed.assets.map((a) => a.name).sort()).toEqual(['bgm', 'cover']);
      expect(parsed.assets[0]!.origin).toBe('risu-module');
    });

    it('character_asset_add imports an attachment as a character asset', async () => {
      const attachment: Attachment = { id: 'att1', messageId: null, mimeType: 'image/png', filePath: 'files/attachments/att1', meta: {}, url: '/api/attachments/att1' };
      const { template, bus, assetStore, storageFiles } = makeTemplate({ characters: [makeCharacter()], attachments: [attachment] });
      storageFiles.set('files/attachments/att1', TINY_PNG);

      const res = await template.execute('character_asset_add', { characterId: 'char1', attachmentId: 'att1', name: 'portrait' });
      const parsed = JSON.parse(res.content as string) as { id: string; name: string; type: string; ext: string; assetUrl: string; origin: string };
      expect(parsed.name).toBe('portrait');
      expect(parsed.type).toBe('image');
      expect(parsed.ext).toBe('png');
      expect(parsed.origin).toBe('workbench');
      expect(parsed.assetUrl).toBe(`/api/characters/char1/assets/${parsed.id}.png`);
      expect(assetStore.get(parsed.id)?.['filePath']).toBe(`files/character_assets/char1/${parsed.id}.png`);
      expect(storageFiles.get(`files/character_assets/char1/${parsed.id}.png`)).toEqual(TINY_PNG);
      expect(broadcastTypes(bus)).toEqual(['character.updated', 'character.snapshot', 'character.listed']);
    });

    it('character_asset_add derives type/extension from the MIME type', async () => {
      const attachment: Attachment = { id: 'att2', messageId: null, mimeType: 'audio/mpeg', filePath: 'files/attachments/att2', meta: {}, url: '/api/attachments/att2' };
      const { template, storageFiles } = makeTemplate({ characters: [makeCharacter()], attachments: [attachment] });
      storageFiles.set('files/attachments/att2', Buffer.from('ID3'));

      const res = await template.execute('character_asset_add', { characterId: 'char1', attachmentId: 'att2' });
      const parsed = JSON.parse(res.content as string) as { name: string; type: string; ext: string };
      expect(parsed.type).toBe('audio');
      expect(parsed.ext).toBe('mpeg');
      // No name given — falls back to the attachment id.
      expect(parsed.name).toBe('att2');
    });

    it('character_asset_add errors for unknown character / attachment', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('character_asset_add', { characterId: 'nope', attachmentId: 'att1' });
      expect(res.content).toBe('Error: character "nope" not found');
      const { template: t2 } = makeTemplate({ characters: [makeCharacter()] });
      const res2 = await t2.execute('character_asset_add', { characterId: 'char1', attachmentId: 'nope' });
      expect(res2.content).toBe('Error: attachment "nope" not found');
    });

    it('character_asset_remove deletes the record and the stored file', async () => {
      const { template, assetStore, storageFiles } = makeTemplate({ characters: [makeCharacter()] });
      assetStore.set('a1', { id: 'a1', characterId: 'char1', name: 'cover', ext: 'png', type: 'image', filePath: 'files/character_assets/char1/a1.png', meta: {} });
      storageFiles.set('files/character_assets/char1/a1.png', TINY_PNG);

      const res = await template.execute('character_asset_remove', { characterId: 'char1', assetId: 'a1' });
      expect(JSON.parse(res.content as string)).toEqual({ removed: 'a1' });
      expect(assetStore.has('a1')).toBe(false);
      expect(storageFiles.has('files/character_assets/char1/a1.png')).toBe(false);
    });

    it('character_asset_remove rejects assets of another character', async () => {
      const { template, assetStore } = makeTemplate({ characters: [makeCharacter(), makeCharacter({ id: 'char2', name: 'Other' })] });
      assetStore.set('a1', { id: 'a1', characterId: 'char2', name: 'cover', ext: 'png', type: 'image', filePath: null, meta: {} });

      const res = await template.execute('character_asset_remove', { characterId: 'char1', assetId: 'a1' });
      expect(res.content).toBe('Error: asset "a1" not found on character "char1"');
      expect(assetStore.has('a1')).toBe(true);
    });

    it('character_asset_copy duplicates one asset onto the target card', async () => {
      const { template, bus, assetStore, storageFiles } = makeTemplate({
        characters: [makeCharacter(), makeCharacter({ id: 'char2', name: 'Source' })],
      });
      assetStore.set('a1', {
        id: 'a1',
        characterId: 'char2',
        name: 'bgm',
        ext: 'mp3',
        type: 'other',
        filePath: 'files/character_assets/char2/a1.mp3',
        meta: { origin: 'risu-module', moduleId: 'm1', risuName: 'bgm' },
      });
      storageFiles.set('files/character_assets/char2/a1.mp3', Buffer.from('ID3'));

      const res = await template.execute('character_asset_copy', { characterId: 'char1', sourceCharacterId: 'char2', assetId: 'a1' });
      const parsed = JSON.parse(res.content as string) as { id: string; name: string; ext: string; origin: string; assetUrl: string };
      expect(parsed.id).not.toBe('a1');
      expect(parsed.name).toBe('bgm');
      expect(parsed.ext).toBe('mp3');
      expect(parsed.origin).toBe('risu-module');
      expect(parsed.assetUrl).toBe(`/api/characters/char1/assets/${parsed.id}.mp3`);

      // The target owns its own copy: new record on char1, new file with the same bytes, source untouched.
      const copy = assetStore.get(parsed.id);
      expect(copy?.['characterId']).toBe('char1');
      expect((copy?.['meta'] as Record<string, unknown>)['moduleId']).toBe('m1');
      expect(storageFiles.get(`files/character_assets/char1/${parsed.id}.mp3`)).toEqual(Buffer.from('ID3'));
      expect(assetStore.get('a1')?.['characterId']).toBe('char2');
      expect(broadcastTypes(bus)).toEqual(['character.updated', 'character.snapshot', 'character.listed']);
    });

    it('character_asset_copy rejects self-copies, unknown characters, and foreign assets', async () => {
      const { template, assetStore } = makeTemplate({
        characters: [makeCharacter(), makeCharacter({ id: 'char2', name: 'Source' })],
      });
      assetStore.set('a1', { id: 'a1', characterId: 'char1', name: 'x', ext: 'png', type: 'image', filePath: null, meta: {} });

      const self = await template.execute('character_asset_copy', { characterId: 'char1', sourceCharacterId: 'char1', assetId: 'a1' });
      expect(self.content).toBe('Error: source and target character are the same');

      const noTarget = await template.execute('character_asset_copy', { characterId: 'nope', sourceCharacterId: 'char2', assetId: 'a1' });
      expect(noTarget.content).toBe('Error: character "nope" not found');

      // a1 belongs to char1, not to the stated source char2.
      const foreign = await template.execute('character_asset_copy', { characterId: 'char2', sourceCharacterId: 'char1', assetId: 'nope' });
      expect(foreign.content).toBe('Error: asset "nope" not found on character "char1"');
    });

    it('character_assets_copy copies every asset and reports skips', async () => {
      const { template, assetStore, storageFiles } = makeTemplate({
        characters: [makeCharacter(), makeCharacter({ id: 'char2', name: 'Source' })],
      });
      assetStore.set('a1', { id: 'a1', characterId: 'char2', name: 'one', ext: 'png', type: 'image', filePath: 'files/character_assets/char2/a1.png', meta: {} });
      assetStore.set('a2', { id: 'a2', characterId: 'char2', name: 'two', ext: 'png', type: 'image', filePath: null, meta: {} });
      storageFiles.set('files/character_assets/char2/a1.png', TINY_PNG);

      const res = await template.execute('character_assets_copy', { characterId: 'char1', sourceCharacterId: 'char2' });
      const parsed = JSON.parse(res.content as string) as { copied: number; skipped: number; assets: Array<{ id: string; name: string }> };
      expect(parsed.copied).toBe(1);
      expect(parsed.skipped).toBe(1);
      expect(parsed.assets).toHaveLength(1);
      expect(parsed.assets[0]?.name).toBe('one');
      const targetAssets = [...assetStore.values()].filter((a) => a['characterId'] === 'char1');
      expect(targetAssets).toHaveLength(1);
    });

    it('character_assets_copy errors when the source has no assets', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter(), makeCharacter({ id: 'char2', name: 'Source' })] });
      const res = await template.execute('character_assets_copy', { characterId: 'char1', sourceCharacterId: 'char2' });
      expect(res.content).toBe('Error: character "char2" has no assets to copy');
    });

    it('risu_module_assets_copy copies only the assets tagged with the module id', async () => {
      const moduleMeta = { id: 'm1', name: 'Music Pack', filePath: 'files/character_modules/char2/m1.json' };
      const source = makeCharacter({ id: 'char2', name: 'Source', extensions: { risuModules: [moduleMeta] } });
      const { template, assetStore, storageFiles } = makeTemplate({ characters: [makeCharacter(), source] });
      assetStore.set('a1', { id: 'a1', characterId: 'char2', name: 'bgm', ext: 'mp3', type: 'other', filePath: 'files/character_assets/char2/a1.mp3', meta: { origin: 'risu-module', moduleId: 'm1' } });
      assetStore.set('a2', { id: 'a2', characterId: 'char2', name: 'other-mod', ext: 'mp3', type: 'other', filePath: 'files/character_assets/char2/a2.mp3', meta: { origin: 'risu-module', moduleId: 'm2' } });
      assetStore.set('a3', { id: 'a3', characterId: 'char2', name: 'card', ext: 'png', type: 'image', filePath: 'files/character_assets/char2/a3.png', meta: {} });
      storageFiles.set('files/character_assets/char2/a1.mp3', Buffer.from('ID3'));

      const res = await template.execute('risu_module_assets_copy', { characterId: 'char1', sourceCharacterId: 'char2', moduleId: 'm1' });
      const parsed = JSON.parse(res.content as string) as { copied: number; assets: Array<{ name: string }> };
      expect(parsed.copied).toBe(1);
      expect(parsed.assets.map((a) => a.name)).toEqual(['bgm']);
    });

    it('risu_module_assets_copy explains when the module has no separately-stored assets', async () => {
      const moduleMeta = { id: 'm1', name: 'Embedded Mod', filePath: 'files/character_modules/char2/m1.json' };
      const source = makeCharacter({ id: 'char2', name: 'Source', extensions: { risuModules: [moduleMeta] } });
      const { template, assetStore } = makeTemplate({ characters: [makeCharacter(), source] });
      assetStore.set('a3', { id: 'a3', characterId: 'char2', name: 'card', ext: 'png', type: 'image', filePath: null, meta: {} });

      const res = await template.execute('risu_module_assets_copy', { characterId: 'char1', sourceCharacterId: 'char2', moduleId: 'm1' });
      expect(res.content).toContain('no separately-stored assets for module "Embedded Mod"');
      expect(res.content).toContain('character_assets_copy');
    });

    it('risu_module_assets_copy errors for an unknown module', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter(), makeCharacter({ id: 'char2', name: 'Source' })] });
      const res = await template.execute('risu_module_assets_copy', { characterId: 'char1', sourceCharacterId: 'char2', moduleId: 'nope' });
      expect(res.content).toBe('Error: risu module "nope" not found on character "char2"');
    });
  });

  describe('risu_module tools', () => {
    const sampleRisuModule: RisuModuleData = {
      name: 'Port Me',
      description: 'A module to port',
      namespace: 'portme',
      customModuleToggle: '=portme=group',
      lowLevelAccess: true,
      lorebook: [{ key: 'reimu', content: 'Shrine maiden.' }],
      regex: [{ comment: 'typo', in: 'teh', out: 'the', type: 'edittrans' }],
      trigger: [
        { comment: '', type: 'start', conditions: [], effect: [{ type: 'triggerlua', code: 'print("backend")' }] },
        { comment: 'Toggle', type: 'manual', conditions: [], effect: [{ type: 'v2SetVar', indent: 0 }] },
      ],
      assets: [['song', '', 'mp3']],
    };

    /** Seed a raw module through the template's own storage and attach its meta to the character. */
    function seedModule(storageFiles: Map<string, Buffer>, charStore: Map<string, Character>, characterId: string) {
      const storage = {
        write: (sub: string, name: string, data: Uint8Array) => {
          const p = `files/${sub}/${name}`;
          storageFiles.set(p, Buffer.from(data));
          return p;
        },
      };
      const meta = storeRisuModule(storage as never, characterId, sampleRisuModule, 'embedded');
      const existing = charStore.get(characterId)!;
      charStore.set(characterId, {
        ...existing,
        extensions: { [CHARACTER_RISU_MODULES_EXTENSION_KEY]: [meta] },
      });
      return meta;
    }

    it('risu_module_list returns module metadata', async () => {
      const { template, storageFiles, charStore } = makeTemplate({ characters: [makeCharacter()] });
      seedModule(storageFiles, charStore, 'char1');

      const res = await template.execute('risu_module_list', { characterId: 'char1' });
      const parsed = JSON.parse(res.content as string);
      expect(parsed.total).toBe(1);
      expect(parsed.modules[0]).toMatchObject({
        name: 'Port Me',
        namespace: 'portme',
        source: 'embedded',
        hasLua: true,
        lowLevelAccess: true,
        counts: { triggers: 2, regex: 1, lorebook: 1, assets: 1 },
      });
    });

    it('risu_module_list errors for an unknown character', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('risu_module_list', { characterId: 'nope' });
      expect(res.content).toBe('Error: character "nope" not found');
    });

    it('risu_module_get returns each section', async () => {
      const { template, storageFiles, charStore } = makeTemplate({ characters: [makeCharacter()] });
      const meta = seedModule(storageFiles, charStore, 'char1');
      const moduleId = meta.id;

      const info = JSON.parse((await template.execute('risu_module_get', { characterId: 'char1', moduleId, section: 'info' })).content as string);
      expect(info).toMatchObject({ name: 'Port Me', namespace: 'portme', customModuleToggle: '=portme=group', lowLevelAccess: true });

      const triggers = JSON.parse((await template.execute('risu_module_get', { characterId: 'char1', moduleId, section: 'triggers' })).content as string);
      expect(triggers).toHaveLength(2);
      expect(triggers[0]).toMatchObject({ index: 0, type: 'start', hasLua: true });
      expect(triggers[1]).toMatchObject({ index: 1, type: 'manual', comment: 'Toggle', hasLua: false });

      const trigger = JSON.parse((await template.execute('risu_module_get', { characterId: 'char1', moduleId, section: 'trigger', index: 0 })).content as string);
      expect(trigger.effect[0].code).toBe('print("backend")');

      const regex = JSON.parse((await template.execute('risu_module_get', { characterId: 'char1', moduleId, section: 'regex' })).content as string);
      expect(regex).toEqual([{ comment: 'typo', in: 'teh', out: 'the', type: 'edittrans' }]);

      const lorebook = JSON.parse((await template.execute('risu_module_get', { characterId: 'char1', moduleId, section: 'lorebook' })).content as string);
      expect(lorebook).toEqual([{ key: 'reimu', content: 'Shrine maiden.' }]);

      const assets = JSON.parse((await template.execute('risu_module_get', { characterId: 'char1', moduleId, section: 'assets' })).content as string);
      expect(assets).toEqual([['song', '', 'mp3']]);
    });

    it('risu_module_get validates index and module id', async () => {
      const { template, storageFiles, charStore } = makeTemplate({ characters: [makeCharacter()] });
      const meta = seedModule(storageFiles, charStore, 'char1');

      expect((await template.execute('risu_module_get', { characterId: 'char1', moduleId: meta.id, section: 'trigger' })).content)
        .toContain('requires an index');
      expect((await template.execute('risu_module_get', { characterId: 'char1', moduleId: meta.id, section: 'trigger', index: 99 })).content)
        .toContain('out of range');
      expect((await template.execute('risu_module_get', { characterId: 'char1', moduleId: 'nope', section: 'info' })).content)
        .toContain('not found');
    });

    it('risu_module_remove deletes the module and broadcasts', async () => {
      const { template, bus, storageFiles, charStore } = makeTemplate({ characters: [makeCharacter()] });
      const meta = seedModule(storageFiles, charStore, 'char1');

      const res = await template.execute('risu_module_remove', { characterId: 'char1', moduleId: meta.id });
      expect(JSON.parse(res.content as string)).toEqual({ removed: meta.id });
      expect(charStore.get('char1')!.extensions[CHARACTER_RISU_MODULES_EXTENSION_KEY]).toEqual([]);
      expect(storageFiles.has(meta.filePath)).toBe(false);
      const types = broadcastTypes(bus);
      expect(types).toContain('character.updated');
      expect(types).toContain('character.snapshot');
      expect(types).toContain('character.listed');
    });

    it('risu_module_remove errors for an unknown module', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('risu_module_remove', { characterId: 'char1', moduleId: 'nope' });
      expect(res.content).toContain('not found');
    });
  });

  describe('backend_logic tools', () => {
    it('backend_logic_get returns disabled + empty by default', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('backend_logic_get', { characterId: 'char1' });
      expect(JSON.parse(res.content as string)).toEqual({ enabled: false, luaSource: '' });
    });

    it('backend_logic_set writes a script, keeping it disabled by default', async () => {
      const { template, charStore } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('backend_logic_set', {
        characterId: 'char1',
        luaSource: 'function generate(p, c) return "x" end',
      });
      expect(JSON.parse(res.content as string)).toEqual({
        enabled: false,
        luaSource: 'function generate(p, c) return "x" end',
      });
      const ext = charStore.get('char1')!.extensions['contextualBackend'] as Record<string, unknown>;
      expect(ext).toEqual({ enabled: false, luaSource: 'function generate(p, c) return "x" end' });
    });

    it('backend_logic_set toggles enabled and preserves the script', async () => {
      const { template, charStore, bus } = makeTemplate({ characters: [makeCharacter()] });
      await template.execute('backend_logic_set', { characterId: 'char1', luaSource: 'return 1' });
      const res = await template.execute('backend_logic_set', { characterId: 'char1', enabled: true });
      expect(JSON.parse(res.content as string)).toEqual({ enabled: true, luaSource: 'return 1' });
      const ext = charStore.get('char1')!.extensions['contextualBackend'] as Record<string, unknown>;
      expect(ext['enabled']).toBe(true);
      const types = broadcastTypes(bus);
      expect(types).toContain('character.updated');
      expect(types).toContain('character.snapshot');
    });

    it('backend_logic_set errors for an unknown character', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('backend_logic_set', { characterId: 'nope', enabled: true });
      expect(res.content).toBe('Error: character "nope" not found');
    });

    it('backend_logic_get returns a numbered line range with offset/limit', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      await template.execute('backend_logic_set', {
        characterId: 'char1',
        luaSource: '-- one\n-- two\n-- three\nfunction generate(p, c) return "x" end',
      });
      const res = await template.execute('backend_logic_get', { characterId: 'char1', offset: 2, limit: 2 });
      const out = JSON.parse(res.content as string) as { enabled: boolean; totalLines: number; offset: number; luaSource: string };
      expect(out.totalLines).toBe(4);
      expect(out.offset).toBe(2);
      expect(out.luaSource).toBe('2\t-- two\n3\t-- three');
    });

    it('backend_logic_edit replaces a unique match and validates the result', async () => {
      const { template, charStore, bus } = makeTemplate({ characters: [makeCharacter()] });
      await template.execute('backend_logic_set', {
        characterId: 'char1',
        luaSource: 'local X = 1\nfunction generate(p, c) return tostring(X) end',
      });
      const res = await template.execute('backend_logic_edit', {
        characterId: 'char1',
        oldString: 'local X = 1',
        newString: 'local X = 2',
      });
      expect(JSON.parse(res.content as string)).toEqual({ replacements: 1, lines: 2, enabled: false });
      const ext = charStore.get('char1')!.extensions['contextualBackend'] as Record<string, unknown>;
      expect(ext['luaSource']).toBe('local X = 2\nfunction generate(p, c) return tostring(X) end');
      expect(broadcastTypes(bus)).toContain('character.updated');
    });

    it('backend_logic_edit rejects a non-unique match without replaceAll', async () => {
      const { template, charStore } = makeTemplate({ characters: [makeCharacter()] });
      await template.execute('backend_logic_set', {
        characterId: 'char1',
        luaSource: 'local X = 1\nlocal Y = 1\nfunction generate(p, c) return "x" end',
      });
      const res = await template.execute('backend_logic_edit', {
        characterId: 'char1',
        oldString: '= 1',
        newString: '= 2',
      });
      expect(res.content).toContain('matches 2 locations');
      const ext = charStore.get('char1')!.extensions['contextualBackend'] as Record<string, unknown>;
      expect(ext['luaSource']).toBe('local X = 1\nlocal Y = 1\nfunction generate(p, c) return "x" end');
    });

    it('backend_logic_edit with replaceAll rewrites every occurrence', async () => {
      const { template, charStore } = makeTemplate({ characters: [makeCharacter()] });
      await template.execute('backend_logic_set', {
        characterId: 'char1',
        luaSource: 'local X = 1\nlocal Y = 1\nfunction generate(p, c) return "x" end',
      });
      const res = await template.execute('backend_logic_edit', {
        characterId: 'char1',
        oldString: '= 1',
        newString: '= 2',
        replaceAll: true,
      });
      expect(JSON.parse(res.content as string)).toEqual({ replacements: 2, lines: 3, enabled: false });
      const ext = charStore.get('char1')!.extensions['contextualBackend'] as Record<string, unknown>;
      expect(ext['luaSource']).toBe('local X = 2\nlocal Y = 2\nfunction generate(p, c) return "x" end');
    });

    it('backend_logic_edit rejects edits that break the script, without saving', async () => {
      const { template, charStore } = makeTemplate({ characters: [makeCharacter()] });
      const original = 'function generate(p, c) return "x" end';
      await template.execute('backend_logic_set', { characterId: 'char1', luaSource: original });
      const res = await template.execute('backend_logic_edit', {
        characterId: 'char1',
        oldString: '"x"',
        newString: '"x" .. (',
      });
      expect(res.content).toContain('edit rejected (NOT saved)');
      const ext = charStore.get('char1')!.extensions['contextualBackend'] as Record<string, unknown>;
      expect(ext['luaSource']).toBe(original);
    });

    it('backend_logic_edit errors when there is no stored script', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('backend_logic_edit', {
        characterId: 'char1',
        oldString: 'a',
        newString: 'b',
      });
      expect(res.content).toContain('no stored backend logic');
    });

    it('backend_logic_test dry-runs the stored script and captures state', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      await template.execute('backend_logic_set', {
        characterId: 'char1',
        luaSource: `
          function generate(prompt, ctx)
            if type(state) ~= "table" then state = { turns = 0 } end
            state.turns = state.turns + 1
            local last = prompt.messages[#prompt.messages]
            return "echo:" .. last.content .. " (turn " .. state.turns .. ")"
          end
        `,
      });
      const res = await template.execute('backend_logic_test', { characterId: 'char1', input: 'hello' });
      const outcome = JSON.parse(res.content as string) as Record<string, unknown>;
      expect(outcome['ok']).toBe(true);
      expect(outcome['text']).toBe('echo:hello (turn 1)');
      expect(JSON.parse(outcome['stateOut'] as string)).toEqual({ turns: 1 });

      // Feeding stateOut back as state continues the counter — the loop the
      // authoring agent uses to verify stateful behavior across turns.
      const res2 = await template.execute('backend_logic_test', {
        characterId: 'char1',
        input: 'again',
        state: outcome['stateOut'],
      });
      const outcome2 = JSON.parse(res2.content as string) as Record<string, unknown>;
      expect(outcome2['text']).toBe('echo:again (turn 2)');
    });

    it('backend_logic_test records delegations and answers with canned text', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('backend_logic_test', {
        characterId: 'char1',
        input: 'draw me something',
        luaSource: `
          function generate(prompt, ctx)
            local res = backends.generate(prompt):await()
            return "The writer said: " .. res.text
          end
        `,
        delegateResponse: 'CANNED',
      });
      const outcome = JSON.parse(res.content as string) as Record<string, unknown>;
      expect(outcome['ok']).toBe(true);
      expect(outcome['text']).toBe('The writer said: CANNED');
      const delegations = outcome['delegations'] as Array<{ configId: string | null; promptPreview: string }>;
      expect(delegations).toHaveLength(1);
      expect(delegations[0]!.configId).toBeNull();
      expect(delegations[0]!.promptPreview).toContain('user: draw me something');
    });

    it('backend_logic_test errors without a stored script or luaSource', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('backend_logic_test', { characterId: 'char1', input: 'hi' });
      expect(res.content).toContain('no stored backend logic');
    });

    it('backend_logic_test surfaces script errors as outcome.error', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()] });
      const res = await template.execute('backend_logic_test', {
        characterId: 'char1',
        input: 'hi',
        luaSource: 'function generate(p, c) error("kaboom") end',
      });
      const outcome = JSON.parse(res.content as string) as Record<string, unknown>;
      expect(outcome['ok']).toBe(false);
      expect(outcome['error']).toContain('kaboom');
    });
  });
});
