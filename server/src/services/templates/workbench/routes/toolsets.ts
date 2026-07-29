/**
 * /toolsets/<toolsetId>.json — toolsets (enabled instances of tool templates).
 * Reads include the resolved template definition. Create via
 * /toolsets/new.json ({ templateId, name?, config?, toolOverrides?, enabled? }).
 * No delete — disable with write { "enabled": false }.
 */

import { isJson, isNewSegment, stripJsonExt } from '../pathUtils.js';
import {
  callProvider,
  createdResult,
  COLLECTION_REFUSAL,
  err,
  fileEntry,
  idOf,
  parseJsonObjectBody,
  resultToString,
  type DomainRoute,
  type ListEntry,
  type RouteCall,
} from '../router.js';

async function ls(call: RouteCall): Promise<ListEntry[] | string> {
  const [file] = call.segs;
  if (file === undefined) return COLLECTION_REFUSAL;
  if (isNewSegment(file) || !isJson(file)) return err(`no such file: ${call.path}`);
  return fileEntry(call, read);
}

async function read(call: RouteCall): Promise<string> {
  const [file] = call.segs;
  if (file === undefined) return err(`is a directory (use ls): ${call.path}`);
  if (isNewSegment(file) || !isJson(file)) return err(`no such file: ${call.path}`);
  const res = await callProvider(call.providers.toolsetWorkbench, 'toolset_get', { id: stripJsonExt(file) }, call.context);
  if (!res.ok) return res.error;
  return resultToString(res);
}

async function write(call: RouteCall, content: string): Promise<string> {
  const [file] = call.segs;
  if (file === undefined) return err(`is a directory: ${call.path}`);
  const body = parseJsonObjectBody(content);
  if (!body.ok) return body.error;

  if (isNewSegment(file)) {
    const res = await callProvider(call.providers.toolsetWorkbench, 'toolset_create', body.value, call.context);
    if (!res.ok) return res.error;
    return createdResult(res, `/toolsets/${idOf(res.value)}.json`);
  }
  if (!isJson(file)) return err(`no such file: ${call.path}`);
  const res = await callProvider(
    call.providers.toolsetWorkbench,
    'toolset_update',
    { id: stripJsonExt(file), patch: body.value },
    call.context,
  );
  if (!res.ok) return res.error;
  return resultToString(res);
}

async function rm(call: RouteCall): Promise<string> {
  const [file] = call.segs;
  if (file === undefined) return err(`is a directory: ${call.path}`);
  return err(`cannot remove ${call.path} — disable it via write with "enabled": false`);
}

export const toolsetsRoute: DomainRoute = { ls, read, write, rm };
