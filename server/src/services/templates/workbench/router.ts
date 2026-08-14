/**
 * Router for the workbench virtual filesystem.
 *
 * Resolves normalized path segments to a domain route (one module per
 * top-level directory) and provides the shared helpers the routes use to
 * translate fs ops into provider `execute` calls and map their JSON results
 * back to file content.
 *
 * Protocol: route functions never throw for expected failures — they return
 * `Error: ...` content strings, same as the providers. `ls` returns either
 * structured entries or an error string.
 */

import type { ToolContext, ToolExecuteResult } from '../../ToolTemplate.js';
import type { CharacterWorkbench } from '../../workbench/CharacterWorkbench.js';
import type { BackendWorkbench } from '../../workbench/BackendWorkbench.js';
import type { ToolsetWorkbench } from '../../workbench/ToolsetWorkbench.js';
import type { QuickReplyWorkbench } from '../../workbench/QuickReplyWorkbench.js';
import type { LuaToolWorkbench } from '../../workbench/LuaToolWorkbench.js';
import { charactersRoute } from './routes/characters.js';
import { backendsRoute } from './routes/backends.js';
import { customBackendsRoute } from './routes/customBackends.js';
import { toolsetsRoute } from './routes/toolsets.js';
import { quickRepliesRoute } from './routes/quickReplies.js';
import { luaToolsRoute } from './routes/luaTools.js';
import { generationsRoute } from './routes/generations.js';
import type { Generation } from '@tamari/types';
import { isRecord, pretty } from '../../cardFormat/fields.js';

// The pure field-format helpers and JSON helpers live in services/cardFormat
// (shared with the unpacked-card folder parser); re-exported here so the
// routes keep a single import surface.
export {
  asArray,
  asString,
  err,
  fieldEntries,
  fieldSpec,
  isRecord,
  parseFieldContent,
  parseJsonBody,
  parseJsonObjectBody,
  pretty,
  readField,
  type FieldSpec,
} from '../../cardFormat/fields.js';

/** The five internal workbench providers the vfs dispatches to. */
export interface WorkbenchProviders {
  characterWorkbench: CharacterWorkbench;
  backendWorkbench: BackendWorkbench;
  toolsetWorkbench: ToolsetWorkbench;
  quickReplyWorkbench: QuickReplyWorkbench;
  luaToolWorkbench: LuaToolWorkbench;
  /** Generation records for the read-only /generations/ debug-trace route. */
  generations?: { getById(id: string): Promise<Generation | undefined> };
  /** Headless card chat simulation backing the test_card run verb. */
  cardTest?: { run(args: Record<string, unknown>): Promise<ToolExecuteResult> };
}

export interface RouteCall {
  providers: WorkbenchProviders;
  /** Live tool context (chatId/clientId) — threaded through to providers that need it. */
  context?: ToolContext;
  /** Full normalized vfs path (no trailing slash, except the root "/"). */
  path: string;
  /** Segments after the domain segment. */
  segs: string[];
}

export interface ListEntry {
  name: string;
  dir: boolean;
  /** Display name / comment shown after the entry, e.g. `<id>.json  "Name"`. */
  annotation?: string;
}

export interface DomainRoute {
  ls(call: RouteCall): Promise<ListEntry[] | string>;
  read(call: RouteCall): Promise<string>;
  write(call: RouteCall, content: string): Promise<string>;
  rm(call: RouteCall): Promise<string>;
}

/** Refusal for `ls`/`grep` on any collection — there is no discovery mechanism, by design. */
export const COLLECTION_REFUSAL = 'Error: cannot list collections — ids come from the user or chat context';

export function isError(content: string): boolean {
  return content.startsWith('Error:');
}

interface Executable {
  execute(toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult>;
}

export type ProviderOutcome = { ok: true; value: unknown; raw: string } | { ok: false; error: string };

/**
 * Call a provider op and normalize its result: `Error:` content becomes
 * `{ ok: false }`, JSON content is parsed into `value`, anything else is
 * kept as `raw` text (e.g. "Deleted custom backend ...").
 */
export async function callProvider(
  workbench: Executable,
  tool: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ProviderOutcome> {
  const result = await workbench.execute(tool, args, context);
  const raw = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  if (isError(raw)) return { ok: false, error: raw };
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    value = undefined;
  }
  return { ok: true, value, raw };
}

/** Pretty-print a provider result (falls back to the raw text for non-JSON content). */
export function resultToString(res: { value: unknown; raw: string }): string {
  return res.value === undefined ? res.raw : pretty(res.value);
}

/** Extract the `id` field of a provider result (all creation results carry one). */
export function idOf(value: unknown): string {
  return isRecord(value) && typeof value['id'] === 'string' ? value['id'] : '';
}

/** Creation result: the provider JSON plus the real assigned vfs path. */
export function createdResult(res: { value: unknown; raw: string }, path: string): string {
  if (isRecord(res.value)) return pretty({ ...res.value, path });
  return res.raw;
}

/** `ls` on a file path lists the file itself (after proving it exists via read). */
export async function fileEntry(call: RouteCall, read: (c: RouteCall) => Promise<string>): Promise<ListEntry[] | string> {
  const content = await read(call);
  if (isError(content)) return content;
  return [{ name: call.segs[call.segs.length - 1] ?? '', dir: false }];
}

/** Render structured entries as ls output: dirs suffixed `/`, annotations as `<name>  "text"`. */
export function formatLs(entries: ListEntry[]): string {
  return entries.map((e) => (e.dir ? `${e.name}/` : e.annotation !== undefined ? `${e.name}  "${e.annotation}"` : e.name)).join('\n');
}

const ROUTES: Record<string, DomainRoute> = {
  characters: charactersRoute,
  backends: backendsRoute,
  'custom-backends': customBackendsRoute,
  toolsets: toolsetsRoute,
  quickreplies: quickRepliesRoute,
  luatools: luaToolsRoute,
  generations: generationsRoute,
};

/** The static domain names shown by `ls /`. */
export const DOMAIN_NAMES = Object.keys(ROUTES);

export function resolveDomain(name: string): DomainRoute | undefined {
  return ROUTES[name];
}
