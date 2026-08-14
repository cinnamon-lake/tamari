/**
 * /luatools/<id>/ — Lua tool templates. Two-file entity dirs: meta.json
 * ({ name, sandbox, configSchema }) and code.lua (the template source).
 * meta.json's fields are also readable/writable one at a time as
 * meta.json/<field> (name raw; sandbox/config_schema as JSON).
 * Create via /luatools/new.json ({ name, code, sandbox?, configSchema? }) —
 * the provider load-validates the code (getDefinition must succeed) before
 * saving, and code.lua writes re-validate the same way. No delete (matching
 * the provider's no-delete policy).
 */

import { isNewSegment } from '../pathUtils.js';
import {
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

function provider(call: RouteCall, tool: string, args: Record<string, unknown>): Promise<ProviderOutcome> {
  return callProvider(call.providers.luaToolWorkbench, tool, args, call.context);
}

const NO_DELETE = 'Lua tool templates have no delete (matching the existing no-delete policy)';

/** meta.json fields, also readable/writable one at a time as meta.json/<file> (patch keys of luatool_update). */
const META_FIELDS: readonly FieldSpec[] = [
  { file: 'name', key: 'name', type: 'string' },
  { file: 'sandbox', key: 'sandbox', type: 'json' },
  { file: 'config_schema', key: 'configSchema', type: 'json' },
];

async function ls(call: RouteCall): Promise<ListEntry[] | RouteError> {
  const [id, file] = call.segs;
  if (id === undefined) return { error: COLLECTION_REFUSAL };
  if (isNewSegment(id)) return { error: err(`no such file: ${call.path}`) };
  if (file === undefined) {
    const res = await provider(call, 'luatool_get', { id });
    if (!res.ok) return { error: res.error };
    return [
      { name: 'meta.json', dir: false },
      { name: 'code.lua', dir: false },
    ];
  }
  // meta.json expands into per-field files; field paths list themselves.
  if (file === 'meta.json' && call.segs.length === 2) {
    const content = await read(call);
    if (typeof content !== 'string') return content;
    return fieldEntries(META_FIELDS);
  }
  return fileEntry(call, read);
}

async function read(call: RouteCall): Promise<string | RouteError> {
  const [id, file, field, ...rest] = call.segs;
  if (id === undefined || file === undefined) return { error: err(`is a directory (use ls): ${call.path}`) };
  if (isNewSegment(id)) return { error: err(`no such file: ${call.path}`) };
  if (rest.length > 0) return { error: err(`no such file: ${call.path}`) };
  const res = await provider(call, 'luatool_get', { id });
  if (!res.ok) return { error: res.error };
  const item = isRecord(res.value) ? res.value : {};
  switch (file) {
    case 'meta.json': {
      if (field !== undefined) {
        const spec = fieldSpec(META_FIELDS, field);
        if (spec === undefined) return { error: err(`no such file: ${call.path}`) };
        return readField(item, spec);
      }
      return pretty({ name: item['name'] ?? null, sandbox: item['sandbox'] ?? {}, configSchema: item['configSchema'] ?? {} });
    }
    case 'code.lua':
      if (field !== undefined) return { error: err(`no such file: ${call.path}`) };
      return asString(item['code']) ?? '';
    default:
      return { error: err(`no such file: ${call.path}`) };
  }
}

async function write(call: RouteCall, content: string): Promise<string> {
  const [id, file, field, ...rest] = call.segs;
  if (id === undefined) return err(`is a directory: ${call.path}`);

  if (isNewSegment(id)) {
    // /luatools/new.json — { name, code, sandbox?, configSchema? }; invalid code is rejected before saving.
    const body = parseJsonObjectBody(content);
    if (!body.ok) return body.error;
    const res = await provider(call, 'luatool_create', body.value);
    if (!res.ok) return res.error;
    return createdResult(res, `/luatools/${idOf(res.value)}/`);
  }

  if (file === undefined) return err(`is a directory: ${call.path}`);
  switch (file) {
    case 'meta.json': {
      if (field !== undefined) {
        // meta.json/<field> — patch a single field.
        if (rest.length > 0) return err(`no such file: ${call.path}`);
        const spec = fieldSpec(META_FIELDS, field);
        if (spec === undefined) return err(`no such file: ${call.path}`);
        const parsed = parseFieldContent(spec, content);
        if (!parsed.ok) return parsed.error;
        const res = await provider(call, 'luatool_update', { id, patch: { [spec.key]: parsed.value } });
        if (!res.ok) return res.error;
        return resultToString(res);
      }
      const body = parseJsonObjectBody(content);
      if (!body.ok) return body.error;
      const patch: Record<string, unknown> = {};
      for (const key of ['name', 'sandbox', 'configSchema']) {
        if (key in body.value) patch[key] = body.value[key];
      }
      if (Object.keys(patch).length === 0) return err(`meta.json writable fields: name, sandbox, configSchema`);
      const res = await provider(call, 'luatool_update', { id, patch });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    case 'code.lua': {
      if (field !== undefined) return err(`no such file: ${call.path}`);
      // The provider load-validates the new code before saving; validation errors come back unsaved.
      const res = await provider(call, 'luatool_update', { id, patch: { code: content } });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    default:
      return err(`no such file: ${call.path}`);
  }
}

async function rm(call: RouteCall): Promise<string> {
  const [id] = call.segs;
  if (id === undefined) return err(`is a directory: ${call.path}`);
  return err(`cannot remove ${call.path} — ${NO_DELETE}`);
}

export const luaToolsRoute: DomainRoute = { ls, read, write, rm };
