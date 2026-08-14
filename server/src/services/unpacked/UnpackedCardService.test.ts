/**
 * UnpackedCardService tests — real inner repos over a tmp SQLite DB, real
 * FileStorage/EventBus over a tmp data dir, stub settings + avatar pipeline.
 * The fs watcher is disabled (`watch: false`); scans are driven directly.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings, Character } from '@tamari/types';
import { CharacterRepository } from '../../repos/CharacterRepository.js';
import { CharacterAssetRepository } from '../../repos/CharacterAssetRepository.js';
import { QuickReplyRepository } from '../../repos/QuickReplyRepository.js';
import type { ISettingsRepository } from '../../repos/SettingsRepository.js';
import { EventBus } from '../../bus/EventBus.js';
import { FileStorage } from '../FileStorage.js';
import { UnpackedCardService, UNPACKED_CARDS_DIRNAME } from './UnpackedCardService.js';
import { ReadThroughCharacterRepository } from './ReadThroughCharacterRepository.js';

/** Smallest valid PNG (1x1). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let tmpDir: string;
let dataDir: string;
let cardsRoot: string;
let client: Client;
let innerCharacters: CharacterRepository;
let bus: EventBus;
let broadcast: MockInstance<EventBus['broadcast']>;
let setAvatar: Mock<(character: Character, buffer: Buffer) => Promise<unknown>>;
let service: UnpackedCardService;
let enabled: boolean;

function makeSettings(): ISettingsRepository {
  return {
    getTyped: async () => ({ 'unpackedCards.enabled': enabled }) as unknown as AppSettings,
  } as unknown as ISettingsRepository;
}

async function writeCardFolder(folder: string, files: Record<string, string | Buffer>): Promise<string> {
  const dir = join(cardsRoot, folder);
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    mkdirSync(join(filePath, '..'), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return dir;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-unpacked-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  // Mirror db/migrations/001_init.sql (only the tables the service touches).
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
    CREATE TABLE character_assets (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'other',
      ext TEXT NOT NULL DEFAULT 'png',
      file_path TEXT,
      meta TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await client.execute(`
    CREATE TABLE quick_replies (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('global', 'character', 'chat')),
      scope_id TEXT NOT NULL,
      label TEXT NOT NULL,
      icon TEXT DEFAULT '',
      color TEXT DEFAULT '',
      script TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'lua',
      auto_execute INTEGER DEFAULT 0,
      order_index INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await client.execute('PRAGMA foreign_keys = ON');
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute('DELETE FROM characters');
  await client.execute('DELETE FROM character_assets');
  await client.execute('DELETE FROM quick_replies');
  dataDir = join(tmpDir, `data-${crypto.randomUUID()}`);
  cardsRoot = join(dataDir, UNPACKED_CARDS_DIRNAME);
  mkdirSync(cardsRoot, { recursive: true });
  innerCharacters = new CharacterRepository(client);
  bus = new EventBus();
  broadcast = vi.spyOn(bus, 'broadcast');
  setAvatar = vi.fn<(character: Character, buffer: Buffer) => Promise<unknown>>().mockResolvedValue(undefined);
  enabled = true;
  service = new UnpackedCardService({
    characters: innerCharacters,
    characterAssets: new CharacterAssetRepository(client),
    quickReplies: new QuickReplyRepository(client),
    storage: new FileStorage(dataDir),
    bus,
    settings: makeSettings(),
    dataDir,
    setAvatar,
    watch: false,
  });
});

function broadcastsOf(type: string): Array<Record<string, unknown>> {
  return broadcast.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((msg) => msg['type'] === type);
}

describe('settings gate', () => {
  it('does nothing when unpackedCards.enabled is false', async () => {
    enabled = false;
    await writeCardFolder('alice', { 'meta.json': JSON.stringify({ name: 'Alice' }) });
    await service.start();
    expect(await innerCharacters.list()).toEqual({ items: [], total: 0 });
    expect(service.list()).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('scan', () => {
  it('creates thin handle rows for valid folders on start', async () => {
    await writeCardFolder('alice', {
      'meta.json': JSON.stringify({ name: 'Alice', tags: ['a'] }),
      description: 'alice from disk',
    });
    await service.start();

    const row = await innerCharacters.getById('unpacked/alice');
    expect(row?.name).toBe('Alice');
    expect(row?.description).toBe('');
    expect(service.has('unpacked/alice')).toBe(true);
    expect(broadcastsOf('character.listed').length).toBeGreaterThan(0);
    expect(broadcastsOf('character.snapshot').length).toBeGreaterThan(0);
  });

  it('read-through wrapper serves disk content over the handle row', async () => {
    const dir = await writeCardFolder('alice', {
      'meta.json': JSON.stringify({ name: 'Alice', tags: ['a'], alternateGreetings: ['hi again'] }),
      description: 'alice from disk',
      first_mes: 'hello',
    });
    await service.start();
    const characters = new ReadThroughCharacterRepository(innerCharacters, service);

    const card = await characters.getById('unpacked/alice');
    expect(card?.description).toBe('alice from disk');
    expect(card?.firstMes).toBe('hello');
    expect(card?.tags).toEqual(['a']);
    expect(card?.alternateGreetings).toEqual(['hi again']);
    expect(card?.external).toBe(true);
    expect(card?.worldInfoId).toBe('unpacked/alice:book');

    // Edit the folder; after a rescan the overlay reflects it with no DB writes.
    await fs.writeFile(join(dir, 'description'), 'edited on disk');
    await service.scanFolder(dir);
    expect((await characters.getById('unpacked/alice'))?.description).toBe('edited on disk');
    expect((await innerCharacters.getById('unpacked/alice'))?.description).toBe('');
  });

  it('keeps the handle-row name in sync with meta.json renames', async () => {
    const dir = await writeCardFolder('alice', { 'meta.json': JSON.stringify({ name: 'Alice' }) });
    await service.start();
    await fs.writeFile(join(dir, 'meta.json'), JSON.stringify({ name: 'Alice v2' }));
    await service.scanFolder(dir);
    expect((await innerCharacters.getById('unpacked/alice'))?.name).toBe('Alice v2');
  });

  it('skips folders with fatal parse errors (missing meta.json)', async () => {
    await writeCardFolder('broken', { description: 'no meta here' });
    await service.start();
    expect(await innerCharacters.getById('unpacked/broken')).toBeUndefined();
    expect(service.has('unpacked/broken')).toBe(false);
  });

  it('keeps the last good parse when meta.json goes invalid, exposing errors', async () => {
    const dir = await writeCardFolder('alice', {
      'meta.json': JSON.stringify({ name: 'Alice' }),
      description: 'good',
    });
    await service.start();
    await fs.writeFile(join(dir, 'meta.json'), '{ not json');
    await service.scanFolder(dir);

    const entry = service.get('unpacked/alice');
    expect(entry?.parsed.name).toBe('Alice');
    expect(entry?.parsed.errors.length).toBeGreaterThan(0);

    const characters = new ReadThroughCharacterRepository(innerCharacters, service);
    const card = await characters.getById('unpacked/alice');
    expect(card?.description).toBe('good');
    expect(card?.extensions['unpackedErrors']).toBeDefined();
  });

  it('records non-fatal parse errors in the overlay', async () => {
    await writeCardFolder('alice', {
      'meta.json': JSON.stringify({ name: 'Alice' }),
      'lorebook/bad.json': '{ nope',
    });
    await service.start();
    const characters = new ReadThroughCharacterRepository(innerCharacters, service);
    const card = await characters.getById('unpacked/alice');
    expect(card).toBeDefined();
    expect(card?.extensions['unpackedErrors']).toEqual([expect.stringContaining('lorebook/bad.json')]);
  });

  it('sweeps orphan handle rows with no live folder', async () => {
    await innerCharacters.create('unpacked/orphan', { name: 'Orphan' });
    await service.start();
    expect(await innerCharacters.getById('unpacked/orphan')).toBeUndefined();
    expect(broadcastsOf('character.deleted').length).toBeGreaterThan(0);
  });
});

describe('folder removal', () => {
  it('deletes the handle row and broadcasts', async () => {
    await writeCardFolder('alice', { 'meta.json': JSON.stringify({ name: 'Alice' }) });
    await service.start();
    expect(await innerCharacters.getById('unpacked/alice')).toBeDefined();

    rmSync(join(cardsRoot, 'alice'), { recursive: true });
    broadcast.mockClear();
    await service.scanAll();

    expect(await innerCharacters.getById('unpacked/alice')).toBeUndefined();
    expect(service.has('unpacked/alice')).toBe(false);
    const deleted = broadcastsOf('character.deleted');
    expect(deleted.some((m) => m['characterId'] === 'unpacked/alice')).toBe(true);
    expect(broadcastsOf('character.listed').length).toBeGreaterThan(0);
  });
});

describe('avatar sync', () => {
  it('runs avatar.png through the avatar pipeline once per change', async () => {
    const dir = await writeCardFolder('alice', {
      'meta.json': JSON.stringify({ name: 'Alice' }),
      'avatar.png': TINY_PNG,
    });
    await service.start();
    expect(setAvatar).toHaveBeenCalledTimes(1);
    expect(setAvatar.mock.calls[0]?.[0]?.id).toBe('unpacked/alice');
    expect(Buffer.compare(setAvatar.mock.calls[0]?.[1] as Buffer, TINY_PNG)).toBe(0);

    // Unchanged mtime → no re-sync.
    await service.scanFolder(dir);
    expect(setAvatar).toHaveBeenCalledTimes(1);

    // Changed mtime → re-sync.
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(join(dir, 'avatar.png'), future, future);
    await service.scanFolder(dir);
    expect(setAvatar).toHaveBeenCalledTimes(2);
  });

  it('skips avatar sync when the folder has no avatar.png', async () => {
    await writeCardFolder('alice', { 'meta.json': JSON.stringify({ name: 'Alice' }) });
    await service.start();
    expect(setAvatar).not.toHaveBeenCalled();
  });
});
