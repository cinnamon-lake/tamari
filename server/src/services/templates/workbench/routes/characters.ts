/**
 * /characters/<id>/ — card-authoring domain.
 *
 * Layout: text field files (snake_case names mapping to camelCase card
 * fields), meta.json, the lorebook/ greetings/ regex/ assets/ modules/
 * sub-collections, and backend_logic/ (the card-coupled backend script as a
 * directory: main.lua is the entry point, everything else is a module
 * require()'d from the script). greetings/ holds the card's alternate
 * greetings as one text file per index (meta.json still exposes the whole
 * alternateGreetings array for bulk reads/replaces). The backend_logic
 * `enabled` flag is deliberately NOT exposed as a separate file: writes to
 * main.lua go to backend_logic_set, which preserves the current flag when
 * only luaSource is given; edits go to backend_logic_edit, which
 * load-validates before saving. The legacy single-file path
 * backend_logic.lua stays as an alias for backend_logic/main.lua.
 *
 * JSON-blob files — meta.json, lorebook/<entryId>.json, regex/<ruleId>.json —
 * also expand into per-field files (<file>.json/<field> or meta.json/<field>):
 * string fields are read/written raw (no JSON escaping), other fields as JSON
 * values. Field writes become single-key patches of the same provider ops the
 * whole-file writes use.
 */

import { isNewSegment, stripJsonExt } from '../pathUtils.js';
import {
  FIELD_FILE_SPECS,
  LOREBOOK_FIELDS,
  META_FIELDS,
  REGEX_FIELDS,
  TEXT_FIELDS,
} from '../../../cardFormat/fields.js';
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
  type RouteError,
} from '../router.js';

/** [file name, camelCase card field] tables live in services/cardFormat/fields.ts (imported above). */

const SUBCOLLECTIONS = new Set(['lorebook', 'greetings', 'regex', 'assets', 'modules']);

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

async function ls(call: RouteCall): Promise<ListEntry[] | RouteError> {
  const [id, sub, file] = call.segs;
  if (id === undefined) return { error: COLLECTION_REFUSAL };
  if (isNewSegment(id)) return { error: err(`no such file: ${call.path}`) };
  if (sub === undefined) return lsCharacterDir(call, id);
  if (call.segs.length === 2 && sub === 'backend_logic') return lsBackendLogicDir(call, id);
  if (call.segs.length === 2 && SUBCOLLECTIONS.has(sub)) return lsSubCollection(call, id, sub);
  // JSON-blob files with per-field expansions list their field files.
  if (sub === 'meta.json' && file === undefined) return lsFieldFiles(call, META_FIELDS);
  const specs = call.segs.length === 3 && file !== undefined && !isNewSegment(file) ? FIELD_FILE_SPECS[sub] : undefined;
  if (specs !== undefined) return lsFieldFiles(call, specs);
  // Anything deeper is a file (or a module section) — list it as its own entry.
  return fileEntry(call, read);
}

/** ls on a JSON-blob file that expands into per-field files: prove it exists via read, then list the fields. */
async function lsFieldFiles(call: RouteCall, specs: readonly FieldSpec[]): Promise<ListEntry[] | RouteError> {
  const content = await read(call);
  if (typeof content !== 'string') return content;
  return fieldEntries(specs);
}

async function lsCharacterDir(call: RouteCall, id: string): Promise<ListEntry[] | RouteError> {
  const res = await getCharacter(call, id);
  if (!res.ok) return { error: res.error };
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
  const logicFiles = await provider(call, 'backend_file_list', { characterId: id });
  const moduleCount = logicFiles.ok && isRecord(logicFiles.value) ? asArray(logicFiles.value['files']).length : 0;
  if (logicRec['enabled'] === true || logicSource.length > 0 || moduleCount > 0) {
    entries.push({ name: 'backend_logic', dir: true });
  }

  return entries;
}

/** ls /characters/<id>/backend_logic/ — main.lua plus every stored module. */
async function lsBackendLogicDir(call: RouteCall, id: string): Promise<ListEntry[] | RouteError> {
  const res = await provider(call, 'backend_file_list', { characterId: id });
  // A failing provider call degrades to "no modules" rather than failing the
  // whole listing (same rule as the card dir).
  const modules = res.ok && isRecord(res.value) ? asArray(res.value['files']).filter((f): f is string => typeof f === 'string') : [];
  return [{ name: 'main.lua', dir: false }, ...modules.map((f) => ({ name: f, dir: false }))];
}

