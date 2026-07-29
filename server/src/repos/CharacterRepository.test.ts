import { describe, it, expect } from 'vitest';
import { buildCardJson, worldInfoEntryToV3 } from './CharacterRepository.js';
import type { Character, WorldInfoEntry } from '@tamari/types';

function makeCharacter(overrides?: Partial<Character>): Character {
  return {
    id: 'test-char',
    name: 'Seraphina',
    description: 'A helpful AI assistant.',
    personality: 'Kind and patient.',
    scenario: 'You are in a digital tavern.',
    firstMes: 'Hello! How can I help you today?',
    mesExample: '<START>\n{{user}}: Hi\n{{char}}: Hello!',
    creator: 'TestCreator',
    characterVersion: '1.0',
    tags: ['ai', 'helper'],
    avatarPath: null,
    avatarThumbnailPath: null,
    creatorNotes: 'These are creator notes.',
    systemPrompt: 'You are a helpful assistant.',
    postHistoryInstructions: 'Be concise.',
    alternateGreetings: ['Greetings!', 'Salutations!'],
    groupOnlyGreetings: [],
    nickname: '',
    creatorNotesMultilingual: {},
    source: [],
    extensions: { talkativeness: 0.5 },
    createDate: '2024-01-15T10:00:00.000Z',
    worldInfoId: null,
    createdAt: 1705312800,
    updatedAt: 1705312800,
    ...overrides,
  };
}

