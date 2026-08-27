/**
 * Lua runtime wrapper using wasmoon.
 *
 * Creates isolated Lua states per execution, strips dangerous stdlibs,
 * enforces timeout and memory limits.
 */

import { LuaFactory, LuaEngine, LuaTimeoutError } from 'wasmoon';
import { luaFetch } from './LuaFetch.js';
import { vfsRequirePrelude } from './LuaVfs.js';
/** Default execution deadline for createState — also the number friendlyLuaError reports. */
export const MAX_EXECUTION_MS = 5000;

/**
 * Per-surface wall ceilings. One flat absolute deadline per execution, armed
 * once as the wasmoon instruction-hook deadline — enforced MID-INSTRUCTION,
 * killing zero-await busy loops hard. Awaiting host calls (st.generate,
 * fetch, ...) suspends the VM and consumes no instruction budget: waits are
 * free within the ceiling, so these are sized for real pipelines, unlike the
 * legacy flat 5s under which media templates and multi-generation scripts
 * aborted opaquely mid-run.
 *
 * WHY NOT DYNAMIC BURSTS (fresh budget per awaited call)? wasmoon doString
 * executes on a CHILD thread whose own .timeout field is never set, so its
 * yield-boundary checks never see renewals pushed through global.setTimeout;
 * the instruction hook alone reaches executing code, and that hook latches a
 * single captured deadline (positive-value updates change only the unreachable
 * field). Disarm/re-arm cycles would grant renewals but permanently leak
 * module-lifetime function-table slots — the factory shares one Emscripten
 * module across every engine and the disarm path never calls removeFunction.
 */
export interface ExecutionBudget {
  wallMs: number;
}

/** Quick Reply scripts: buttons may chain generations; ~1 minute of total life. */
export const QUICK_REPLY_BUDGET: ExecutionBudget = { wallMs: 60_000 };
/** Lua tool templates: media pipelines legitimately await slow image/TTS APIs. */
export const LUA_TOOL_BUDGET: ExecutionBudget = { wallMs: 300_000 };

/** Default Lua heap cap per execution — wasmoon enforces it in the allocator
    (traceAllocations), so a memory bomb fails with "not enough memory" instead
    of growing WASM linear memory until the tab/process dies. 64 MB is generous
    for card scripts while staying far below a fatal WASM allocation. */
const DEFAULT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;

/**
 * VM-level sandbox flags — the only options `LuaRuntime.createState` reads.
 * They gate Lua stdlibs and host functions inside the VM itself.
 */
export interface LuaVmSandboxOptions {
  allowIo?: boolean;
  allowOs?: boolean;
  allowDebug?: boolean;
  allowRequire?: boolean;
  allowNet?: boolean;
  /** Lua heap cap in bytes (default DEFAULT_MAX_MEMORY_BYTES). Tests can pass
      a tiny value to exercise the limit without allocating 64 MB. */
  maxMemoryBytes?: number;
  /** Card-scoped module map for the sandboxed VFS `require` (LuaVfs.ts).
      When present, `require` resolves ONLY against these sources. */
  vfsFiles?: Record<string, string>;
}

/**
 * Full Lua tool-template sandbox contract. Adds host-global gates that are
 * NOT enforced by the runtime: `allowFiles` (the `attachments.create` global)
 * and `allowSt` (the curated `st` API) are read exclusively by
 * LuaToolExecutor, which injects those globals after `createState` returns.
 * Kept under this name because services (LuaToolExecutor, ToolRegistry) type
 * their template sandbox fields with it.
 */
export interface LuaRuntimeOptions extends LuaVmSandboxOptions {
  /** Gates the `attachments.create` global — enforced by LuaToolExecutor, not the runtime. */
  allowFiles?: boolean;
  /** Gates the curated `st` API global — enforced by LuaToolExecutor, not the runtime. */
  allowSt?: boolean;
}

/** Result of createState. */
export interface LuaStateHandle {
  lua: LuaEngine;
  cleanup: () => void;
}

export class LuaRuntime {
  private factory: LuaFactory;

  constructor() {
    this.factory = new LuaFactory();
  }

