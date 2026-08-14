import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCardFolder } from './cardFolderParser.js';

const dirs: string[] = [];

/** Build a fixture card folder from a map of relative path → content. Returns the card dir. */
async function makeCardFolder(files: Record<string, string>, folderName = 'my-card'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tamari-unpacked-'));
  dirs.push(root);
  const cardDir = path.join(root, folderName);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(cardDir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return cardDir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('parseCardFolder', () => {
  it('parses a full card folder (all sections)', async () => {
    const dir = await makeCardFolder({
      'meta.json': JSON.stringify({
        id: 'hero',
        name: 'Hero',
        tags: ['fantasy', 'adventure'],
        alternateGreetings: ['Hi again', 'Back so soon?'],
      }),
      description: 'A brave hero.',
      first_mes: 'Hello, traveler!',
      system_prompt: 'Be heroic.',
      'lorebook/town.json': JSON.stringify({ keys: ['town'], content: 'The town of Tamari.', comment: 'Town info', order: 5 }),
      'regex/emote.json': JSON.stringify({ name: 'Emote', findRegex: '\\*\\*', replaceString: '*', userInput: true }),
      'backend_logic/main.lua': 'function generate(prompt, ctx) return "ok" end',
      'backend_logic/lib/util.lua': 'local M = {}\nreturn M',
      'avatar.png': 'fake-png-bytes',
    });

    const card = await parseCardFolder(dir);

    expect(card.errors).toEqual([]);
    expect(card.id).toBe('hero');
    expect(card.name).toBe('Hero');
    expect(card.tags).toEqual(['fantasy', 'adventure']);
    expect(card.alternateGreetings).toEqual(['Hi again', 'Back so soon?']);
    expect(card.textFields['description']).toBe('A brave hero.');
    expect(card.textFields['firstMes']).toBe('Hello, traveler!');
    expect(card.textFields['systemPrompt']).toBe('Be heroic.');
    expect(card.textFields['personality']).toBe(''); // absent file → ''

    expect(card.lorebookEntries).toHaveLength(1);
    const entry = card.lorebookEntries[0]!;
    expect(entry.id).toBe('town'); // id from file name
    expect(entry.keys).toEqual(['town']);
    expect(entry.content).toBe('The town of Tamari.');
    expect(entry.comment).toBe('Town info');
    expect(entry.order).toBe(5);
    // WorldInfoEntrySchema defaults
    expect(entry.position).toBe('before_char');
    expect(entry.probability).toBe(100);
    expect(entry.constant).toBe(false);

    expect(card.regexRules).toEqual([
      {
        id: 'emote',
        name: 'Emote',
        findRegex: '\\*\\*',
        replaceString: '*',
        disabled: false,
        userInput: true,
        aiOutput: false,
        prompt: true,
        display: true,
      },
    ]);

    expect(card.backendLogic?.luaSource).toContain('function generate');
    expect(card.backendLogic?.files).toEqual({ 'lib/util.lua': 'local M = {}\nreturn M' });
    expect(card.avatarFile).toBe(path.join(dir, 'avatar.png'));
  });

  it('handles a folder with only meta.json (all optional sections absent)', async () => {
    const dir = await makeCardFolder({ 'meta.json': JSON.stringify({ name: 'Solo' }) }, 'solo-folder');

    const card = await parseCardFolder(dir);

    expect(card.errors).toEqual([]);
    expect(card.id).toBe('solo-folder'); // folder name when meta has no id
    expect(card.name).toBe('Solo');
    expect(Object.values(card.textFields)).toEqual(Array.from({ length: 9 }, () => ''));
    expect(card.tags).toEqual([]);
    expect(card.alternateGreetings).toEqual([]);
    expect(card.lorebookEntries).toEqual([]);
    expect(card.regexRules).toEqual([]);
    expect(card.backendLogic).toBeUndefined();
    expect(card.avatarFile).toBeUndefined();
  });

  it('reports invalid meta.json as fatal but keeps partial data', async () => {
    const dir = await makeCardFolder({
      'meta.json': 'not json{',
      description: 'still parsed',
    });

    const card = await parseCardFolder(dir);

    expect(card.errors.length).toBeGreaterThan(0);
    expect(card.errors[0]).toContain('meta.json');
    expect(card.name).toBe('');
    expect(card.id).toBe('my-card'); // falls back to folder name
    expect(card.textFields['description']).toBe('still parsed');
  });

  it('reports a missing name in meta.json as fatal', async () => {
    const dir = await makeCardFolder({ 'meta.json': JSON.stringify({ tags: ['x'] }) });

    const card = await parseCardFolder(dir);

    expect(card.errors.length).toBeGreaterThan(0);
    expect(card.errors[0]).toContain('name');
    expect(card.name).toBe('');
  });

  it('reports a missing meta.json as fatal', async () => {
    const dir = await makeCardFolder({ description: 'orphan' });

    const card = await parseCardFolder(dir);

    expect(card.errors.length).toBeGreaterThan(0);
    expect(card.errors[0]).toContain('meta.json');
    expect(card.textFields['description']).toBe('orphan');
  });

  it('rejects main.lua with a syntax error', async () => {
    const dir = await makeCardFolder({
      'meta.json': JSON.stringify({ name: 'Broken' }),
      'backend_logic/main.lua': 'function generate(',
    });

    const card = await parseCardFolder(dir);

    expect(card.backendLogic).toBeUndefined();
    expect(card.errors.some((e) => e.includes('backend_logic/main.lua') && e.includes('fails to load'))).toBe(true);
  });

  it('rejects main.lua that does not define generate()', async () => {
    const dir = await makeCardFolder({
      'meta.json': JSON.stringify({ name: 'NoGen' }),
      'backend_logic/main.lua': 'local x = 1',
    });

    const card = await parseCardFolder(dir);

    expect(card.backendLogic).toBeUndefined();
    expect(card.errors.some((e) => e.includes('script must define generate'))).toBe(true);
  });

  it('rejects backend_logic/ without main.lua', async () => {
    const dir = await makeCardFolder({
      'meta.json': JSON.stringify({ name: 'NoMain' }),
      'backend_logic/lib/util.lua': 'return {}',
    });

    const card = await parseCardFolder(dir);

    expect(card.backendLogic).toBeUndefined();
    expect(card.errors.some((e) => e.includes('backend_logic/main.lua') && e.includes('missing'))).toBe(true);
  });

  it('rejects module files with invalid VFS paths but keeps the valid rest', async () => {
    const dir = await makeCardFolder({
      'meta.json': JSON.stringify({ name: 'BadMod' }),
      'backend_logic/main.lua': 'function generate(prompt, ctx) return "ok" end',
      'backend_logic/bad name.lua': 'return {}',
      'backend_logic/util.lua': 'return {}',
    });

    const card = await parseCardFolder(dir);

    expect(card.errors.some((e) => e.includes('bad name.lua') && e.includes('invalid module path'))).toBe(true);
    expect(card.backendLogic?.files).toEqual({ 'util.lua': 'return {}' });
  });

  it('skips malformed lorebook entries and keeps the valid ones', async () => {
    const dir = await makeCardFolder({
      'meta.json': JSON.stringify({ name: 'Lore' }),
      'lorebook/good.json': JSON.stringify({ keys: ['a'], content: 'ok' }),
      'lorebook/bad-schema.json': JSON.stringify({ keys: 'not-an-array' }),
      'lorebook/bad-json.json': '{oops',
    });

    const card = await parseCardFolder(dir);

    expect(card.lorebookEntries).toHaveLength(1);
    expect(card.lorebookEntries[0]!.id).toBe('good');
    expect(card.errors.some((e) => e.includes('lorebook/bad-schema.json'))).toBe(true);
    expect(card.errors.some((e) => e.includes('lorebook/bad-json.json') && e.includes('invalid JSON'))).toBe(true);
  });

  it('skips malformed regex rules and keeps the valid ones', async () => {
    const dir = await makeCardFolder({
      'meta.json': JSON.stringify({ name: 'Rx' }),
      'regex/good.json': JSON.stringify({ findRegex: 'a+', replaceString: 'b', replaceLua: 'return match' }),
      'regex/bad.json': JSON.stringify({ name: 'no findRegex' }),
    });

    const card = await parseCardFolder(dir);

    expect(card.regexRules).toHaveLength(1);
    expect(card.regexRules[0]).toMatchObject({ id: 'good', findRegex: 'a+', replaceString: 'b', replaceLua: 'return match' });
    expect(card.errors.some((e) => e.includes('regex/bad.json') && e.includes('findRegex'))).toBe(true);
  });

  it('reports a non-directory path instead of throwing', async () => {
    const card = await parseCardFolder('/does/not/exist/at-all');

    expect(card.errors.length).toBeGreaterThan(0);
    expect(card.errors[0]).toContain('not a directory');
  });
});
