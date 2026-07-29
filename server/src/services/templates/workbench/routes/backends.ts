/**
 * /backends/<configId>.json — backend configs (apiKey redacted to hasApiKey
 * by the provider). Create via /backends/new.json (body may include
 * "activate": true). No delete — configs are overwritten, not removed.
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

function configId(file: string): string {
  return stripJsonExt(file);
}

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
  const res = await callProvider(call.providers.backendWorkbench, 'backend_get', { configId: configId(file) }, call.context);
  if (!res.ok) return res.error;
  return resultToString(res);
}

async function write(call: RouteCall, content: string): Promise<string> {
  const [file] = call.segs;
  if (file === undefined) return err(`is a directory: ${call.path}`);
  const body = parseJsonObjectBody(content);
  if (!body.ok) return body.error;

  if (isNewSegment(file)) {
    // /backends/new.json — BackendConfigCreateInput fields + optional "activate": true.
    const res = await callProvider(call.providers.backendWorkbench, 'backend_create', body.value, call.context);
    if (!res.ok) return res.error;
    return createdResult(res, `/backends/${idOf(res.value)}.json`);
  }
  if (!isJson(file)) return err(`no such file: ${call.path}`);
  const res = await callProvider(
    call.providers.backendWorkbench,
    'backend_update',
    { configId: configId(file), patch: body.value },
    call.context,
  );
  if (!res.ok) return res.error;
  return resultToString(res);
}

async function rm(call: RouteCall): Promise<string> {
  const [file] = call.segs;
  if (file === undefined) return err(`is a directory: ${call.path}`);
  return err(`cannot remove ${call.path} — backend configs have no delete; overwrite with write or switch the active config`);
}

export const backendsRoute: DomainRoute = { ls, read, write, rm };
