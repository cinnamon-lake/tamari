/**
 * /generations/<id>/ — read-only debug-trace access (docs/design/debug-traces.md).
 *
 * One directory per generation record: meta.json (the full record, incl. the
 * meta payload), error.txt (the rendered trace chain, when the run failed),
 * prompt.json (the round-1 prompt snapshot) and prompts.json (every round's
 * prompt) — the latter two only present when prompt capture was on for that
 * run. Trace ids come from run_agent results ([trace: <id>])
 * or generation records — the no-discovery rule holds: ls /generations/
 * refuses like every other collection. Traces are immutable, so write and rm
 * are read-only refusals.
 */

import type { Generation } from '@tamari/types';
import { renderTraceError } from '../../../../generation/trace.js';
import {
  COLLECTION_REFUSAL,
  err,
  fileEntry,
  pretty,
  type DomainRoute,
  type ListEntry,
  type RouteCall,
  type RouteError,
} from '../router.js';

async function getGeneration(call: RouteCall, id: string): Promise<{ ok: true; record: Generation } | { ok: false; error: string }> {
  const repo = call.providers.generations;
  if (!repo) return { ok: false, error: err('generation records are not available in this context') };
  const record = await repo.getById(id);
  if (!record) return { ok: false, error: err(`no such file: ${call.path}`) };
  return { ok: true, record };
}

// ---------- ls ----------

async function ls(call: RouteCall): Promise<ListEntry[] | RouteError> {
  const [id, file] = call.segs;
  if (id === undefined) return { error: COLLECTION_REFUSAL };
  const res = await getGeneration(call, id);
  if (!res.ok) return { error: res.error };
  if (file !== undefined) return fileEntry(call, read);

  const entries: ListEntry[] = [{ name: 'meta.json', dir: false }];
  if (res.record.meta?.traceError || res.record.errorMessage) entries.push({ name: 'error.txt', dir: false });
  if (res.record.meta?.prompt) entries.push({ name: 'prompt.json', dir: false });
  if (res.record.meta?.prompts) entries.push({ name: 'prompts.json', dir: false });
  return entries;
}

// ---------- read ----------

async function read(call: RouteCall): Promise<string | RouteError> {
  const [id, file] = call.segs;
  if (id === undefined || file === undefined) return { error: err(`is a directory (use ls): ${call.path}`) };
  const res = await getGeneration(call, id);
  if (!res.ok) return { error: res.error };
  const { record } = res;

  switch (file) {
    case 'meta.json':
      return pretty(record);
    case 'error.txt': {
      const traceError = record.meta?.traceError;
      if (traceError) return renderTraceError(traceError);
      if (record.errorMessage) return record.errorMessage;
      return { error: err(`no such file: ${call.path}`) };
    }
    case 'prompt.json': {
      if (!record.meta?.prompt) return { error: err(`no such file: ${call.path}`) };
      return pretty(record.meta.prompt);
    }
    case 'prompts.json': {
      if (!record.meta?.prompts) return { error: err(`no such file: ${call.path}`) };
      return pretty(record.meta.prompts);
    }
    default:
      return { error: err(`no such file: ${call.path}`) };
  }
}

// ---------- write / rm (immutable) ----------

async function write(call: RouteCall): Promise<string> {
  return err(`${call.path} is read-only`);
}

async function rm(call: RouteCall): Promise<string> {
  return err(`${call.path} is read-only`);
}

export const generationsRoute: DomainRoute = { ls, read, write, rm };
