/**
 * LuaBackendAdapter — a custom backend driven by a Lua script.
 *
 * The script defines `generate(prompt, ctx)` and optionally `list_models()`.
 * `prompt` is the fully-built Prompt (mutable copy) — the script may inspect,
 * rewrite, or rebuild it arbitrarily. Two output modes:
 *
 *   1. Blocking (full control, no token streaming):
 *        local res = backends.generate(prompt):await()   -- default delegate
 *        -- or backends.generate("<configId>", prompt)  -- explicit target
 *        return res.text                     -- a plain string, or
 *        return { text = res.text, usage = res.usage }   -- a table
 *
 *      A blocking return may also request tool execution:
 *        return { toolCalls = { { name = "speak", arguments = {...} } } }
 *      GenerationService's tool loop runs the calls and re-enters generate()
 *      with the tool results in the rebuilt prompt; the script recognizes such
 *      continuation rounds by inspecting the incoming messages. Optional
 *      per-call `id` (defaults to lua_call_<n>); `text` may accompany the calls.
 *
 *   2. Passthrough (native streaming, no output post-processing):
 *        return { __passthrough = true, prompt = prompt }   -- or a config id
 *      The adapter streams from the delegate backend itself, yielding real
 *      token chunks; the script's prompt edits still apply.
 *
 * `ctx` carries the call context: { chatId, characterId, generationType }.
 *
 * Delegation goes through the BackendDelegate, which resolves backend configs
 * BY ID (or the calling config's default delegate) and never exposes
 * credentials to Lua (principle 4 of docs/design/scriptable-layers.md).
 * Custom → custom chains are depth-capped by the factory that constructs
 * this adapter.
 *
 * Error contract: any Lua or delegation failure becomes
 * `GenerationResult { finishReason: 'error', error }` — a script that returns
 * nothing usable is an error, never a silent empty reply.
 */

import type { LuaRuntime } from '../scripting/LuaRuntime.js';
import { isLuaTimeoutError } from '../scripting/LuaRuntime.js';
import type {
  BackendAdapter,
  BackendCallContext,
  BackendStreamItem,
  BranchHistoryMessage,
  GenerationResult,
  Prompt,
  ToolCall,
} from './BackendAdapter.js';
import { consumeStream } from './BackendAdapter.js';
import type { TraceError } from './BackendAdapter.js';
import { renderTraceError } from '../generation/trace.js';
import { str } from '../lib/coerce.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('lua-backend');

/** Simulator backends may legitimately run for minutes across sub-generations. */
const LUA_GENERATE_TIMEOUT_MS = 10 * 60 * 1000;
const LUA_LIST_MODELS_TIMEOUT_MS = 10 * 1000;

export interface DelegatedGenerateResult {
  text: string;
  reasoning?: string;
  finishReason: GenerationResult['finishReason'];
  error?: string;
  usage: { promptTokens: number; completionTokens: number };
  /** Structured error chain from the delegate (propagated, never re-wrapped). */
  traceError?: TraceError;
  /** Tool calls the delegate wants to make (surfaced so scripts can run their own tool loop). */
  toolCalls?: ToolCall[];
}

/**
 * Credential-safe delegation surface injected into Lua as the `backends`
 * global. Implemented by the custom-backend factory (which knows the backend
 * config registry and the resolved-adapter factory).
 *
 * A null `configId` means "the calling config's default delegate"
 * (`providerParams.delegateConfigId`).
 */
export interface CustomBackendDelegate {
  /** Run a full generation against a backend config, consuming the stream. */
  generate(configId: string | null, prompt: Prompt, signal: AbortSignal, ctx?: BackendCallContext): Promise<DelegatedGenerateResult>;
  /** Resolve a backend config to an adapter for native passthrough streaming. */
  resolveAdapter(configId: string | null): Promise<BackendAdapter>;
}

export interface LuaBackendAdapterConfig {
  id: string;
  name: string;
  luaSource: string;
  runtime: LuaRuntime;
  delegate: CustomBackendDelegate;
  /** Card VFS module map for the sandboxed `require` (generate() only;
      list_models() states don't get it, matching the absent backends global). */
  vfsFiles?: Record<string, string>;
  /** Execution limit for generate(); defaults to LUA_GENERATE_TIMEOUT_MS (10 min). Tests override. */
  generateTimeoutMs?: number;
}