describe('CharacterRepository', () => {
  describe('buildCardJson', () => {
    it('produces a valid Spec V3 card with all fields', () => {
      const char = makeCharacter();
      const card = buildCardJson(char);

      expect(card.spec).toBe('chara_card_v3');
      expect(card.spec_version).toBe('3.0');
      expect(card.create_date).toBe(char.createDate);

      const data = card.data as Record<string, unknown>;
      expect(data.name).toBe(char.name);
      expect(data.description).toBe(char.description);
      expect(data.personality).toBe(char.personality);
      expect(data.scenario).toBe(char.scenario);
      expect(data.first_mes).toBe(char.firstMes);
      expect(data.mes_example).toBe(char.mesExample);
      expect(data.creator).toBe(char.creator);
      expect(data.character_version).toBe(char.characterVersion);
      expect(data.tags).toEqual(char.tags);
      expect(data.creator_notes).toBe(char.creatorNotes);
      expect(data.system_prompt).toBe(char.systemPrompt);
      expect(data.post_history_instructions).toBe(char.postHistoryInstructions);
      expect(data.alternate_greetings).toEqual(char.alternateGreetings);
      expect(data.group_only_greetings).toEqual(char.groupOnlyGreetings);
      expect(data.extensions).toEqual(char.extensions);
    });

    it('produces a valid Spec V2 card when format is v2', () => {
      const char = makeCharacter();
      const card = buildCardJson(char, { format: 'v2' });

      expect(card.spec).toBe('chara_card_v2');
      expect(card.spec_version).toBe('2.0');

      const data = card.data as Record<string, unknown>;
      expect(data.name).toBe(char.name);
      expect(data.group_only_greetings).toBeUndefined();
      expect(data.nickname).toBeUndefined();
    });

    it('roundtrips empty optional fields as empty strings/arrays/objects', () => {
      const char = makeCharacter({
        description: '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creator: '',
        characterVersion: '',
        tags: [],
        creatorNotes: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        alternateGreetings: [],
        extensions: {},
        createDate: '',
        worldInfoId: null,
      });
      const card = buildCardJson(char);

      // Empty create_date is omitted from top level
      expect(card.create_date).toBeUndefined();
      const data = card.data as Record<string, unknown>;
      expect(data.description).toBe('');
      expect(data.tags).toEqual([]);
      expect(data.alternate_greetings).toEqual([]);
      expect(data.extensions).toEqual({});
    });

    it('serializes to JSON without data loss', () => {
      const char = makeCharacter();
      const card = buildCardJson(char);
      const json = JSON.stringify(card);
      const parsed = JSON.parse(json);

      expect(parsed.spec).toBe('chara_card_v3');
      expect(parsed.data.name).toBe(char.name);
      expect(parsed.data.alternate_greetings).toEqual(char.alternateGreetings);
      expect(parsed.data.group_only_greetings).toEqual(char.groupOnlyGreetings);
      expect(parsed.data.extensions).toEqual(char.extensions);
    });

    it('includes character_book when provided', () => {
      const char = makeCharacter();
      const entries: WorldInfoEntry[] = [
        {
          id: '0',
          keys: ['magic'],
          content: 'Magic is real in this world.',
          comment: 'World building',
          order: 10,
          position: 'before_char',
          probability: 100,
          constant: true,
          selective: false,
          secondaryKeys: [],
          addMemo: false,
          disable: false,
          regex: false,
          recursive: false,
        },
        {
          id: '1',
          keys: ['forest'],
          content: 'The forest is dark and dangerous.',
          comment: '',
          order: 20,
          position: 'after_char',
          probability: 80,
          constant: false,
          selective: true,
          secondaryKeys: ['elf'],
          addMemo: false,
          disable: false,
          regex: true,
          recursive: false,
        },
      ];

      const card = buildCardJson(char, { characterBook: { name: 'Touhou Book', entries } });
      const data = card.data as Record<string, unknown>;
      const book = data.character_book as Record<string, unknown>;

      expect(book).toBeDefined();
      expect(book.name).toBe('Touhou Book');
      expect(Array.isArray(book.entries)).toBe(true);
      expect((book.entries as unknown[]).length).toBe(2);

      const first = (book.entries as unknown[])[0] as Record<string, unknown>;
      expect(first.keys).toEqual(['magic']);
      expect(first.content).toBe('Magic is real in this world.');
      expect(first.enabled).toBe(true);
      expect(first.insertion_order).toBe(10);
      expect(first.constant).toBe(true);
      expect(first.position).toBe('before_char');
    });

    it('omits character_book for v2 format even when provided', () => {
      const char = makeCharacter();
      const entries: WorldInfoEntry[] = [
        {
          id: '0',
          keys: ['magic'],
          content: 'Magic is real.',
          comment: '',
          order: 10,
          position: 'before_char',
          probability: 100,
          constant: true,
          selective: false,
          secondaryKeys: [],
          addMemo: false,
          disable: false,
          regex: false,
          recursive: false,
        },
      ];

      const card = buildCardJson(char, { format: 'v2', characterBook: { entries } });
      const data = card.data as Record<string, unknown>;
      expect(data.character_book).toBeUndefined();
    });

    it('round-trips atDepth entries with depth and role', () => {
      const char = makeCharacter();
      const entries: WorldInfoEntry[] = [
        {
          id: '0',
          keys: ['deep'],
          content: 'Deep lore.',
          comment: '',
          order: 5,
          position: 'atDepth',
          depth: 3,
          role: 'user',
          probability: 100,
          constant: false,
          selective: false,
          secondaryKeys: [],
          addMemo: false,
          disable: false,
          regex: false,
          recursive: false,
        },
      ];

      const card = buildCardJson(char, { characterBook: { entries } });
      const data = card.data as Record<string, unknown>;
      const book = data.character_book as Record<string, unknown>;
      const first = (book.entries as unknown[])[0] as Record<string, unknown>;

      expect(first.depth).toBe(3);
      expect(first.role).toBe('user');
      expect(first.position).toBe('atDepth');
    });
  });

  describe('worldInfoEntryToV3', () => {
    it('maps disable to enabled inverse', () => {
      const entry: WorldInfoEntry = {
        id: '0',
        keys: ['test'],
        content: 'Test content',
        comment: '',
        order: 10,
        position: 'before_char',
        probability: 100,
        constant: false,
        selective: false,
        secondaryKeys: [],
        addMemo: false,
        disable: true,
        regex: false,
        recursive: false,
      };
      const v3 = worldInfoEntryToV3(entry);
      expect(v3.enabled).toBe(false);
    });

    it('maps atDepth fields', () => {
      const entry: WorldInfoEntry = {
        id: '0',
        keys: ['test'],
        content: 'Test',
        comment: '',
        order: 10,
        position: 'atDepth',
        depth: 2,
        role: 'assistant',
        probability: 100,
        constant: false,
        selective: false,
        secondaryKeys: [],
        addMemo: false,
        disable: false,
        regex: false,
        recursive: false,
      };
      const v3 = worldInfoEntryToV3(entry);
      expect(v3.depth).toBe(2);
      expect(v3.role).toBe('assistant');
    });
  });
});
