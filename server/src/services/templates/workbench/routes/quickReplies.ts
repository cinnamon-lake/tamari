/**
 * /quickreplies/<scope>/<scopeId>/<id>.json — quick replies.
 * scope ∈ global|character|chat; the global scope uses scopeId `_` (which
 * maps to the empty string the provider expects). scope + scopeId are
 * context the caller supplies, so the scoped collection IS listable — the
 * unscoped /quickreplies/ and /quickreplies/<scope>/ are not.
 * Each <id>.json also expands into per-field files (<id>.json/<field>):
 * label/icon/color/script/language raw, auto_execute/order_index as JSON.
 * No delete (matches the provider's deliberate no-delete policy).
 */

import { isJson, isNewSegment, stripJsonExt } from '../pathUtils.js';
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

const SCOPES = new Set(['global', 'character', 'chat']);

/** Quick-reply fields exposed as <id>.json/<file> (patch keys of quickreply_update). */
const QR_FIELDS: readonly FieldSpec[] = [
  { file: 'label', key: 'label', type: 'string' },
  { file: 'icon', key: 'icon', type: 'string' },
  { file: 'color', key: 'color', type: 'string' },
  { file: 'script', key: 'script', type: 'string' },
  { file: 'language', key: 'language', type: 'string' },
  { file: 'auto_execute', key: 'autoExecute', type: 'json' },
  { file: 'order_index', key: 'orderIndex', type: 'json' },
];

/** `_` is the URL-safe stand-in for the global scope's empty scopeId. */
function realScopeId(seg: string): string {
  return seg === '_' ? '' : seg;
}

function pathScopeId(scopeId: string): string {
  return scopeId === '' ? '_' : scopeId;
}

function provider(call: RouteCall, tool: string, args: Record<string, unknown>): Promise<ProviderOutcome> {
  return callProvider(call.providers.quickReplyWorkbench, tool, args, call.context);
}

/** Validate scope/scopeId segments; returns the refusal/no-such-file error or null. */
function checkScope(call: RouteCall): string | null {
  const [scope, scopeId] = call.segs;
  if (scope === undefined) return COLLECTION_REFUSAL;
  if (!SCOPES.has(scope)) return err(`no such file: ${call.path}`);
  if (scopeId === undefined) return COLLECTION_REFUSAL;
  return null;
}

async function ls(call: RouteCall): Promise<ListEntry[] | RouteError> {
  const bad = checkScope(call);
  if (bad !== null) return { error: bad };
  const [scope, scopeId, file] = call.segs as [string, string, string | undefined];
  if (file !== undefined) {
    // A quick-reply file expands into per-field files; field paths list themselves.
    if (call.segs.length === 3 && !isNewSegment(file)) {
      const content = await read(call);
      if (typeof content !== 'string') return content;
      return fieldEntries(QR_FIELDS);
    }
    return fileEntry(call, read);
  }
  const res = await provider(call, 'quickreply_list', { scope, scopeId: realScopeId(scopeId) });
  if (!res.ok) return { error: res.error };
  return asArray(res.value)
    .filter(isRecord)
    .map((q) => ({ name: `${idOf(q)}.json`, dir: false, annotation: asString(q['label']) }));
}

async function read(call: RouteCall): Promise<string | RouteError> {
  const [scope, scopeId, file, field, ...rest] = call.segs;
  if (scope === undefined) return { error: err(`is a directory (use ls): ${call.path}`) };
  if (!SCOPES.has(scope)) return { error: err(`no such file: ${call.path}`) };
  if (scopeId === undefined) return { error: err(`is a directory (use ls): ${call.path}`) };
  if (file === undefined) return { error: err(`is a directory (use ls): ${call.path}`) };
  if (isNewSegment(file) || !isJson(file)) return { error: err(`no such file: ${call.path}`) };
  if (rest.length > 0) return { error: err(`no such file: ${call.path}`) };

  const res = await provider(call, 'quickreply_list', { scope, scopeId: realScopeId(scopeId) });
  if (!res.ok) return { error: res.error };
  const item = asArray(res.value).filter(isRecord).find((q) => q['id'] === stripJsonExt(file));
  if (item === undefined) return { error: err(`no such file: ${call.path}`) };
  if (field === undefined) return pretty(item);
  const spec = fieldSpec(QR_FIELDS, field);
  if (spec === undefined) return { error: err(`no such file: ${call.path}`) };
  return readField(item, spec);
}

async function write(call: RouteCall, content: string): Promise<string> {
  const [scope, scopeId, file, field, ...rest] = call.segs;
  if (scope === undefined || scopeId === undefined) return err(`is a directory: ${call.path}`);
  if (!SCOPES.has(scope)) return err(`no such file: ${call.path}`);
  if (file === undefined) return err(`is a directory: ${call.path}`);

  if (!isNewSegment(file) && field !== undefined) {
    // <id>.json/<field> — patch a single field.
    if (rest.length > 0 || !isJson(file)) return err(`no such file: ${call.path}`);
    const spec = fieldSpec(QR_FIELDS, field);
    if (spec === undefined) return err(`no such file: ${call.path}`);
    const parsed = parseFieldContent(spec, content);
    if (!parsed.ok) return parsed.error;
    const res = await provider(call, 'quickreply_update', { id: stripJsonExt(file), patch: { [spec.key]: parsed.value } });
    if (!res.ok) return res.error;
    return resultToString(res);
  }
  if (field !== undefined) return err(`no such file: ${call.path}`);

  const body = parseJsonObjectBody(content);
  if (!body.ok) return body.error;

  if (isNewSegment(file)) {
    // scope/scopeId are forced from the path, never taken from the body.
    const real = realScopeId(scopeId);
    const res = await provider(call, 'quickreply_create', { ...body.value, scope, scopeId: real });
    if (!res.ok) return res.error;
    return createdResult(res, `/quickreplies/${scope}/${pathScopeId(real)}/${idOf(res.value)}.json`);
  }
  if (!isJson(file)) return err(`no such file: ${call.path}`);
  const res = await provider(call, 'quickreply_update', { id: stripJsonExt(file), patch: body.value });
  if (!res.ok) return res.error;
  return resultToString(res);
}

async function rm(call: RouteCall): Promise<string> {
  const [scope, , file] = call.segs;
  if (scope === undefined || file === undefined) return err(`is a directory: ${call.path}`);
  return err(`cannot remove ${call.path} — quick replies have no delete (matching the existing no-delete policy)`);
}

export const quickRepliesRoute: DomainRoute = { ls, read, write, rm };
