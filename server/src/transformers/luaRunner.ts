/**
 * Lua transformer runner — sandboxed wasmoon execution of a user Lua
 * transformer script over the rendered message array.
 *
 * Sandbox cloned from the request-script surface (backends/RequestScript.ts):
 * no io/os/debug/package/require/load, no network, 5s execution deadline,
 * 64 MB Lua heap cap. Unlike request scripts there is no `request` table and
 * no fetch — the script must define a global entry function:
 *
 *   function handle(messages, ctx) ... return messages end
 *
 * `messages` is the rendered prompt as a plain array of
 * `{ role, content, reasoningFormatted? }` where `content` is ALWAYS an array
 * of content parts (e.g. `{ { type = "text", text = "..." } }` — the pipeline
 * never passes bare strings, so scripts have one uniform shape to work with).
 * `ctx` is `{ userName, charName, generationType, model, backendProvider }`
 * (names are final, post-macro). handle() RETURNS the (possibly new) message
 * array — unlike request scripts, which mutate the `request` object in
 * place, the array is threaded by return value. The result is validated back
 * into `PipelineMessage[]` (a bare-string `content` in the RETURN value is
 * tolerated and normalized to a single text part); any error, timeout,
 * missing handle, or malformed result keeps the pre-step messages and yields
 * a trace note instead of aborting the generation.
 */

import { LuaFactory } from 'wasmoon';
import { z } from 'zod';
import { ContentPartSchema } from '@tamari/types';
import type { ContentPart, PipelineMessage } from '@tamari/types';
import type { TransformerContext } from './types.js';
import type { LuaRuntime } from '../scripting/LuaRuntime.js';
import { validateLuaSource } from '../scripting/validateLuaSource.js';

const luaFactory = new LuaFactory();

const PipelineMessageResultSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  reasoningFormatted: z.string().optional(),
});

const MessagesResultSchema = z.array(PipelineMessageResultSchema);

export interface LuaTransformerResult {
  messages: PipelineMessage[];
  /** Trace note when the step failed (messages are the pre-step array). */
  note?: string;
}

export interface LuaTransformerOptions {
  /** Execution deadline in ms (default 5000). Overridable for tests. */
  timeoutMs?: number;
  /** Lua heap cap in bytes (default 64 MB). Overridable for tests. */
  maxMemoryBytes?: number;
}

export async function runLuaTransformer(
  script: string,
  messages: PipelineMessage[],
  ctx: TransformerContext,
  opts?: LuaTransformerOptions,
): Promise<LuaTransformerResult> {
  // Deep-clone before injecting: with injectObjects the Lua state mutates the
  // injected objects through proxies, and the failure contract requires the
  // pre-step array to survive untouched.
  const injected = JSON.parse(JSON.stringify(messages)) as unknown;

  // traceAllocations routes the state through the JS allocator wrapper so
  // setMemoryMax can reject growth — same heap cap as RequestScript/LuaRuntime.
  const lua = await luaFactory.createEngine({ enableProxy: false, injectObjects: true, traceAllocations: true });
  try {
    lua.global.setMemoryMax(opts?.maxMemoryBytes ?? 64 * 1024 * 1024);
    // setTimeout takes an ABSOLUTE epoch-ms deadline, not a duration. It covers
    // the chunk load AND the handle() call below (one deadline per engine).
    lua.global.setTimeout(Date.now() + (opts?.timeoutMs ?? 5000));

    // Strip dangerous libraries and functions (same sandbox as RequestScript).
    lua.global.set('io', undefined);
    lua.global.set('os', undefined);
    lua.global.set('debug', undefined);
    lua.global.set('package', undefined);
    lua.global.set('require', undefined);
    lua.global.set('loadfile', undefined);
    lua.global.set('dofile', undefined);
    lua.global.set('load', undefined);
    lua.global.set('loadstring', undefined);

    // Load the chunk, then invoke its entry point THROUGH doString rather
    // than a JS-side proxy call: wasmoon's instruction-hook deadline never
    // reaches function-proxy calls (they run on a child thread whose timeout
    // is unset), so a busy loop inside a proxy-called handle() would hang the
    // event loop forever. A doString wrapper keeps the deadline enforceable.
    // The runner globals are an implementation detail — the script contract
    // is handle(messages, ctx) arguments in, array returned.
    lua.global.set('__tamari_messages', injected);
    lua.global.set('__tamari_ctx', { ...ctx });
    await lua.doString(script);
    const handle: unknown = lua.global.get('handle');
    if (typeof handle !== 'function') {
      return { messages, note: 'script must define handle(messages, ctx) — kept pre-step messages' };
    }
    const returned: unknown = await lua.doString('return handle(__tamari_messages, __tamari_ctx)');

    const parsed = MessagesResultSchema.safeParse(returned);
    if (!parsed.success) {
      return {
        messages,
        note: `script returned malformed messages (${parsed.error.issues[0]?.message ?? 'invalid'}) — kept pre-step messages`,
      };
    }
    // Normalize: scripts may return a bare-string content (tolerated); the
    // post-chain invariant is always a parts array.
    const normalized: PipelineMessage[] = parsed.data.map((m) => {
      const content: ContentPart[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      return {
        role: m.role,
        content,
        ...(m.reasoningFormatted !== undefined ? { reasoningFormatted: m.reasoningFormatted } : {}),
      };
    });
    return { messages: normalized };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { messages, note: `script failed: ${message} — kept pre-step messages` };
  } finally {
    lua.global.close();
  }
}

/**
 * Load-check a transformer script's Lua source (for the dispatch `validate`
 * handler): the chunk must parse and load in a fresh sandbox and define the
 * handle(messages, ctx) entry point (the generate() requirement's analogue
 * for backend scripts).
 */
export function validateTransformerLuaSource(luaRuntime: LuaRuntime, source: string): Promise<string | null> {
  return validateLuaSource(luaRuntime, source, {}, { name: 'handle', signature: 'handle(messages, ctx)' });
}