  /**
   * Create a fresh sandboxed engine. `timeoutMs` arms the wasmoon instruction
   * hook with an absolute epoch-ms wall-clock deadline — total script life,
   * waits included, enforced mid-instruction. Surfaces with long legitimate
   * pipelines pass their own ceiling (QUICK_REPLY_BUDGET / LUA_TOOL_BUDGET);
   * everything else keeps the legacy 5s default.
   */
  async createState(opts: LuaVmSandboxOptions = {}, timeoutMs: number = MAX_EXECUTION_MS): Promise<LuaStateHandle> {
    // traceAllocations routes the Lua state through a JS allocator wrapper so
    // setMemoryMax can actually reject allocations (see wasmoon Global).
    const lua = await this.factory.createEngine({
      enableProxy: false,
      injectObjects: true,
      traceAllocations: true,
    });
    lua.global.setMemoryMax(opts.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES);

    // Enforce execution timeout at the Lua VM level via lua_sethook.
    // wasmoon's setTimeout takes an ABSOLUTE epoch-ms deadline, not a duration —
    // passing a duration means the deadline is already in the past and the hook
    // panics (with a non-string error object) on the first 1000-instruction
    // batch. Discovered via heavy card scripts (blackjack shuffle) dying
    // instantly while trivial scripts survived under the threshold.
    lua.global.setTimeout(Date.now() + timeoutMs);

    // Strip dangerous libraries and functions based on sandbox config
    if (!opts.allowIo) {
      lua.global.set('io', undefined);
    }
    if (!opts.allowOs) {
      lua.global.set('os', undefined);
    } else {
      // Even with os enabled, os.execute crashes the wasmoon JS glue and
      // os.exit aborts the engine — both escape pcall, so they stay stripped.
      await lua.doString('os.execute = nil; os.exit = nil');
    }
    if (!opts.allowDebug) {
      lua.global.set('debug', undefined);
    }
    if (!opts.allowRequire) {
      lua.global.set('package', undefined);
      lua.global.set('require', undefined);
    }
    if (opts.allowNet) {
      // SSRF-guarded async fetch (see LuaFetch.ts). Await from Lua via
      // `local res = fetch(url, opts):await()`.
      lua.global.set('fetch', luaFetch);
    }
    // Inject JSON helpers (wasmoon doesn't provide native JSON). `decode`
    // throws on garbage; `parse_result` is the result-style envelope for
    // scripts consuming structured output (reverse proxies emit invalid JSON
    // often enough that pattern-matching beats pcall).
    lua.global.set('json', {
      encode: (value: unknown) => JSON.stringify(value),
      decode: (text: string): unknown => JSON.parse(text),
      parse_result: (text: string): { value: unknown } | { error: string } => {
        try {
          return { value: JSON.parse(text) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    // Base64 helpers for binary payloads (media templates). Lua strings are
    // byte strings, so latin1 mapping preserves bytes 0-255. Pure functions —
    // injected unconditionally, like json.
    lua.global.set('base64', {
      encode: (value: string) => Buffer.from(value, 'latin1').toString('base64'),
      decode: (text: string) => Buffer.from(text, 'base64').toString('latin1'),
    });

    // Inject safe time helper for templates that need current time
    lua.global.set('get_time_iso', () => new Date().toISOString());

    // VFS require (LuaVfs): installs a sandboxed `require` resolving against
    // the given module map. MUST run before the strip block below — the
    // prelude captures the `load` builtin into a closure.
    if (opts.vfsFiles) {
      await lua.doString(vfsRequirePrelude(opts.vfsFiles));
    }

    // Always strip code-loading builtins regardless of sandbox level
    lua.global.set('loadfile', undefined);
    lua.global.set('dofile', undefined);
    lua.global.set('load', undefined);
    lua.global.set('loadstring', undefined);

    const cleanup = () => {
      lua.global.close();
    };

    return { lua, cleanup };
  }

  async run(
    lua: LuaEngine,
    script: string,
    signal?: AbortSignal,
  ): Promise<{ result: unknown; error?: string }> {
    try {
      if (signal?.aborted) {
        return { result: null, error: 'Script aborted' };
      }
      const result: unknown = await lua.doString(script);
      return { result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: null, error: message };
    }
  }
}

/**
 * Detects the WASM-abort family: wasmoon's instruction hook raises its timeout
 * error from C, where the non-string Error object makes lua_error surface it as
 * `RuntimeError: Aborted(native code called abort())`. There is no cleaner
 * signal to key on — match the message shape. (Rare false positives: anything
 * else that aborts the engine, e.g. WASM OOM, reads as a timeout too.)
 */
export function isLuaTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /Aborted\(native code called abort/.test(message);
}

/**
 * Model-facing message for a Lua failure. Deadline families in play:
 * - JS-side LuaTimeoutError ('thread timeout exceeded') from wasmoon's own
 *   yield-boundary checks — unreachable for doString child threads today,
 *   but mapped anyway should an upstream path ever surface it.
 * - The C-side instruction-hook abort (isLuaTimeoutError) — the armed wall
 *   ceiling passed mid-stretch; hard-killed, uncatchable in pcall.
 */
export function friendlyLuaError(err: unknown, timeoutMs: number): string {
  const secs = Math.round(timeoutMs / 1000);
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof LuaTimeoutError || /thread timeout exceeded/.test(message)) {
    return `script exceeded its ${secs}s time limit between host calls`;
  }
  if (isLuaTimeoutError(err)) return `script timed out (${secs}s execution limit)`;
  return message;
}
