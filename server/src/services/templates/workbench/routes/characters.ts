/**
 * /characters/<id>/ — card-authoring domain.
 *
 * Layout: text field files (snake_case names mapping to camelCase card
 * fields), meta.json, the lorebook/ greetings/ regex/ assets/ modules/
 * sub-collections, and backend_logic.lua (the card-coupled backend script).
 * greetings/ holds the card's alternate greetings as one text file per index
 * (meta.json still exposes the whole alternateGreetings array for bulk
 * reads/replaces). The backend_logic `enabled` flag is deliberately NOT
 * exposed as a separate file: writes go to backend_logic_set, which preserves
 * the current flag when only luaSource is given; edits go to
 * backend_logic_edit, which load-validates before saving.
 *
 * JSON-blob files — meta.json, lorebook/<entryId>.json, regex/<ruleId>.json —
 * also expand into per-field files (<file>.json/<field> or meta.json/<field>):
 * string fields are read/written raw (no JSON escaping), other fields as JSON
 * values. Field writes become single-key patches of the same provider ops the
 * whole-file writes use.
 */

import { isNewSegment, stripJsonExt } from '../pathUtils.js';
import {
  asArray,
  asString,
  callProvider,
  createdResult,
  COLLECTION_REFUSAL,
  err,
  fieldEntries,
  fieldSpec,
  fileEntry,
  idOf,
  isError,
  isRecord,
  parseFieldContent,
  parseJsonBody,
  parseJsonObjectBody,
  pretty,
  readField,
  resultToString,
  type DomainRoute,
  type FieldSpec,
  type ListEntry,
  type ProviderOutcome,
  type RouteCall,
} from '../router.js';

/** [file name, camelCase card field] — the writable text fields of a card. */
const TEXT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['description', 'description'],
  ['personality', 'personality'],
  ['scenario', 'scenario'],
  ['first_mes', 'firstMes'],
  ['mes_example', 'mesExample'],
  ['system_prompt', 'systemPrompt'],
  ['post_history_instructions', 'postHistoryInstructions'],
  ['creator_notes', 'creatorNotes'],
  ['nickname', 'nickname'],
];

const SUBCOLLECTIONS = new Set(['lorebook', 'greetings', 'regex', 'assets', 'modules']);

/**
 * meta.json's writable fields, also readable/writable one at a time as
 * meta.json/<file>. Read-only keys (avatarUrl, thumbnailUrl, worldInfoId)
 * stay whole-meta.json-only.
 */
const META_FIELDS: readonly FieldSpec[] = [
  { file: 'name', key: 'name', type: 'string' },
  { file: 'tags', key: 'tags', type: 'json' },
  { file: 'alternate_greetings', key: 'alternateGreetings', type: 'json' },
];

/** Regex rule fields exposed as regex/<ruleId>.json/<file> (patch keys of regex_update). */
const REGEX_FIELDS: readonly FieldSpec[] = [
  { file: 'name', key: 'name', type: 'string' },
  { file: 'find_regex', key: 'findRegex', type: 'string' },
  { file: 'replace_string', key: 'replaceString', type: 'string' },
  { file: 'replace_lua', key: 'replaceLua', type: 'string' },
  { file: 'disabled', key: 'disabled', type: 'json' },
  { file: 'user_input', key: 'userInput', type: 'json' },
  { file: 'ai_output', key: 'aiOutput', type: 'json' },
  { file: 'prompt', key: 'prompt', type: 'json' },
  { file: 'display', key: 'display', type: 'json' },
];

