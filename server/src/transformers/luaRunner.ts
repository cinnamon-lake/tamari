/**
 * Lua transformer runner — sandboxed wasmoon execution of a user Lua
 * transformer script over the rendered message array.
 *
 * Sandbox cloned from the request-script surface (backends/RequestScript.ts):
 * no io/os/debug/package/require/load, no network, 5s execution deadline,
 * 64 MB Lua heap cap. Unlike request scripts there is no `request` table and
 * no fetch — the script gets:
 *   - `messages`: the rendered prompt as a plain array (mutable in place);
 *   - `ctx`: `{ userName, charName, generationType, model, backendProvider }`.
 * The script either mutates `messages` in place or returns a new array from
 * the chunk. The result is validated back into `PipelineMessage[]`; any
 * error, timeout, or malformed result keeps the pre-step messages and yields
 * a trace note instead of aborting the generation.
 */

import { LuaFactory } from 'wasmoon';
import { z } from 'zod';
import { ContentPartSchema } from '@tamari/types';
import type { PipelineMessage } from '@tamari/types';
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
    // setTimeout takes an ABSOLUTE epoch-ms deadline, not a duration.
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

    lua.global.set('messages', injected);
    lua.global.set('ctx', { ...ctx });

    const returned: unknown = await lua.doString(script);

    // The script either returned a new array or mutated `messages` in place.
    const candidate: unknown = returned ?? lua.global.get('messages');
    const parsed = MessagesResultSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        messages,
        note: `script returned malformed messages (${parsed.error.issues[0]?.message ?? 'invalid'}) — kept pre-step messages`,
      };
    }
    return { messages: parsed.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { messages, note: `script failed: ${message} — kept pre-step messages` };
  } finally {
    lua.global.close();
  }
}

/**
 * Load-check a transformer script's Lua source (for the dispatch `validate`
 * handler): the chunk must parse and load in a fresh sandbox. Transformer
 * scripts define no required entry function (they mutate/return `messages`),
 * so unlike backend scripts there is no generate() requirement.
 */
export function validateTransformerLuaSource(luaRuntime: LuaRuntime, source: string): Promise<string | null> {
  return validateLuaSource(luaRuntime, source, {}, false);
}
