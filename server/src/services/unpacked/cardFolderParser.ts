/**
 * Parser for unpacked card folders (`<dataDir>/unpacked-cards/<folderName>/`).
 *
 * Reads the on-disk card format (mirroring the workbench VFS character
 * subtree — see services/cardFormat/fields.ts for the shared field tables)
 * into a plain data structure. Pure function over the filesystem: no repos,
 * no settings, no broadcasts — the UnpackedCardService does those.
 *
 * Never throws: per-file problems are collected into `errors`. A missing or
 * invalid meta.json (or a missing `name`) is the one fatal case — reported as
 * a non-empty `errors` list alongside whatever partial data could be parsed.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RegexRule, WorldInfoEntry } from '@tamari/types';
import { WorldInfoEntrySchema } from '@tamari/types';
import { formatZodIssues } from '../ToolTemplate.js';
import { parseJsonObjectBody, TEXT_FIELDS } from '../cardFormat/fields.js';
import { validateVfsPath } from '../../scripting/LuaVfs.js';
import { LuaRuntime } from '../../scripting/LuaRuntime.js';
import { validateBackendLuaSource } from '../../scripting/validateLuaSource.js';

export interface ParsedCardBackendLogic {
  /** main.lua source (the entry point; must define generate). */
  luaSource: string;
  /** VFS module map: relative path (e.g. 'lib/util.lua') → source. */
  files: Record<string, string>;
}

export interface ParsedCard {
  /** Bare slug: meta.id, or the folder name when meta.json has no id. The `unpacked/` prefix is applied later (unpackedIds.ts). */
  id: string;
  /** Empty when meta.json is missing/invalid (the fatal case). */
  name: string;
  /** camelCase card text fields (all TEXT_FIELDS keys present; '' when the file is absent). */
  textFields: Record<string, string>;
  tags: string[];
  alternateGreetings: string[];
  /** world_info entries (WorldInfoRepository shape), from lorebook/<entryId>.json. */
  lorebookEntries: WorldInfoEntry[];
  /** character.extensions.regexScripts shape, from regex/<ruleId>.json. */
  regexRules: RegexRule[];
  /** Present only when backend_logic/ exists AND main.lua load-validates. */
  backendLogic?: ParsedCardBackendLogic;
  /** Absolute path to avatar.png when present. */
  avatarFile?: string;
  /** Per-file parse problems. Non-empty for the fatal meta.json case too. */
  errors: string[];
}

const CardMetaSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  tags: z.array(z.string()).default([]),
  alternateGreetings: z.array(z.string()).default([]),
});

/**
 * regex/<ruleId>.json — keys mirror REGEX_FIELDS (cardFormat/fields.ts) with
 * the defaults getCharacterRegexRules (services/characterRegex.ts) applies.
 */
const RegexRuleFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  findRegex: z.string(),
  replaceString: z.string().default(''),
  replaceLua: z.string().optional(),
  disabled: z.boolean().default(false),
  userInput: z.boolean().default(false),
  aiOutput: z.boolean().default(false),
  prompt: z.boolean().default(true),
  display: z.boolean().default(true),
});

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDir(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

/** Sorted *.json file basenames (without extension) directly inside `dir`. */
async function listJsonFiles(dir: string): Promise<Array<{ base: string; file: string }>> {
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const out: Array<{ base: string; file: string }> = [];
  for (const name of names) {
    if (await isFile(path.join(dir, name))) out.push({ base: name.slice(0, -'.json'.length), file: name });
  }
  return out;
}

function parseLorebookEntry(base: string, content: string): { ok: true; entry: WorldInfoEntry } | { ok: false; error: string } {
  const body = parseJsonObjectBody(content);
  if (!body.ok) return { ok: false, error: body.error };
  // The file name is the entry id, same as the workbench VFS layout; an
  // explicit id in the JSON wins when present.
  const parsed = WorldInfoEntrySchema.safeParse({ id: base, ...body.value });
  if (!parsed.success) return { ok: false, error: formatZodIssues(parsed.error) };
  return { ok: true, entry: parsed.data };
}

function parseRegexRule(base: string, content: string): { ok: true; rule: RegexRule } | { ok: false; error: string } {
  const body = parseJsonObjectBody(content);
  if (!body.ok) return { ok: false, error: body.error };
  const parsed = RegexRuleFileSchema.safeParse({ id: base, ...body.value });
  if (!parsed.success) return { ok: false, error: formatZodIssues(parsed.error) };
  const r = parsed.data;
  return {
    ok: true,
    rule: {
      id: r.id,
      name: r.name,
      findRegex: r.findRegex,
      replaceString: r.replaceString,
      // Same rule as getCharacterRegexRules: keep replaceLua only when non-empty.
      ...(r.replaceLua !== undefined && r.replaceLua.length > 0 ? { replaceLua: r.replaceLua } : {}),
      disabled: r.disabled,
      userInput: r.userInput,
      aiOutput: r.aiOutput,
      prompt: r.prompt,
      display: r.display,
    },
  };
}

/** Recursively collect *.lua files under `dir` as posix-style relative paths. */
async function collectLuaFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await collectLuaFiles(path.join(dir, entry.name), rel)));
    else if (entry.isFile() && entry.name.endsWith('.lua')) out.push(rel);
  }
  return out;
}