/** Lorebook entry fields exposed as lorebook/<entryId>.json/<file> (patch keys of lorebook_entry_update). */
const LOREBOOK_FIELDS: readonly FieldSpec[] = [
  { file: 'keys', key: 'keys', type: 'json' },
  { file: 'content', key: 'content', type: 'string' },
  { file: 'comment', key: 'comment', type: 'string' },
  { file: 'order', key: 'order', type: 'json' },
  { file: 'position', key: 'position', type: 'json' },
  { file: 'depth', key: 'depth', type: 'json' },
  { file: 'role', key: 'role', type: 'json' },
  { file: 'probability', key: 'probability', type: 'json' },
  { file: 'constant', key: 'constant', type: 'json' },
  { file: 'selective', key: 'selective', type: 'json' },
  { file: 'secondary_keys', key: 'secondaryKeys', type: 'json' },
  { file: 'add_memo', key: 'addMemo', type: 'json' },
  { file: 'disable', key: 'disable', type: 'json' },
  { file: 'regex', key: 'regex', type: 'json' },
  { file: 'recursive', key: 'recursive', type: 'json' },
  { file: 'retrieval_mode', key: 'retrievalMode', type: 'json' },
  { file: 'sticky', key: 'sticky', type: 'json' },
  { file: 'cooldown', key: 'cooldown', type: 'json' },
  { file: 'delay', key: 'delay', type: 'json' },
];

/** Sub-collections whose <id>.json entries expand into per-field files. */
const FIELD_FILE_SPECS: Record<string, readonly FieldSpec[]> = {
  lorebook: LOREBOOK_FIELDS,
  regex: REGEX_FIELDS,
};

/** Risu module sections addressable as <moduleId>.json/<section>. */
const MODULE_SECTIONS = new Set(['info', 'triggers', 'regex', 'lorebook', 'assets']);

function provider(call: RouteCall, tool: string, args: Record<string, unknown>): Promise<ProviderOutcome> {
  return callProvider(call.providers.characterWorkbench, tool, args, call.context);
}

async function getCharacter(call: RouteCall, id: string): Promise<{ ok: true; character: Record<string, unknown> } | { ok: false; error: string }> {
  const res = await provider(call, 'character_get', { characterId: id });
  if (!res.ok) return res;
  if (!isRecord(res.value)) return { ok: false, error: err('unexpected character_get result') };
  return { ok: true, character: res.value };
}

/** Greeting files are the index as a plain string — parse + bounds-check, or undefined. */
function parseGreetingIndex(seg: string, length: number): number | undefined {
  if (!/^\d+$/.test(seg)) return undefined;
  const n = parseInt(seg, 10);
  return n < length ? n : undefined;
}

