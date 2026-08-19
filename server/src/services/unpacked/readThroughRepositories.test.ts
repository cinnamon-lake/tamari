/**
 * Read-through repository wrapper tests — real inner repos over a tmp SQLite
 * DB, with a stub UnpackedCardRegistry standing in for UnpackedCardService.
 * (Service + wrapper integration is covered in UnpackedCardService.test.ts.)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldInfoEntry } from '@tamari/types';
import { CharacterRepository } from '../../repos/CharacterRepository.js';
import { WorldInfoRepository } from '../../repos/WorldInfoRepository.js';
import { ReadThroughCharacterRepository } from './ReadThroughCharacterRepository.js';
import { ReadThroughWorldInfoRepository } from './ReadThroughWorldInfoRepository.js';
import type { ParsedCard } from './cardFolderParser.js';
import type { UnpackedCardEntry, UnpackedCardRegistry } from './UnpackedCardService.js';
import { unpackedWorldInfoId } from './unpackedIds.js';

let client: Client;
let tmpDir: string;
let innerCharacters: CharacterRepository;
let innerWorldInfo: WorldInfoRepository;
let registry: StubRegistry;
let characters: ReadThroughCharacterRepository;
let worldInfo: ReadThroughWorldInfoRepository;

class StubRegistry implements UnpackedCardRegistry {
  entries = new Map<string, UnpackedCardEntry>();
  async get(cardId: string): Promise<UnpackedCardEntry | undefined> {
    return this.entries.get(cardId);
  }
  has(cardId: string): boolean {
    return this.entries.has(cardId);
  }
  list(): string[] {
    return [...this.entries.keys()];
  }
  dirOf(cardId: string): string | undefined {
    return this.entries.get(cardId)?.dir;
  }
}

function makeParsed(overrides: Partial<ParsedCard> = {}): ParsedCard {
  return {
    id: 'disk-card',
    name: 'Disk Card',
    textFields: {
      description: 'disk description',
      personality: 'disk personality',
      scenario: '',
      firstMes: 'hello from disk',
      mesExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      creatorNotes: '',
      nickname: '',
    },
    tags: ['disk-tag'],
    alternateGreetings: ['alt greeting'],
    lorebookEntries: [],
    regexRules: [],
    errors: [],
    ...overrides,
  };
}

function makeLoreEntry(overrides: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  return {
    id: 'e1',
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
    ...overrides,
  };
}

function registerCard(parsed: ParsedCard, dir = '/data/unpacked-cards/disk-card'): void {
  registry.entries.set(`unpacked/${parsed.id}`, { parsed, dir });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-readthrough-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  // Mirror db/migrations/001_init.sql.
  await client.execute(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      personality TEXT,
      scenario TEXT,
      first_mes TEXT,
      mes_example TEXT,
      creator TEXT,
      character_version TEXT,
      tags TEXT DEFAULT '[]',
      avatar_path TEXT,
      avatar_thumbnail_path TEXT,
      creator_notes TEXT DEFAULT '',
      system_prompt TEXT DEFAULT '',
      post_history_instructions TEXT DEFAULT '',
      alternate_greetings TEXT DEFAULT '[]',
      group_only_greetings TEXT DEFAULT '[]',
      nickname TEXT DEFAULT '',
      creator_notes_multilingual TEXT DEFAULT '{}',
      source TEXT DEFAULT '[]',
      extensions TEXT DEFAULT '{}',
      create_date TEXT DEFAULT '',
      world_info_id TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await client.execute(`
    CREATE TABLE world_info (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      entries TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
  innerCharacters = new CharacterRepository(client);
  innerWorldInfo = new WorldInfoRepository(client);
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM characters');
  await client.execute('DELETE FROM world_info');
  registry = new StubRegistry();
  characters = new ReadThroughCharacterRepository(innerCharacters, registry);
  worldInfo = new ReadThroughWorldInfoRepository(innerWorldInfo, registry);
});

describe('ReadThroughCharacterRepository reads', () => {
  it('overlays parsed folder content onto the handle row', async () => {
    await innerCharacters.create('unpacked/disk-card', { name: 'Disk Card' });
    registerCard(
      makeParsed({
        regexRules: [{ id: 'r1', name: '', findRegex: 'a', replaceString: 'b', disabled: false, userInput: false, aiOutput: false, prompt: true, display: true }],
        backendLogic: { luaSource: 'function generate() end', files: {} },
        errors: ['lorebook/bad.json: invalid JSON'],
      }),
    );

    const card = await characters.getById('unpacked/disk-card');
    expect(card).toBeDefined();
    expect(card?.name).toBe('Disk Card');
    expect(card?.description).toBe('disk description');
    expect(card?.firstMes).toBe('hello from disk');
    expect(card?.tags).toEqual(['disk-tag']);
    expect(card?.alternateGreetings).toEqual(['alt greeting']);
    expect(card?.worldInfoId).toBe('unpacked/disk-card:book');
    expect(card?.external).toBe(true);
    expect(card?.extensions['regexScripts']).toHaveLength(1);
    expect(card?.extensions['contextualBackend']).toEqual({
      enabled: true,
      luaSource: 'function generate() end',
      files: {},
    });
    expect(card?.extensions['unpackedErrors']).toEqual(['lorebook/bad.json: invalid JSON']);

    // The handle row itself stays thin — nothing was written back.
    const row = await innerCharacters.getById('unpacked/disk-card');
    expect(row?.description).toBe('');
    expect(row?.worldInfoId).toBeNull();
    expect(row?.external).toBeUndefined();
  });

  it('read-through freshness: registry changes are visible without DB writes', async () => {
    await innerCharacters.create('unpacked/disk-card', { name: 'Disk Card' });
    registerCard(makeParsed());

    expect((await characters.getById('unpacked/disk-card'))?.description).toBe('disk description');

    // "Edit the folder" == replace the parsed snapshot in the registry.
    registerCard(makeParsed({ textFields: { ...makeParsed().textFields, description: 'edited on disk' } }));
    const fresh = await characters.getById('unpacked/disk-card');
    expect(fresh?.description).toBe('edited on disk');

    const row = await innerCharacters.getById('unpacked/disk-card');
    expect(row?.description).toBe('');
  });

  it('passes unknown unpacked ids (orphan rows) through unchanged', async () => {
    await innerCharacters.create('unpacked/ghost', { name: 'Ghost', description: 'db content' });
    const card = await characters.getById('unpacked/ghost');
    expect(card?.description).toBe('db content');
    expect(card?.external).toBeUndefined();
    expect(card?.worldInfoId).toBeNull();
  });

  it('passes non-unpacked characters through untouched', async () => {
    await innerCharacters.create('regular-1', { name: 'Regular', description: 'normal card', tags: ['x'] });
    const card = await characters.getById('regular-1');
    expect(card?.description).toBe('normal card');
    expect(card?.external).toBeUndefined();
  });

  it('overlays getByIds, getByName, list and listSummaries', async () => {
    await innerCharacters.create('unpacked/disk-card', { name: 'Old Name' });
    await innerCharacters.create('regular-1', { name: 'Regular' });
    registerCard(makeParsed({ name: 'Disk Card Renamed' }));

    const byIds = await characters.getByIds(['unpacked/disk-card', 'regular-1']);
    expect(byIds.find((c) => c.id === 'unpacked/disk-card')?.description).toBe('disk description');
    expect(byIds.find((c) => c.id === 'regular-1')?.description).toBe('');

    // The service keeps handle-row names in sync; here the row predates the rename.
    const byName = await characters.getByName('Old Name');
    expect(byName?.name).toBe('Disk Card Renamed');

    const list = await characters.list();
    expect(list.total).toBe(2);
    expect(list.items.find((c) => c.id === 'unpacked/disk-card')?.external).toBe(true);

    const summaries = await characters.listSummaries();
    const summary = summaries.items.find((s) => s.id === 'unpacked/disk-card');
    expect(summary?.name).toBe('Disk Card Renamed');
    expect(summary?.tags).toEqual(['disk-tag']);
    expect(summary?.external).toBe(true);
    expect(summaries.items.find((s) => s.id === 'regular-1')?.external).toBeUndefined();
  });
});

describe('ReadThroughCharacterRepository writes', () => {
  it('rejects create with the reserved prefix', async () => {
    await expect(characters.create('unpacked/new', { name: 'Nope' })).rejects.toThrow(/reserved 'unpacked\/' prefix/);
    expect(await innerCharacters.getById('unpacked/new')).toBeUndefined();
  });

  it('allows create for normal ids', async () => {
    const created = await characters.create('regular-1', { name: 'Regular' });
    expect(created.name).toBe('Regular');
  });

  it('rejects update/delete of a known unpacked card, pointing at the folder', async () => {
    await innerCharacters.create('unpacked/disk-card', { name: 'Disk Card' });
    registerCard(makeParsed());

    await expect(characters.update('unpacked/disk-card', { name: 'X' })).rejects.toThrow(
      /Card is unpacked \(on-disk\); edit the folder instead: \/data\/unpacked-cards\/disk-card/,
    );
    await expect(characters.delete('unpacked/disk-card')).rejects.toThrow(/Card is unpacked \(on-disk\)/);
    expect(await innerCharacters.getById('unpacked/disk-card')).toBeDefined();
  });

  it('lets orphan unpacked rows through (folder gone or feature disabled)', async () => {
    await innerCharacters.create('unpacked/ghost', { name: 'Ghost' });
    const updated = await characters.update('unpacked/ghost', { name: 'Ghost v2' });
    expect(updated.name).toBe('Ghost v2');
    await characters.delete('unpacked/ghost');
    expect(await innerCharacters.getById('unpacked/ghost')).toBeUndefined();
  });

  it('passes update/delete of normal ids through', async () => {
    await innerCharacters.create('regular-1', { name: 'Regular' });
    const updated = await characters.update('regular-1', { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    await characters.delete('regular-1');
    expect(await innerCharacters.getById('regular-1')).toBeUndefined();
  });
});

describe('ReadThroughWorldInfoRepository', () => {
  it('serves the virtual book from the parsed lorebook entries', async () => {
    registerCard(makeParsed({ lorebookEntries: [makeLoreEntry()] }));
    const book = await worldInfo.getById(unpackedWorldInfoId('unpacked/disk-card'));
    expect(book).toBeDefined();
    expect(book?.id).toBe('unpacked/disk-card:book');
    expect(book?.entries).toHaveLength(1);
    expect(book?.entries[0]?.content).toBe('Dragons are real');

    // Freshness: a registry change is a disk edit.
    registerCard(makeParsed({ lorebookEntries: [makeLoreEntry({ content: 'Edited on disk' })] }));
    expect((await worldInfo.getById('unpacked/disk-card:book'))?.entries[0]?.content).toBe('Edited on disk');
  });

  it('falls through to inner for unknown unpacked book ids', async () => {
    expect(await worldInfo.getById('unpacked/ghost:book')).toBeUndefined();
  });

  it('delegates non-unpacked reads and lists to inner', async () => {
    await innerWorldInfo.create('book-1', { name: 'Book', entries: [makeLoreEntry()] });
    expect((await worldInfo.getById('book-1'))?.name).toBe('Book');
    expect(await worldInfo.list()).toHaveLength(1);
  });

  it('rejects writes to unpacked book ids', async () => {
    registerCard(makeParsed());
    await expect(worldInfo.create('unpacked/disk-card:book', { name: 'X', entries: [] })).rejects.toThrow(
      /Lorebook is unpacked \(on-disk\)/,
    );
    await expect(worldInfo.update('unpacked/disk-card:book', { name: 'X' })).rejects.toThrow(
      /Lorebook is unpacked \(on-disk\)/,
    );
    await expect(worldInfo.delete('unpacked/disk-card:book')).rejects.toThrow(/Lorebook is unpacked \(on-disk\)/);
  });

  it('passes writes through for orphan unpacked book ids (card not loaded)', async () => {
    await innerWorldInfo.create('unpacked/ghost:book', { name: 'Orphan', entries: [] });
    const updated = await worldInfo.update('unpacked/ghost:book', { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    await worldInfo.delete('unpacked/ghost:book');
    expect(await innerWorldInfo.getById('unpacked/ghost:book')).toBeUndefined();
  });

  it('passes writes for normal books through', async () => {
    await innerWorldInfo.create('book-1', { name: 'Book', entries: [] });
    const updated = await worldInfo.update('book-1', { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    await worldInfo.delete('book-1');
    expect(await innerWorldInfo.getById('book-1')).toBeUndefined();
  });
});
