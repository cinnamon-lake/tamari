/**
 * /custom-backends/<id>/ — registry custom-backend scripts (Type A).
 * Two-file entity dirs: meta.json ({ name, description, updatedAt }) and
 * source.lua (the generate(prompt, ctx) script). meta.json's writable fields
 * (name, description) are also readable/writable one at a time as
 * meta.json/<field>. Create via
 * /custom-backends/new.json ({ name, description?, luaSource }); the real
 * dir path comes back in the result. rm on the dir deletes the script.
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
  return callProvider(call.providers.backendWorkbench, tool, args, call.context);
}

/** meta.json writable fields, also readable/writable one at a time as meta.json/<file> (updatedAt is read-only). */
const META_FIELDS: readonly FieldSpec[] = [
  { file: 'name', key: 'name', type: 'string' },
  { file: 'description', key: 'description', type: 'string' },
];

async function ls(call: RouteCall): Promise<ListEntry[] | RouteError> {
  const [id, file] = call.segs;
  if (id === undefined) return { error: COLLECTION_REFUSAL };
  if (isNewSegment(id)) return { error: err(`no such file: ${call.path}`) };
  if (file === undefined) {
    const res = await provider(call, 'custom_backend_get', { id });
    if (!res.ok) return { error: res.error };
    return [
      { name: 'meta.json', dir: false },
      { name: 'source.lua', dir: false },
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
  const res = await provider(call, 'custom_backend_get', { id });
  if (!res.ok) return { error: res.error };
  const item = isRecord(res.value) ? res.value : {};
  switch (file) {
    case 'meta.json': {
      if (field !== undefined) {
        const spec = fieldSpec(META_FIELDS, field);
        if (spec === undefined) return { error: err(`no such file: ${call.path}`) };
        return readField(item, spec);
      }
      return pretty({ name: item['name'] ?? null, description: item['description'] ?? '', updatedAt: item['updatedAt'] ?? null });
    }
    case 'source.lua':
      if (field !== undefined) return { error: err(`no such file: ${call.path}`) };
      return asString(item['luaSource']) ?? '';
    default:
      return { error: err(`no such file: ${call.path}`) };
  }
}

async function write(call: RouteCall, content: string): Promise<string> {
  const [id, file, field, ...rest] = call.segs;
  if (id === undefined) return err(`is a directory: ${call.path}`);

  if (isNewSegment(id)) {
    // /custom-backends/new.json — { name, description?, luaSource }.
    const body = parseJsonObjectBody(content);
    if (!body.ok) return body.error;
    const res = await provider(call, 'custom_backend_create', body.value);
    if (!res.ok) return res.error;
    return createdResult(res, `/custom-backends/${idOf(res.value)}/`);
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
        const res = await provider(call, 'custom_backend_update', { id, patch: { [spec.key]: parsed.value } });
        if (!res.ok) return res.error;
        return resultToString(res);
      }
      const body = parseJsonObjectBody(content);
      if (!body.ok) return body.error;
      const patch: Record<string, unknown> = {};
      for (const key of ['name', 'description']) {
        if (key in body.value) patch[key] = body.value[key];
      }
      if (Object.keys(patch).length === 0) return err(`meta.json writable fields: name, description`);
      const res = await provider(call, 'custom_backend_update', { id, patch });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    case 'source.lua': {
      if (field !== undefined) return err(`no such file: ${call.path}`);
      const res = await provider(call, 'custom_backend_update', { id, patch: { luaSource: content } });
      if (!res.ok) return res.error;
      return resultToString(res);
    }
    default:
      return err(`no such file: ${call.path}`);
  }
}

async function rm(call: RouteCall): Promise<string> {
  const [id, file] = call.segs;
  if (id === undefined) return err(`is a directory: ${call.path}`);
  if (isNewSegment(id)) return err(`no such file: ${call.path}`);
  if (file !== undefined) return err(`${call.path} is read-only`);
  const res = await provider(call, 'custom_backend_delete', { id });
  if (!res.ok) return res.error;
  return resultToString(res);
}

export const customBackendsRoute: DomainRoute = { ls, read, write, rm };