async function parseBackendLogic(dir: string, errors: string[]): Promise<ParsedCardBackendLogic | undefined> {
  const mainPath = path.join(dir, 'main.lua');
  const luaSource = await readTextFile(mainPath);
  if (luaSource === undefined) {
    if (await isFile(mainPath)) {
      errors.push('backend_logic/main.lua: unreadable');
    } else {
      errors.push('backend_logic/main.lua: missing (required when backend_logic/ exists)');
    }
    return undefined;
  }

  const files: Record<string, string> = {};
  for (const rel of await collectLuaFiles(dir)) {
    if (rel === 'main.lua') continue;
    const key = validateVfsPath(rel);
    if (key === null || key !== rel) {
      errors.push(
        `backend_logic/${rel}: invalid module path — use slash-separated segments of [A-Za-z0-9_-] with a .lua extension (no "..", no leading "/")`,
      );
      continue;
    }
    try {
      files[key] = await fs.readFile(path.join(dir, rel), 'utf8');
    } catch (e) {
      errors.push(`backend_logic/${rel}: unreadable — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Same load-validation backend_logic_set applies (must parse, module
  // requires must resolve against the map, generate() must be defined).
  const invalid = await validateBackendLuaSource(new LuaRuntime(), luaSource, files);
  if (invalid !== null) {
    errors.push(`backend_logic/main.lua: the script fails to load: ${invalid}`);
    return undefined;
  }
  return { luaSource, files };
}

/**
 * Parse one unpacked card folder. Never throws; check `errors` (meta.json
 * missing/invalid or missing `name` is the fatal case).
 */
export async function parseCardFolder(absPath: string): Promise<ParsedCard> {
  const errors: string[] = [];
  const card: ParsedCard = {
    id: path.basename(absPath),
    name: '',
    textFields: {},
    tags: [],
    alternateGreetings: [],
    lorebookEntries: [],
    regexRules: [],
    errors,
  };

  if (!(await isDir(absPath))) {
    errors.push(`not a directory: ${absPath}`);
    return card;
  }

  // meta.json — the only required file.
  const metaContent = await readTextFile(path.join(absPath, 'meta.json'));
  if (metaContent === undefined) {
    errors.push('meta.json: missing (required — { name, id?, tags?, alternateGreetings? })');
  } else {
    const body = parseJsonObjectBody(metaContent);
    if (!body.ok) {
      errors.push(`meta.json: ${body.error}`);
    } else {
      const meta = CardMetaSchema.safeParse(body.value);
      if (!meta.success) {
        errors.push(`meta.json: ${formatZodIssues(meta.error)}`);
      } else {
        card.name = meta.data.name;
        if (meta.data.id !== undefined) card.id = meta.data.id;
        card.tags = meta.data.tags;
        card.alternateGreetings = meta.data.alternateGreetings;
      }
    }
  }

  // Text field files (missing = '').
  for (const [file, key] of TEXT_FIELDS) {
    try {
      card.textFields[key] = (await readTextFile(path.join(absPath, file))) ?? '';
    } catch (e) {
      errors.push(`${file}: unreadable — ${e instanceof Error ? e.message : String(e)}`);
      card.textFields[key] = '';
    }
  }

  // lorebook/<entryId>.json
  const lorebookDir = path.join(absPath, 'lorebook');
  if (await isDir(lorebookDir)) {
    for (const { base, file } of await listJsonFiles(lorebookDir)) {
      try {
        const parsed = parseLorebookEntry(base, await fs.readFile(path.join(lorebookDir, file), 'utf8'));
        if (parsed.ok) card.lorebookEntries.push(parsed.entry);
        else errors.push(`lorebook/${file}: ${parsed.error}`);
      } catch (e) {
        errors.push(`lorebook/${file}: unreadable — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // regex/<ruleId>.json
  const regexDir = path.join(absPath, 'regex');
  if (await isDir(regexDir)) {
    for (const { base, file } of await listJsonFiles(regexDir)) {
      try {
        const parsed = parseRegexRule(base, await fs.readFile(path.join(regexDir, file), 'utf8'));
        if (parsed.ok) card.regexRules.push(parsed.rule);
        else errors.push(`regex/${file}: ${parsed.error}`);
      } catch (e) {
        errors.push(`regex/${file}: unreadable — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // backend_logic/main.lua + modules
  const backendDir = path.join(absPath, 'backend_logic');
  if (await isDir(backendDir)) {
    card.backendLogic = await parseBackendLogic(backendDir, errors);
  }

  // avatar.png (abs path; the loader runs it through setCharacterAvatarFromBuffer)
  const avatarPath = path.join(absPath, 'avatar.png');
  if (await isFile(avatarPath)) card.avatarFile = avatarPath;

  return card;
}
