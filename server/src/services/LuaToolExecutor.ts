/**
 * LuaToolExecutor – runs Lua tool templates.
 *
 * Each Lua template is a script that returns a table with:
 *   getDefinition() -> { stateKey, configSchema, tools: [{name, description, parameters, endsTurn?}] }
 *   execute(args, context, toolName) -> string | { content, extra? }
 *   serialize() -> string            (optional)
 *   deserialize(raw) -> nil          (optional)
 *
 * State is branch-aware: before execution the executor scans the
 * message history backwards looking for the newest `_toolState`
 * snapshot.  After execution it calls `serialize()` and stores the
 * returned string in the result `extra._toolState` so the next
 * generation on this branch can pick it up.
 *
 * The executor is the sole owner of the state protocol for Lua templates:
 * ToolRegistry's Lua wrapper uses no-op serialize/deserialize stubs, so the
 * real restore/persist happens here (each execution loads a fresh Lua state).
 * See services/toolState.ts for the shared helpers and the ownership split.
 */

import { randomUUID } from 'node:crypto';
import type { LuaRuntime, LuaRuntimeOptions } from '../scripting/LuaRuntime.js';
import { ScriptContext } from '../scripting/ScriptContext.js';
import { createToolStApi, type StApiDeps } from '../scripting/StApi.js';
import { str } from '../lib/coerce.js';
import { getLogger } from '../lib/logger.js';
import type { FileStorage } from './FileStorage.js';
import type { IAttachmentRepository } from '../repos/AttachmentRepository.js';
import type { ToolContext, ToolTemplateDefinition, ToolExecuteResult } from './ToolTemplate.js';
import { findLatestStateSnapshot, TOOL_STATE_KEY } from './toolState.js';

const log = getLogger('lua-tool-executor');

/** Media deps for the `attachments.create` global (allowFiles sandbox flag). */
export interface LuaToolMediaDeps {
  storage: FileStorage;
  attachments: IAttachmentRepository;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

interface LoadedTemplate {
  def: ToolTemplateDefinition;
  lua: import('wasmoon').LuaEngine;
  cleanup: () => void;
}

export class LuaToolExecutor {
  private stDeps?: Omit<StApiDeps, 'clientId'>;

  constructor(
    private luaRuntime: LuaRuntime,
    private media?: LuaToolMediaDeps,
  ) {}

  /**
   * Late-bound `st` API deps (allowSt sandbox flag). Set after the generation
   * service exists — the executor itself is constructed before it in main.ts.
   */
  setStDeps(deps: Omit<StApiDeps, 'clientId'>): void {
    this.stDeps = deps;
  }

  async getDefinition(code: string, sandbox?: LuaRuntimeOptions): Promise<ToolTemplateDefinition | { error: string }> {
    const loaded = await this.loadTemplate(code, sandbox);
    if ('error' in loaded) return loaded;
    loaded.cleanup();
    return loaded.def;
  }