async function lsSubCollection(call: RouteCall, id: string, sub: string): Promise<ListEntry[] | RouteError> {
  switch (sub) {
    case 'lorebook': {
      const res = await provider(call, 'lorebook_get', { characterId: id });
      if (!res.ok) return { error: res.error };
      const entries = isRecord(res.value) ? asArray(res.value['entries']) : [];
      return entries.filter(isRecord).map((e) => {
        const comment = asString(e['comment']);
        const keys = asArray(e['keys']).filter((k): k is string => typeof k === 'string');
        return { name: `${idOf(e)}.json`, dir: false, annotation: comment !== undefined && comment !== '' ? comment : keys.join(', ') || undefined };
      });
    }
    case 'greetings': {
      const res = await getCharacter(call, id);
      if (!res.ok) return { error: res.error };
      return asArray(res.character['alternateGreetings'])
        .filter((g): g is string => typeof g === 'string')
        .map((g, i) => ({ name: String(i), dir: false, annotation: greetingPreview(g) }));
    }
    case 'regex': {
      const res = await provider(call, 'regex_list', { characterId: id });
      if (!res.ok) return { error: res.error };
      return asArray(res.value).filter(isRecord).map((r) => ({ name: `${idOf(r)}.json`, dir: false, annotation: asString(r['name']) }));
    }
    case 'assets': {
      const res = await provider(call, 'character_asset_list', { characterId: id });
      if (!res.ok) return { error: res.error };
      const assets = isRecord(res.value) ? asArray(res.value['assets']) : [];
      return assets.filter(isRecord).map((a) => ({ name: `${idOf(a)}.json`, dir: false, annotation: asString(a['name']) }));
    }
    case 'modules': {
      const res = await provider(call, 'risu_module_list', { characterId: id });
      if (!res.ok) return { error: res.error };
      const modules = isRecord(res.value) ? asArray(res.value['modules']) : [];
      return modules.filter(isRecord).map((m) => ({ name: `${idOf(m)}.json`, dir: false, annotation: asString(m['name']) }));
    }
    default:
      return { error: err(`no such file: ${call.path}`) };
  }
}

// ---------- read ----------