const EMPTY_USAGE = { promptTokens: 0, completionTokens: 0 };

function errorResult(error: string, usage = EMPTY_USAGE, traceError?: TraceError): GenerationResult {
  return { finishReason: 'error', usage, error, traceError };
}

/**
 * Normalize a Lua-returned `toolCalls` table into ToolCall[]. wasmoon may hand
 * back a Lua array as a JS array OR as an object with numeric string keys, so
 * accept both. Entries without a string `name` are skipped; missing ids get a
 * positional default; missing/non-table `arguments` become {}.
 */
function parseLuaToolCalls(value: unknown): ToolCall[] {
  let entries: unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0 || !keys.every((k) => /^\d+$/.test(k))) return [];
    entries = keys
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => (value as Record<string, unknown>)[k]);
  } else {
    return [];
  }
  const out: ToolCall[] = [];
  for (const [i, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e['name'] !== 'string' || e['name'].length === 0) continue;
    out.push({
      id: typeof e['id'] === 'string' && e['id'].length > 0 ? e['id'] : `lua_call_${i + 1}`,
      name: e['name'],
      arguments:
        e['arguments'] && typeof e['arguments'] === 'object' && !Array.isArray(e['arguments'])
          ? (e['arguments'] as Record<string, unknown>)
          : {},
    });
  }
  return out;
}

/**
 * Serialize plain JSON-compatible data as a Lua table literal. Prompt/ctx are
 * injected this way (not via global.set) so every value inside the VM is a
 * NATIVE Lua value — wasmoon JS-object proxies misbehave under GC pressure in
 * string-heavy scripts (gsub on proxy-backed strings panics the engine).
 */
export function toLuaLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'nil';
  if (typeof value === 'string') {
    return (
      '"' +
      value.replace(/[\\"\n\r]/g, (ch) => {
        switch (ch) {
          case '\\': return '\\\\';
          case '"': return '\\"';
          case '\n': return '\\n';
          case '\r': return '\\r';
          default: return ch;
        }
      }) +
      '"'
    );
  }
  if (Array.isArray(value)) {
    return '{ ' + value.map((v) => toLuaLiteral(v)).join(', ') + ' }';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `[${toLuaLiteral(k)}] = ${toLuaLiteral(v)}`,
    );
    return '{ ' + entries.join(', ') + ' }';
  }
  return 'nil';
}

/**
 * Script ergonomics: accept `response_format` (snake_case) on prompt tables
 * handed back to JS and rename it to `responseFormat`. camelCase still wins
 * when both are present. No validation — adapters that support structured
 * output already map it; the rest ignore it.
 */
function normalizeResponseFormat(prompt: Prompt): Prompt {
  const p = prompt as unknown as Record<string, unknown>;
  if (p['responseFormat'] === undefined && p['response_format'] !== undefined) {
    const { response_format: _ignored, ...rest } = p;
    return { ...(rest as unknown as Prompt), responseFormat: p['response_format'] as Prompt['responseFormat'] };
  }
  return prompt;
}

export class LuaBackendAdapter implements BackendAdapter {
  readonly id: string;
  readonly name: string;
  readonly supportsStreaming = true;
  /**
   * False = we never advertise tool schemas in the prompt (the script owns the
   * turn and decides everything itself). A script may still RETURN tool calls
   * (`{ toolCalls = {...} }`) — GenerationService's tool loop executes any
   * adapter's `result.toolCalls`, and the follow-up round re-enters generate()
   * with the tool results in the rebuilt prompt.
   */
  readonly supportsTools = false;

  private readonly luaSource: string;
  private readonly runtime: LuaRuntime;
  private readonly delegate: CustomBackendDelegate;
  private readonly vfsFiles: Record<string, string> | undefined;
  private readonly generateTimeoutMs: number;
  private modulesLoaded: string[] = [];