  async execute(
    code: string,
    toolName: string,
    args: Record<string, unknown>,
    context?: ToolContext,
    sandbox?: LuaRuntimeOptions,
  ): Promise<ToolExecuteResult> {
    const loaded = await this.loadTemplate(code, sandbox);
    if ('error' in loaded) {
      return { content: loaded.error };
    }

    const { def, lua, cleanup } = loaded;
    const stateKey = def.stateKey || toolName;
    let drainSt: (() => Promise<void>) | null = null;

    try {
      const tt = lua.global.get('Tool') as Record<string, unknown> | undefined;
      if (!tt || typeof tt.execute !== 'function') {
        return { content: 'Lua tool must return a table with an execute function (assign to global "Tool")' };
      }

      // Inject the curated `st` API when the template opted in (allowSt) and a
      // chat context is available.
      drainSt = await this.maybeInjectSt(lua, context, sandbox);

      // 1. Restore state from branch history
      const stateSnapshot = findLatestStateSnapshot(stateKey, context?.messages);
      if (stateSnapshot !== undefined && typeof tt.deserialize === 'function') {
        try {
          await (tt.deserialize as (raw: string) => Promise<unknown>)(stateSnapshot);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Lua deserialize error: ${msg}` };
        }
      }

      // 2. Build Lua context table
      const luaContext: Record<string, unknown> = {};
      if (context?.chatId) {
        luaContext.chatId = context.chatId;
      }
      if (context?.config) {
        luaContext.config = context.config;
      }

      // 3. Run execute (passing toolName as 3rd arg). Two invocation paths:
      // - default: JS proxy call — the long-standing path, immune to a wasmoon
      //   pathology where doString-invoked heavy templates abort the engine.
      // - when the code awaits JS promises (':await(' or the QR-style
      //   'st.await(' helper): invoked via doString, because promise:await()
      //   cannot yield across a JS→Lua proxy call (wasmoon C-call boundary).
      //   The static check picks the FIRST path only — it is never wrong to
      //   take doString, but proxy-first for an awaiting template would run
      //   its pre-await side effects twice. A false negative (await hidden
      //   from the substring check) throws 'attempt to yield across a C-call
      //   boundary' from the proxy call; we catch that and retry via doString,
      //   which is strictly better than today's hard failure.
      let execResult: unknown;
      if (code.includes(':await(') || code.includes('.await(')) {
        const run = await this.runExecuteViaDoString(lua, args, luaContext, toolName);
        if (run.error) {
          return { content: `Lua execution error: ${run.error}` };
        }
        execResult = run.result;
      } else {
        try {
          execResult = await (tt.execute as (args: Record<string, unknown>, context: Record<string, unknown>, toolName: string) => Promise<unknown>)(args, luaContext, toolName);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('attempt to yield')) throw err;
          log.debug({ toolName }, 'Lua tool yielded across the proxy boundary; retrying via doString');
          const run = await this.runExecuteViaDoString(lua, args, luaContext, toolName);
          if (run.error) {
            return { content: `Lua execution error: ${run.error}` };
          }
          execResult = run.result;
        }
      }

      // 4. Serialize state
      let stateToStore: string | null = null;
      if (typeof tt.serialize === 'function') {
        try {
          const serialized = await (tt.serialize as () => Promise<unknown>)();
          if (serialized !== null && serialized !== undefined) {
            stateToStore = str(serialized);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Lua serialize error: ${msg}` };
        }
      }

      // 5. Build result
      let content: string | import('../backends/BackendAdapter.js').InlineContentPart[];
      let extra: Record<string, unknown> | undefined;
      if (typeof execResult === 'string') {
        content = execResult;
      } else if (execResult && typeof execResult === 'object') {
        const obj = execResult as Record<string, unknown>;
        if (Array.isArray(obj.content)) {
          content = obj.content as import('../backends/BackendAdapter.js').InlineContentPart[];
        } else {
          content = str(obj.content);
        }
        extra = obj.extra as Record<string, unknown> | undefined;
      } else {
        content = str(execResult);
      }

      const stateExtra: Record<string, unknown> = {};
      if (stateToStore !== null) {
        stateExtra[TOOL_STATE_KEY] = { [stateKey]: stateToStore };
      }

      return {
        content,
        extra: { ...extra, ...stateExtra },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Lua execution error: ${msg}` };
    } finally {
      // Let fire-and-forget async st.* calls settle before tearing down the
      // Lua state (10s cap, same policy as QuickReplyService).
      if (drainSt) await drainSt();
      cleanup();
    }
  }

  /** Invoke `Tool.execute` from inside a Lua coroutine (supports promise:await()). */
  private async runExecuteViaDoString(
    lua: import('wasmoon').LuaEngine,
    args: Record<string, unknown>,
    luaContext: Record<string, unknown>,
    toolName: string,
  ): Promise<{ result: unknown; error?: string }> {
    lua.global.set('__execArgs', args);
    lua.global.set('__execContext', luaContext);
    lua.global.set('__execToolName', toolName);
    return this.luaRuntime.run(lua, 'return Tool.execute(__execArgs, __execContext, __execToolName)');
  }

  /**
   * Inject the curated `st` API (createToolStApi) when the template opted in
   * via allowSt, deps are wired, and the execution context carries a chatId.
   * Returns a drain function for pending fire-and-forget promises, or null
   * when `st` is not available for this execution.
   */
  private async maybeInjectSt(
    lua: import('wasmoon').LuaEngine,
    context: ToolContext | undefined,
    sandbox: LuaRuntimeOptions | undefined,
  ): Promise<(() => Promise<void>) | null> {
    if (!sandbox?.allowSt || !this.stDeps || !context?.chatId) return null;

    // NOTE: no acquireLock() — the enclosing generation already holds the chat
    // lock; ctx.id is passed as the lockHolder token for nested calls.
    const ctx = new ScriptContext(context.chatId, this.stDeps.generationService);
    const api = createToolStApi(ctx, { ...this.stDeps, clientId: context.clientId ?? '' });

    const pendingPromises = new Set<Promise<unknown>>();
    lua.global.set('st', this.wrapStApi(api, pendingPromises));

    // Same Lua-side await shim as QuickReplyService.
    await lua.doString(`
      local rawSt = st
      st = {}
      setmetatable(st, { __index = rawSt })

      st.await = function(promise)
        return promise:await()
      end

      st.sleep = function(seconds)
        return st.await(rawSt.sleep(seconds))
      end

      st.generate = function(prompt, opts)
        return st.await(rawSt.generate(prompt, opts))
      end

      _G.st = st
    `);

    return async () => {
      await Promise.race([
        Promise.allSettled(Array.from(pendingPromises)),
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);
    };
  }

  /** Mirror of QuickReplyService's wrapApi: track async st.* promises so they can be drained before engine teardown. */
  private wrapStApi(obj: Record<string, unknown>, pendingPromises: Set<Promise<unknown>>): Record<string, unknown> {
    const wrapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'function') {
        wrapped[key] = (...args: unknown[]) => {
          const result = (value as (...args: unknown[]) => unknown)(...args);
          if (result instanceof Promise) {
            pendingPromises.add(result);
            result
              .catch((err) => log.warn({ err }, 'st API call from Lua tool failed'))
              .finally(() => pendingPromises.delete(result));
          }
          return result;
        };
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        wrapped[key] = this.wrapStApi(value as Record<string, unknown>, pendingPromises);
      } else {
        wrapped[key] = value;
      }
    }
    return wrapped;
  }

  private async loadTemplate(code: string, sandbox?: LuaRuntimeOptions): Promise<LoadedTemplate | { error: string }> {
    const { lua, cleanup } = await this.luaRuntime.createState(sandbox);
    try {
      // attachments.create — only for templates that opted into allowFiles, and
      // only when the server wired media deps (always in production).
      if (sandbox?.allowFiles && this.media) {
        const { storage, attachments } = this.media;
        lua.global.set('attachments', {
          create: async (base64Data: string, mimeType: string) => {
            if (typeof base64Data !== 'string' || typeof mimeType !== 'string' || !mimeType.includes('/')) {
              throw new Error('attachments.create: expected (base64Data: string, mimeType: string)');
            }
            const id = randomUUID();
            const ext = MIME_TO_EXT[mimeType] ?? 'bin';
            const filePath = storage.write('attachments', `${id}.${ext}`, Buffer.from(base64Data, 'base64'));
            const attachment = await attachments.create({ id, messageId: null, mimeType, filePath });
            return { id: attachment.id, url: attachment.url, mimeType: attachment.mimeType };
          },
        });
      }

      const result = await this.luaRuntime.run(lua, code);
      if (result.error) {
        cleanup();
        return { error: `Lua compilation error: ${result.error}` };
      }
      const toolTable: unknown = lua.global.get('Tool');
      if (!toolTable || typeof (toolTable as Record<string, unknown>).getDefinition !== 'function') {
        cleanup();
        return { error: 'Lua tool must return a table with a getDefinition function (assign to global "Tool")' };
      }
      const rawDef = await (toolTable as Record<string, unknown>).getDefinition as () => Promise<unknown>;
      const defResult = await rawDef();
      if (!defResult || typeof defResult !== 'object') {
        cleanup();
        return { error: 'getDefinition() must return a table' };
      }
      const d = defResult as Record<string, unknown>;

      const tools = (d.tools as Array<Record<string, unknown>> | undefined) ?? [];
      const parsedTools = tools.map((t) => ({
        name: str(t.name),
        description: str(t.description),
        parameters: (t.parameters as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
        endsTurn: t.endsTurn === true,
      }));

      return {
        def: {
          stateKey: str(d.stateKey),
          configSchema: (d.configSchema as Record<string, unknown> | undefined) ?? {},
          tools: parsedTools,
        },
        lua,
        cleanup,
      };
    } catch (err) {
      cleanup();
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