async function read(call: RouteCall): Promise<string | RouteError> {
  const [id, sub, file, ...rest] = call.segs;
  if (id === undefined) return { error: err(`is a directory (use ls): ${call.path}`) };
  if (isNewSegment(id)) return { error: err(`no such file: ${call.path}`) };
  if (sub === undefined) return { error: err(`is a directory (use ls): ${call.path}`) };

  if (sub === 'meta.json') {
    if (file === undefined) return readMeta(call, id);
    return readMetaField(call, id, file, rest);
  }
  if (sub === 'backend_logic.lua' && file === undefined) return readBackendLogic(call, id);
  if (sub === 'backend_logic') {
    if (file === undefined) return { error: err(`is a directory (use ls): ${call.path}`) };
    if (file === 'main.lua' && rest.length === 0) return readBackendLogic(call, id);
    return readBackendFile(call, id, [file, ...rest].join('/'));
  }

  const textField = TEXT_FIELDS.find(([name]) => name === sub);
  if (textField !== undefined && file === undefined) {
    const res = await getCharacter(call, id);
    if (!res.ok) return { error: res.error };
    return asString(res.character[textField[1]]) ?? '';
  }

  if (SUBCOLLECTIONS.has(sub)) {
    if (file === undefined) return { error: err(`is a directory (use ls): ${call.path}`) };
    if (isNewSegment(file)) return { error: err(`no such file: ${call.path}`) };
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
  return { error: err(`no such file: ${call.path}`) };
}

async function readMeta(call: RouteCall, id: string): Promise<string | RouteError> {
  const res = await getCharacter(call, id);
  if (!res.ok) return { error: res.error };
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

async function readMetaField(call: RouteCall, id: string, file: string, rest: string[]): Promise<string | RouteError> {
  if (rest.length > 0) return { error: err(`no such file: ${call.path}`) };
  const spec = fieldSpec(META_FIELDS, file);
  if (spec === undefined) return { error: err(`no such file: ${call.path}`) };
  const res = await getCharacter(call, id);
  if (!res.ok) return { error: res.error };
  return readField(res.character, spec);
}

async function readBackendLogic(call: RouteCall, id: string): Promise<string | RouteError> {
  // Always fetch the full source; offset/limit slicing is done uniformly by the vfs layer.
  const res = await provider(call, 'backend_logic_get', { characterId: id });
  if (!res.ok) return { error: res.error };
  const rec = isRecord(res.value) ? res.value : {};
  const luaSource = asString(rec['luaSource']) ?? '';
  // Matches the ls rule: the file exists only when the script is enabled or non-empty.
  if (rec['enabled'] !== true && luaSource.length === 0) return { error: err(`no such file: ${call.path}`) };
  return luaSource;
}

async function readBackendFile(call: RouteCall, id: string, path: string): Promise<string | RouteError> {
  const res = await provider(call, 'backend_file_get', { characterId: id, path });
  if (!res.ok) return { error: res.error };
  const rec = isRecord(res.value) ? res.value : {};
  const luaSource = asString(rec['luaSource']);
  if (luaSource === undefined) return { error: err(`no such file: ${call.path}`) };
  return luaSource;
}

async function readLorebookEntry(call: RouteCall, id: string, entryId: string, rest: string[]): Promise<string | RouteError> {
  const res = await provider(call, 'lorebook_get', { characterId: id });
  if (!res.ok) return { error: res.error };
  const entries = isRecord(res.value) ? asArray(res.value['entries']) : [];
  const entry = entries.filter(isRecord).find((e) => e['id'] === entryId);
  if (entry === undefined) return { error: err(`no such file: ${call.path}`) };
  if (rest.length === 0) return pretty(entry);
  if (rest.length > 1) return { error: err(`no such file: ${call.path}`) };
  const spec = fieldSpec(LOREBOOK_FIELDS, rest[0] ?? '');
  if (spec === undefined) return { error: err(`no such file: ${call.path}`) };
  return readField(entry, spec);
}

async function readGreeting(call: RouteCall, id: string, seg: string, rest: string[]): Promise<string | RouteError> {
  if (rest.length > 0) return { error: err(`no such file: ${call.path}`) };
  const res = await getCharacter(call, id);
  if (!res.ok) return { error: res.error };
  const greetings = asArray(res.character['alternateGreetings']);
  const index = parseGreetingIndex(seg, greetings.length);
  const text = index === undefined ? undefined : greetings[index];
  if (typeof text !== 'string') return { error: err(`no such file: ${call.path}`) };
  return text;
}

async function readRegexRule(call: RouteCall, id: string, ruleId: string, rest: string[]): Promise<string | RouteError> {
  const res = await provider(call, 'regex_list', { characterId: id });
  if (!res.ok) return { error: res.error };
  const rule = asArray(res.value).filter(isRecord).find((r) => r['id'] === ruleId);
  if (rule === undefined) return { error: err(`no such file: ${call.path}`) };
  if (rest.length === 0) return pretty(rule);
  if (rest.length > 1) return { error: err(`no such file: ${call.path}`) };
  const spec = fieldSpec(REGEX_FIELDS, rest[0] ?? '');
  if (spec === undefined) return { error: err(`no such file: ${call.path}`) };
  return readField(rule, spec);
}

async function readAsset(call: RouteCall, id: string, assetId: string): Promise<string | RouteError> {
  const res = await provider(call, 'character_asset_list', { characterId: id });
  if (!res.ok) return { error: res.error };
  const assets = isRecord(res.value) ? asArray(res.value['assets']) : [];
  const asset = assets.filter(isRecord).find((a) => a['id'] === assetId);
  if (asset === undefined) return { error: err(`no such file: ${call.path}`) };
  return pretty(asset);
}

async function readModule(call: RouteCall, id: string, moduleId: string, rest: string[]): Promise<string | RouteError> {
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
      return { error: err(`no such file: ${call.path}`) };
    }
  }
  const args: Record<string, unknown> = { characterId: id, moduleId, section };
  if (index !== undefined) args['index'] = index;
  const res = await provider(call, 'risu_module_get', args);
  if (!res.ok) return { error: res.error };
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

  if (sub === 'backend_logic' && file !== undefined) {
    if (file === 'main.lua' && rest.length === 0) {
      const res = await provider(call, 'backend_logic_set', { characterId: id, luaSource: content });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    // Module paths may nest (lib/deep/util.lua) — normalizePath already
    // rejected `.`/`..` segments; backend_file_set enforces the VFS rules.
    const res = await provider(call, 'backend_file_set', { characterId: id, path: [file, ...rest].join('/'), luaSource: content });
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
    // Text fields, backend_logic/, and backend_logic.lua: clear via write with empty content instead.
    return err(`cannot remove ${call.path} — clear it with write and empty content`);
  }
  if (isNewSegment(file)) return err(`no such file: ${call.path}`);
  if (rest.length > 0 && sub !== 'backend_logic') return err(`${call.path} is read-only`);
  if (sub === 'meta.json') return err(`${call.path} is read-only — clear string fields with write and empty content`);
  if (sub === 'backend_logic') {
    if (file === 'main.lua' && rest.length === 0) {
      return err(`cannot remove ${call.path} — clear it with write and empty content`);
    }
    const res = await provider(call, 'backend_file_remove', { characterId: id, path: [file, ...rest].join('/') });
    if (!res.ok) return res.error;
    return resultToString(res);
  }

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

/** Used by WorkbenchTemplate.edit: backend_logic files whose edits are delegated to the provider (load-validation before saving). */
export function isBackendLogicPath(segs: string[]): boolean {
  return (segs.length === 2 && segs[1] === 'backend_logic.lua') || (segs.length >= 3 && segs[1] === 'backend_logic');
}