  constructor(config: LuaBackendAdapterConfig) {
    this.id = config.id;
    this.name = config.name;
    this.luaSource = config.luaSource;
    this.runtime = config.runtime;
    this.delegate = config.delegate;
    this.vfsFiles = config.vfsFiles;
    this.generateTimeoutMs = config.generateTimeoutMs ?? LUA_GENERATE_TIMEOUT_MS;
  }

  /** VFS module keys the last generate() actually loaded (dry-run traces). */
  getLoadedModules(): string[] {
    return this.modulesLoaded;
  }

  async *stream(
    prompt: Prompt,
    signal: AbortSignal,
    ctx?: BackendCallContext,
  ): AsyncGenerator<BackendStreamItem, GenerationResult> {
    const { lua, cleanup } = await this.runtime.createState({ allowNet: true, vfsFiles: this.vfsFiles }, this.generateTimeoutMs);
    try {
      // Track delegated usage so scripts that don't report usage still account tokens.
      let delegatedUsage = { promptTokens: 0, completionTokens: 0 };
      const backendsGlobal = {
        generate: async (arg1: unknown, arg2: unknown): Promise<DelegatedGenerateResult> => {
          // Two call shapes: generate(prompt) — default delegate; or
          // generate("<configId>", prompt) — explicit target by config id.
          const configId = typeof arg1 === 'string' ? arg1 : null;
          const promptArg = normalizeResponseFormat((typeof arg1 === 'string' ? arg2 : arg1) as Prompt);
          const result = await this.delegate.generate(configId, promptArg, signal, ctx);
          delegatedUsage = {
            promptTokens: delegatedUsage.promptTokens + result.usage.promptTokens,
            completionTokens: delegatedUsage.completionTokens + result.usage.completionTokens,
          };
          // Errors are first-class (scriptable-layers.md §2): a failed delegation
          // with no usable text throws into Lua — scripts that want to inspect or
          // recover from backend errors can pcall. Never degrade to a silent
          // empty reply. The thrown message is the rendered trace chain: this
          // delegation node wraps the delegate's structured error (when the
          // delegate is itself a layered backend) as its cause.
          if (result.error && result.text.length === 0) {
            const chain: TraceError = {
              code: 'DELEGATE_ERROR',
              layer: `delegate(${configId ?? 'default'})`,
              message: result.error,
              cause: result.traceError,
            };
            throw new Error(renderTraceError(chain));
          }
          return result;
        },
      };

      // Inject prompt/ctx as Lua table literals so every value inside the VM
      // is a NATIVE Lua value — wasmoon JS-object proxies misbehave under GC
      // pressure in string-heavy scripts (gsub on proxy-backed strings panics
      // the engine), and card scripts live on string ops.
      lua.global.set('backends', backendsGlobal);

      // The `chat` global: FULL branch history (unbudgeted — unlike
      // prompt.messages, which is capped by promptHistoryLimit/chatTruncation
      // and the token budget). Lazy: the branch loads at most once per turn,
      // and only when the script actually calls chat.* — this is the recall
      // source for scripts that compress the delegate's view of history.
      // Absent entirely when the generation has no branch (scripts must
      // branch on `if chat then ... end`).
      if (ctx?.branchHistory) {
        const load = ctx.branchHistory;
        let memo: Promise<BranchHistoryMessage[]> | undefined;
        const branch = () => (memo ??= load());
        lua.global.set('chat', {
          count: async () => (await branch()).length,
          get: async (index: unknown) => {
            const i = typeof index === 'number' ? Math.floor(index) : NaN;
            const messages = await branch();
            if (i < 1 || i > messages.length) return undefined; // Lua nil
            return messages[i - 1];
          },
          find: async (query: unknown, limit: unknown) => {
            const q = typeof query === 'string' ? query.toLowerCase() : '';
            if (!q) return [];
            const cap = Math.min(typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 10, 50);
            const messages = await branch();
            const out: Array<{ index: number; id: string; role: string; content: string }> = [];
            for (let i = messages.length - 1; i >= 0 && out.length < cap; i--) {
              const m = messages[i]!;
              if (m.content.toLowerCase().includes(q)) {
                out.push({ index: i + 1, id: m.id, role: m.role, content: m.content });
              }
            }
            return out;
          },
        });
      }

      await lua.doString(
        `__prompt = ${toLuaLiteral(prompt)}\n__ctx = ${toLuaLiteral({
          chatId: ctx?.chatId ?? null,
          characterId: ctx?.characterId ?? null,
          generationType: ctx?.generationType ?? 'normal',
        })}`,
      );

      // Define generate() / list_models(), then invoke generate inside the VM
      // (doString handles scripts that :await() JS promises; direct proxy calls
      // across the await boundary are unreliable — see LuaToolExecutor).
      await lua.doString(this.luaSource);
      if (typeof lua.global.get('generate') !== 'function') {
        return errorResult(`custom backend "${this.name}" does not define generate(prompt, ctx)`, EMPTY_USAGE, {
          code: 'LUA_ERROR',
          layer: this.name,
          message: 'does not define generate(prompt, ctx)',
        });
      }

      // Branch-aware script state (the lua_memory / tool-template protocol):
      // restore the newest snapshot as the `state` global — via the script's
      // own deserialize(raw) when defined, else json.decode into `state`.
      if (ctx?.scriptState) {
        await lua.doString(`
          if type(deserialize) == "function" then
            deserialize(${toLuaLiteral(ctx.scriptState)})
          else
            local ok, decoded = pcall(json.decode, ${toLuaLiteral(ctx.scriptState)})
            if ok and type(decoded) == "table" then state = decoded else state = {} end
          end
        `);
      }

      const raw: unknown = await lua.doString('return generate(__prompt, __ctx)');

      // Capture state for persistence (only on success paths; a failed turn
      // must not corrupt the last good snapshot). Scripts that never touch
      // `state` produce no snapshot.
      const captureScriptState = async (): Promise<string | undefined> => {
        try {
          if (typeof lua.global.get('serialize') === 'function') {
            const raw: unknown = await lua.doString('return serialize()');
            return typeof raw === 'string' ? raw : jsonEncodeFallback(raw);
          }
          if (lua.global.get('state') !== undefined && lua.global.get('state') !== null) {
            const encoded: unknown = await lua.doString('return json.encode(state)');
            return typeof encoded === 'string' ? encoded : undefined;
          }
          return undefined;
        } catch (err) {
          log.warn({ err, backend: this.name }, 'script state capture failed, state not persisted');
          return undefined;
        }
      };
      const jsonEncodeFallback = (value: unknown): string | undefined => {
        try {
          return JSON.stringify(value);
        } catch {
          return undefined;
        }
      };

      // ---- Passthrough mode: native streaming from the delegate ----
      if (
        raw &&
        typeof raw === 'object' &&
        ((raw as Record<string, unknown>)['__passthrough'] === true ||
          typeof (raw as Record<string, unknown>)['__passthrough'] === 'string')
      ) {
        const pt = (raw as Record<string, unknown>)['__passthrough'];
        const configId = pt === true ? null : String(pt);
        const passthroughPrompt = normalizeResponseFormat(((raw as Record<string, unknown>)['prompt'] ?? prompt) as Prompt);
        let adapter: BackendAdapter;
        try {
          adapter = await this.delegate.resolveAdapter(configId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(`passthrough: ${message}`, EMPTY_USAGE, {
            code: 'DELEGATE_ERROR',
            layer: this.name,
            message: `passthrough: ${message}`,
          });
        }
        const stream = adapter.stream(passthroughPrompt, signal, ctx);
        let next = await stream.next();
        while (!next.done) {
          yield next.value;
          next = await stream.next();
        }
        const passthroughResult = next.value;
        const scriptState = passthroughResult.error ? undefined : await captureScriptState();
        return { ...passthroughResult, scriptState: scriptState ?? passthroughResult.scriptState };
      }

      // ---- Blocking mode: string or { text?, reasoning?, usage?, toolCalls? } ----
      let text: string | null = null;
      let reasoning: string | undefined;
      let toolCalls: ToolCall[] | undefined;
      let usage = delegatedUsage;
      if (typeof raw === 'string') {
        text = raw;
      } else if (raw && typeof raw === 'object') {
        const table = raw as Record<string, unknown>;
        if (typeof table['text'] === 'string') text = table['text'];
        if (typeof table['reasoning'] === 'string') reasoning = table['reasoning'];
        const u = table['usage'] as Record<string, unknown> | undefined;
        if (u && typeof u['promptTokens'] === 'number' && typeof u['completionTokens'] === 'number') {
          usage = { promptTokens: u['promptTokens'], completionTokens: u['completionTokens'] };
        }
        // Tool-call requests: the script asks GenerationService's tool loop to
        // execute registered tools (speak, forge_image, ...) and re-enter
        // generate() with the results in the rebuilt prompt. The script detects
        // such continuation rounds by inspecting the incoming messages.
        const parsedCalls = parseLuaToolCalls(table['toolCalls']);
        if (parsedCalls.length > 0) toolCalls = parsedCalls;
        if (typeof table['error'] === 'string' && table['error'].length > 0) {
          return errorResult(table['error'], usage, { code: 'UNKNOWN', layer: this.name, message: table['error'] });
        }
      }

      if (text === null && !toolCalls) {
        const message = `custom backend "${this.name}": generate() must return a string, { text = ... }, { toolCalls = ... }, or { __passthrough = ... } (got ${raw === null ? 'nil' : typeof raw})`;
        return errorResult(message, usage, { code: 'LUA_ERROR', layer: this.name, message });
      }

      if (reasoning) yield { type: 'reasoning', token: reasoning };
      if (text !== null && text.length > 0) yield { type: 'text', token: text };
      return {
        finishReason: 'stop',
        usage,
        reasoningText: reasoning,
        toolCalls,
        scriptState: await captureScriptState(),
      };
    } catch (err) {
      const timeout = isLuaTimeoutError(err);
      const message = timeout
        ? `script timed out (${Math.round(this.generateTimeoutMs / 1000)}s execution limit)`
        : err instanceof Error
          ? err.message
          : String(err);
      log.warn({ err, backend: this.name }, 'custom backend generate failed');
      return errorResult(`custom backend "${this.name}": ${message}`, EMPTY_USAGE, {
        code: timeout ? 'LUA_TIMEOUT' : 'LUA_ERROR',
        layer: this.name,
        message,
      });
    } finally {
      // Read back which VFS modules the script actually required (the prelude
      // tracks them in a Lua global) — before the state is torn down.
      const loaded: unknown = lua.global.get('__vfsModulesLoaded');
      this.modulesLoaded = Array.isArray(loaded) ? loaded.filter((k): k is string => typeof k === 'string') : [];
      cleanup();
    }
  }

  async listModels(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
    const { lua, cleanup } = await this.runtime.createState({}, LUA_LIST_MODELS_TIMEOUT_MS);
    try {
      await lua.doString(this.luaSource);
      if (typeof lua.global.get('list_models') !== 'function') return [];
      const raw: unknown = await lua.doString('return list_models()');
      if (signal?.aborted) return [];
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .map((m) => ({ id: str(m['id']), name: str(m['name'] ?? m['id']) }))
        .filter((m) => m.id.length > 0);
    } catch (err) {
      log.warn({ err, backend: this.name }, 'custom backend list_models failed');
      return [];
    } finally {
      cleanup();
    }
  }
}

/** Helper for delegate implementations: run an adapter to completion, non-streaming. */
export async function runAdapterBlocking(
  adapter: BackendAdapter,
  prompt: Prompt,
  signal: AbortSignal,
  ctx?: BackendCallContext,
): Promise<DelegatedGenerateResult> {
  const { items, result } = await consumeStream(adapter.stream(prompt, signal, ctx));
  const text = items
    .filter((i): i is Extract<BackendStreamItem, { type: 'text' }> => i.type === 'text')
    .map((i) => i.token)
    .join('');
  return {
    text: result.error ? '' : text,
    reasoning: result.reasoningText,
    finishReason: result.finishReason,
    error: result.error,
    usage: result.usage,
    // Propagate the delegate's structured chain as-is — never re-wrap here;
    // the delegating adapter wraps it as DELEGATE_ERROR cause at the bridge.
    traceError: result.traceError,
    ...(result.toolCalls && result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
  };
}