/** One-line ls annotation for a greeting: first line, truncated to ~40 chars. */
function greetingPreview(greeting: string): string | undefined {
  const firstLine = greeting.split('\n', 1)[0] ?? '';
  if (firstLine === '') return undefined;
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

// ---------- ls ----------

async function ls(call: RouteCall): Promise<ListEntry[] | string> {
  const [id, sub, file] = call.segs;
  if (id === undefined) return COLLECTION_REFUSAL;
  if (isNewSegment(id)) return err(`no such file: ${call.path}`);
  if (sub === undefined) return lsCharacterDir(call, id);
  if (call.segs.length === 2 && SUBCOLLECTIONS.has(sub)) return lsSubCollection(call, id, sub);
  // JSON-blob files with per-field expansions list their field files.
  if (sub === 'meta.json' && file === undefined) return lsFieldFiles(call, META_FIELDS);
  const specs = call.segs.length === 3 && file !== undefined && !isNewSegment(file) ? FIELD_FILE_SPECS[sub] : undefined;
  if (specs !== undefined) return lsFieldFiles(call, specs);
  // Anything deeper is a file (or a module section) — list it as its own entry.
  return fileEntry(call, read);
}

/** ls on a JSON-blob file that expands into per-field files: prove it exists via read, then list the fields. */
async function lsFieldFiles(call: RouteCall, specs: readonly FieldSpec[]): Promise<ListEntry[] | string> {
  const content = await read(call);
  if (isError(content)) return content;
  return fieldEntries(specs);
}

async function lsCharacterDir(call: RouteCall, id: string): Promise<ListEntry[] | string> {
  const res = await getCharacter(call, id);
  if (!res.ok) return res.error;
  const c = res.character;

  // Empty fields and absent sub-collections are always hidden — there is no
  // "show everything" flag.
  const entries: ListEntry[] = [];
  for (const [file, key] of TEXT_FIELDS) {
    const text = asString(c[key]);
    if (text !== undefined && text.length > 0) entries.push({ name: file, dir: false });
  }
  entries.push({ name: 'meta.json', dir: false });

  if (typeof c['worldInfoId'] === 'string') entries.push({ name: 'lorebook', dir: true });
  if (asArray(c['alternateGreetings']).length > 0) entries.push({ name: 'greetings', dir: true });

  // Sub-collection presence via the entity-internal listers; a failing call
  // degrades to "absent" rather than failing the whole listing.
  const rules = await provider(call, 'regex_list', { characterId: id });
  if (rules.ok && asArray(rules.value).length > 0) entries.push({ name: 'regex', dir: true });

  const assets = await provider(call, 'character_asset_list', { characterId: id });
  const assetTotal = assets.ok && isRecord(assets.value) ? assets.value['total'] : 0;
  if (typeof assetTotal === 'number' && assetTotal > 0) entries.push({ name: 'assets', dir: true });

  const modules = await provider(call, 'risu_module_list', { characterId: id });
  const moduleTotal = modules.ok && isRecord(modules.value) ? modules.value['total'] : 0;
  if (typeof moduleTotal === 'number' && moduleTotal > 0) entries.push({ name: 'modules', dir: true });

  const logic = await provider(call, 'backend_logic_get', { characterId: id });
  const logicRec = logic.ok && isRecord(logic.value) ? logic.value : {};
  const logicSource = asString(logicRec['luaSource']) ?? '';
  if (logicRec['enabled'] === true || logicSource.length > 0) entries.push({ name: 'backend_logic.lua', dir: false });

  return entries;
}

async function lsSubCollection(call: RouteCall, id: string, sub: string): Promise<ListEntry[] | string> {
  switch (sub) {
    case 'lorebook': {
      const res = await provider(call, 'lorebook_get', { characterId: id });
      if (!res.ok) return res.error;
      const entries = isRecord(res.value) ? asArray(res.value['entries']) : [];
      return entries.filter(isRecord).map((e) => {
        const comment = asString(e['comment']);
        const keys = asArray(e['keys']).filter((k): k is string => typeof k === 'string');
        return { name: `${idOf(e)}.json`, dir: false, annotation: comment !== undefined && comment !== '' ? comment : keys.join(', ') || undefined };
      });
    }
    case 'greetings': {
      const res = await getCharacter(call, id);
      if (!res.ok) return res.error;
      return asArray(res.character['alternateGreetings'])
        .filter((g): g is string => typeof g === 'string')
        .map((g, i) => ({ name: String(i), dir: false, annotation: greetingPreview(g) }));
    }
    case 'regex': {
      const res = await provider(call, 'regex_list', { characterId: id });
      if (!res.ok) return res.error;
      return asArray(res.value).filter(isRecord).map((r) => ({ name: `${idOf(r)}.json`, dir: false, annotation: asString(r['name']) }));
    }
    case 'assets': {
      const res = await provider(call, 'character_asset_list', { characterId: id });
      if (!res.ok) return res.error;
      const assets = isRecord(res.value) ? asArray(res.value['assets']) : [];
      return assets.filter(isRecord).map((a) => ({ name: `${idOf(a)}.json`, dir: false, annotation: asString(a['name']) }));
    }
    case 'modules': {
      const res = await provider(call, 'risu_module_list', { characterId: id });
      if (!res.ok) return res.error;
      const modules = isRecord(res.value) ? asArray(res.value['modules']) : [];
      return modules.filter(isRecord).map((m) => ({ name: `${idOf(m)}.json`, dir: false, annotation: asString(m['name']) }));
    }
    default:
      return err(`no such file: ${call.path}`);
  }
}

// ---------- read ----------

async function read(call: RouteCall): Promise<string> {
  const [id, sub, file, ...rest] = call.segs;
  if (id === undefined) return err(`is a directory (use ls): ${call.path}`);
  if (isNewSegment(id)) return err(`no such file: ${call.path}`);
  if (sub === undefined) return err(`is a directory (use ls): ${call.path}`);

  if (sub === 'meta.json') {
    if (file === undefined) return readMeta(call, id);
    return readMetaField(call, id, file, rest);
  }
  if (sub === 'backend_logic.lua' && file === undefined) return readBackendLogic(call, id);

  const textField = TEXT_FIELDS.find(([name]) => name === sub);
  if (textField !== undefined && file === undefined) {
    const res = await getCharacter(call, id);
    if (!res.ok) return res.error;
    return asString(res.character[textField[1]]) ?? '';
  }

  if (SUBCOLLECTIONS.has(sub)) {
    if (file === undefined) return err(`is a directory (use ls): ${call.path}`);
    if (isNewSegment(file)) return err(`no such file: ${call.path}`);
    switch (sub) {
      case 'lorebook':
        return readLorebookEntry(call, id, stripJsonExt(file), rest);
      case 'greetings':
        return readGreeting(call, id, file, rest);
      case 'regex':
        return readRegexRule(call, id, stripJsonExt(file), rest);
      case 'assets':
        return readAsset(call, id, stripJsonExt(file));
      case 'modules':
        return readModule(call, id, stripJsonExt(file), rest);
    }
  }
  return err(`no such file: ${call.path}`);
}

async function readMeta(call: RouteCall, id: string): Promise<string> {
  const res = await getCharacter(call, id);
  if (!res.ok) return res.error;
  const c = res.character;
  return pretty({
    name: c['name'] ?? null,
    tags: c['tags'] ?? [],
    alternateGreetings: c['alternateGreetings'] ?? [],
    avatarUrl: c['avatarUrl'] ?? null,
    thumbnailUrl: c['thumbnailUrl'] ?? null,
    worldInfoId: c['worldInfoId'] ?? null,
  });
}

async function readMetaField(call: RouteCall, id: string, file: string, rest: string[]): Promise<string> {
  if (rest.length > 0) return err(`no such file: ${call.path}`);
  const spec = fieldSpec(META_FIELDS, file);
  if (spec === undefined) return err(`no such file: ${call.path}`);
  const res = await getCharacter(call, id);
  if (!res.ok) return res.error;
  return readField(res.character, spec);
}

async function readBackendLogic(call: RouteCall, id: string): Promise<string> {
  // Always fetch the full source; offset/limit slicing is done uniformly by the vfs layer.
  const res = await provider(call, 'backend_logic_get', { characterId: id });
  if (!res.ok) return res.error;
  const rec = isRecord(res.value) ? res.value : {};
  const luaSource = asString(rec['luaSource']) ?? '';
  // Matches the ls rule: the file exists only when the script is enabled or non-empty.
  if (rec['enabled'] !== true && luaSource.length === 0) return err(`no such file: ${call.path}`);
  return luaSource;
}

async function readLorebookEntry(call: RouteCall, id: string, entryId: string, rest: string[]): Promise<string> {
  const res = await provider(call, 'lorebook_get', { characterId: id });
  if (!res.ok) return res.error;
  const entries = isRecord(res.value) ? asArray(res.value['entries']) : [];
  const entry = entries.filter(isRecord).find((e) => e['id'] === entryId);
  if (entry === undefined) return err(`no such file: ${call.path}`);
  if (rest.length === 0) return pretty(entry);
  if (rest.length > 1) return err(`no such file: ${call.path}`);
  const spec = fieldSpec(LOREBOOK_FIELDS, rest[0] ?? '');
  if (spec === undefined) return err(`no such file: ${call.path}`);
  return readField(entry, spec);
}

async function readGreeting(call: RouteCall, id: string, seg: string, rest: string[]): Promise<string> {
  if (rest.length > 0) return err(`no such file: ${call.path}`);
  const res = await getCharacter(call, id);
  if (!res.ok) return res.error;
  const greetings = asArray(res.character['alternateGreetings']);
  const index = parseGreetingIndex(seg, greetings.length);
  const text = index === undefined ? undefined : greetings[index];
  if (typeof text !== 'string') return err(`no such file: ${call.path}`);
  return text;
}

async function readRegexRule(call: RouteCall, id: string, ruleId: string, rest: string[]): Promise<string> {
  const res = await provider(call, 'regex_list', { characterId: id });
  if (!res.ok) return res.error;
  const rule = asArray(res.value).filter(isRecord).find((r) => r['id'] === ruleId);
  if (rule === undefined) return err(`no such file: ${call.path}`);
  if (rest.length === 0) return pretty(rule);
  if (rest.length > 1) return err(`no such file: ${call.path}`);
  const spec = fieldSpec(REGEX_FIELDS, rest[0] ?? '');
  if (spec === undefined) return err(`no such file: ${call.path}`);
  return readField(rule, spec);
}

async function readAsset(call: RouteCall, id: string, assetId: string): Promise<string> {
  const res = await provider(call, 'character_asset_list', { characterId: id });
  if (!res.ok) return res.error;
  const assets = isRecord(res.value) ? asArray(res.value['assets']) : [];
  const asset = assets.filter(isRecord).find((a) => a['id'] === assetId);
  if (asset === undefined) return err(`no such file: ${call.path}`);
  return pretty(asset);
}

async function readModule(call: RouteCall, id: string, moduleId: string, rest: string[]): Promise<string> {
  // Bare <moduleId>.json reads the info section; <moduleId>.json/<section> and
  // <moduleId>.json/trigger/<n> address the other risu_module_get sections.
  let section = 'info';
  let index: number | undefined;
  const [sec, idx] = rest;
  if (sec !== undefined) {
    if (MODULE_SECTIONS.has(sec)) {
      section = sec;
    } else if (sec === 'trigger' && idx !== undefined && /^\d+$/.test(idx)) {
      section = 'trigger';
      index = parseInt(idx, 10);
    } else {
      return err(`no such file: ${call.path}`);
    }
  }
  const args: Record<string, unknown> = { characterId: id, moduleId, section };
  if (index !== undefined) args['index'] = index;
  const res = await provider(call, 'risu_module_get', args);
  if (!res.ok) return res.error;
  return resultToString(res);
}

// ---------- write ----------

async function write(call: RouteCall, content: string): Promise<string> {
  const [id, sub, file, ...rest] = call.segs;
  if (id === undefined) return err(`is a directory: ${call.path}`);

  if (isNewSegment(id)) {
    // /characters/new — body is name + card fields.
    const body = parseJsonObjectBody(content);
    if (!body.ok) return body.error;
    const res = await provider(call, 'character_create', body.value);
    if (!res.ok) return res.error;
    return createdResult(res, `/characters/${idOf(res.value)}/`);
  }

  if (sub === undefined) return err(`is a directory: ${call.path}`);

  if (sub === 'meta.json') {
    if (file !== undefined) return writeMetaField(call, id, file, rest, content);
    const body = parseJsonObjectBody(content);
    if (!body.ok) return body.error;
    const patch: Record<string, unknown> = {};
    for (const key of ['name', 'tags', 'alternateGreetings']) {
      if (key in body.value) patch[key] = body.value[key];
    }
    if (Object.keys(patch).length === 0) {
      return err(`meta.json writable fields: name, tags, alternateGreetings (avatarUrl/thumbnailUrl/worldInfoId are read-only)`);
    }
    const res = await provider(call, 'character_update', { characterId: id, patch });
    if (!res.ok) return res.error;
    return resultToString(res);
  }

  if (sub === 'backend_logic.lua' && file === undefined) {
    // backend_logic_set preserves the current `enabled` flag when only luaSource is given.
    const res = await provider(call, 'backend_logic_set', { characterId: id, luaSource: content });
    if (!res.ok) return res.error;
    return resultToString(res);
  }

  const textField = TEXT_FIELDS.find(([name]) => name === sub);
  if (textField !== undefined && file === undefined) {
    const res = await provider(call, 'character_update', { characterId: id, patch: { [textField[1]]: content } });
    if (!res.ok) return res.error;
    return resultToString(res);
  }

  if (SUBCOLLECTIONS.has(sub) && file !== undefined) {
    return writeInSubCollection(call, id, sub, file, rest, content);
  }
  return err(`no such file: ${call.path}`);
}

/** Write one meta.json field: meta.json/<field> → character_update with a single-key patch. */
async function writeMetaField(call: RouteCall, id: string, file: string, rest: string[], content: string): Promise<string> {
  if (rest.length > 0) return err(`no such file: ${call.path}`);
  const spec = fieldSpec(META_FIELDS, file);
  if (spec === undefined) return err(`no such file: ${call.path}`);
  const parsed = parseFieldContent(spec, content);
  if (!parsed.ok) return parsed.error;
  const res = await provider(call, 'character_update', { characterId: id, patch: { [spec.key]: parsed.value } });
  if (!res.ok) return res.error;
  return resultToString(res);
}

async function writeInSubCollection(call: RouteCall, id: string, sub: string, file: string, rest: string[], content: string): Promise<string> {
  // Lorebook entries and regex rules expand into per-field files: <sub>/<entityId>.json/<field>.
  const specs = FIELD_FILE_SPECS[sub];
  if (specs !== undefined && rest.length > 0) {
    if (isNewSegment(file)) return err(`no such file: ${call.path}`);
    if (rest.length > 1) return err(`no such file: ${call.path}`);
    const spec = fieldSpec(specs, rest[0] ?? '');
    if (spec === undefined) return err(`no such file: ${call.path}`);
    const parsed = parseFieldContent(spec, content);
    if (!parsed.ok) return parsed.error;
    const patch = { [spec.key]: parsed.value };
    const res =
      sub === 'lorebook'
        ? await provider(call, 'lorebook_entry_update', { characterId: id, entryId: stripJsonExt(file), patch })
        : await provider(call, 'regex_update', { characterId: id, ruleId: stripJsonExt(file), patch });
    if (!res.ok) return res.error;
    return resultToString(res);
  }
  if (rest.length > 0) return err(`no such file: ${call.path}`);
  switch (sub) {
    case 'lorebook': {
      if (isNewSegment(file)) {
        const body = parseJsonBody(content);
        if (!body.ok) return body.error;
        const res = await provider(call, 'lorebook_entry_add', { characterId: id, entry: body.value });
        if (!res.ok) return res.error;
        return createdResult(res, `/characters/${id}/lorebook/${idOf(res.value)}.json`);
      }
      const body = parseJsonObjectBody(content);
      if (!body.ok) return body.error;
      const res = await provider(call, 'lorebook_entry_update', { characterId: id, entryId: stripJsonExt(file), patch: body.value });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    case 'greetings': {
      // Alternate greetings are one array on the card: every write patches the
      // whole array via character_update. `new` appends and reports the
      // assigned index as the created path.
      const res = await getCharacter(call, id);
      if (!res.ok) return res.error;
      const current = asArray(res.character['alternateGreetings']);
      if (isNewSegment(file)) {
        const res2 = await provider(call, 'character_update', { characterId: id, patch: { alternateGreetings: [...current, content] } });
        if (!res2.ok) return res2.error;
        return createdResult(res2, `/characters/${id}/greetings/${current.length}`);
      }
      const index = parseGreetingIndex(file, current.length);
      if (index === undefined) return err(`no such file: ${call.path}`);
      const next = [...current];
      next[index] = content;
      const res2 = await provider(call, 'character_update', { characterId: id, patch: { alternateGreetings: next } });
      if (!res2.ok) return res2.error;
      return resultToString(res2);
    }
    case 'regex': {
      if (isNewSegment(file)) {
        const body = parseJsonBody(content);
        if (!body.ok) return body.error;
        const res = await provider(call, 'regex_add', { characterId: id, rule: body.value });
        if (!res.ok) return res.error;
        return createdResult(res, `/characters/${id}/regex/${idOf(res.value)}.json`);
      }
      const body = parseJsonObjectBody(content);
      if (!body.ok) return body.error;
      const res = await provider(call, 'regex_update', { characterId: id, ruleId: stripJsonExt(file), patch: body.value });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    case 'assets': {
      if (!isNewSegment(file)) return err(`${call.path} is read-only`);
      // /characters/<id>/assets/new.json — { attachmentId, name?, type? }; metadata is then computed from the stored file.
      const body = parseJsonObjectBody(content);
      if (!body.ok) return body.error;
      const res = await provider(call, 'character_asset_add', { characterId: id, ...body.value });
      if (!res.ok) return res.error;
      return createdResult(res, `/characters/${id}/assets/${idOf(res.value)}.json`);
    }
    case 'modules':
      // Risu modules are read/remove-only in the fs — authoring was never supported.
      return err(`${call.path} is read-only`);
    default:
      return err(`no such file: ${call.path}`);
  }
}

// ---------- rm ----------

async function rm(call: RouteCall): Promise<string> {
  const [id, sub, file, ...rest] = call.segs;
  if (id === undefined) return err(`is a directory: ${call.path}`);
  if (isNewSegment(id)) return err(`no such file: ${call.path}`);
  if (sub === undefined) {
    return err(`cannot remove ${call.path} — deleting characters is not supported by the workbench`);
  }
  if (file === undefined) {
    if (sub === 'meta.json') return err(`${call.path} is read-only`);
    if (SUBCOLLECTIONS.has(sub)) return err(`is a directory: ${call.path}`);
    // Text fields and backend_logic.lua: clear via write with empty content instead.
    return err(`cannot remove ${call.path} — clear it with write and empty content`);
  }
  if (isNewSegment(file)) return err(`no such file: ${call.path}`);
  if (rest.length > 0) return err(`${call.path} is read-only`);
  if (sub === 'meta.json') return err(`${call.path} is read-only — clear string fields with write and empty content`);

  switch (sub) {
    case 'lorebook': {
      const res = await provider(call, 'lorebook_entry_remove', { characterId: id, entryId: stripJsonExt(file) });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    case 'greetings': {
      const res = await getCharacter(call, id);
      if (!res.ok) return res.error;
      const current = asArray(res.character['alternateGreetings']);
      const index = parseGreetingIndex(file, current.length);
      if (index === undefined) return err(`no such file: ${call.path}`);
      // Indices are positional: removing a greeting shifts every later one down by one.
      const next = current.filter((_, i) => i !== index);
      const res2 = await provider(call, 'character_update', { characterId: id, patch: { alternateGreetings: next } });
      if (!res2.ok) return res2.error;
      return resultToString(res2);
    }
    case 'regex': {
      const res = await provider(call, 'regex_remove', { characterId: id, ruleId: stripJsonExt(file) });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    case 'assets': {
      const res = await provider(call, 'character_asset_remove', { characterId: id, assetId: stripJsonExt(file) });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    case 'modules': {
      const res = await provider(call, 'risu_module_remove', { characterId: id, moduleId: stripJsonExt(file) });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    default:
      return err(`no such file: ${call.path}`);
  }
}

export const charactersRoute: DomainRoute = { ls, read, write, rm };

/** Used by WorkbenchTemplate.edit: the one file whose edits must be delegated to the provider (it load-validates before saving). */
export function isBackendLogicPath(segs: string[]): boolean {
  return segs.length === 2 && segs[1] === 'backend_logic.lua';
}
