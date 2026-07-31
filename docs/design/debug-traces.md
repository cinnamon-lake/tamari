# Debug Traces — Design Proposal

**Status:** implemented on `main` (structured error chains, `generations.meta` with debugPrompts-gated prompt snapshots, tool-result/dry-run/`/generations/<id>/` surfacing).
**Refinement:** records store only their own layer; the full chain is composed by walking `parent_id` at render time (`server/src/generation/trace.ts`) — a child's record is created while its parent is mid-run, so accumulated chains would capture incomplete state.
**Motivation:** with `MAX_AGENT_DEPTH = 4` and composable Lua backends, the failure chain *"Lua error in a delegate backend called by an agent called by a card backend"* is real — and currently undebuggable.

## Problem

A realistic chain today:

```
card contextual backend (Type B Lua) → writer backend
  └─ tool call: run_agent → sub-agent on custom Lua backend (Type A)
       └─ backends.generate → delegate backend → Lua error HERE
```

Every layer flattens errors into strings and returns them as *content*: the delegate's Lua error becomes `GenerationResult.error`, the sub-agent run returns `{ error }`, `run_agent` renders `"Agent error: …"` as tool-result text. The failure is recoverable (the model sees a string) but **undebuggable**: no layer attribution, no round detail, no record of which delegations happened before the failure. The generation-record tree (`kind`/`parent_id`) exists but each node carries only `error_message`.

Design goals:
1. Any failure answers *which layer died, with what input, after which delegations* — without log spelunking.
2. The model-author (the primary debugger of its own cards) gets traces through the channels it already reads: tool results and dry-runs.
3. Persist enough to reconstruct post-hoc; don't build a UI until we know what we look at.

## Piece 1: Structured error chains

Errors inside the generation flow become structured internally:

```ts
interface TraceError {
  code: 'LUA_ERROR' | 'LUA_TIMEOUT' | 'DELEGATE_ERROR' | 'NO_BACKEND'
      | 'DEPTH_CAP' | 'ABORTED' | 'HTTP_ERROR' | 'UNKNOWN';
  /** The layer that produced it: 'lua-backend(card:Goldie)',
      'custom-backend(research)', 'openai(gpt-4o)', 'run_agent', … */
  layer: string;
  message: string;
  cause?: TraceError;
}
```

Each boundary **wraps, never flattens**: `LuaBackendAdapter` catches a script error → `{ code: 'LUA_ERROR', layer: <adapter id>, message, cause }`; a delegate call failure → `DELEGATE_ERROR` with the inner error as `cause`; the sub-agent's failed run → `run_agent` receives the chain intact. `GenerationResult.error` stays a string (adapter contract unchanged) — the chain is *rendered* at the outermost surface:

```
run_agent → custom-backend(research) → delegate(openai/gpt-4o): LUA_ERROR: [string "lib/roll.lua"]:14: attempt to index nil
```

`GenerationResult` gains an optional `traceError?: TraceError` alongside the legacy string; both are written (string for compat, structure for traces). Lua errors keep wasmoon's `[string "<chunk>"]:line:` prefixes — chunk names are the VFS keys since the LuaVfs work, so the module is named in the message for free.

## Piece 2: `generations.meta` (migration 007)

One JSON column on the existing `generations` table — no per-round rows, no new table. Written by the runner per `run()`:

```json
{
  "kind": "subagent",
  "depth": 2,
  "rounds": 3,
  "toolCalls": [{ "name": "map_set_tile", "isError": false }, …],
  "delegateChain": ["custom-backend(research)", "openai(gpt-4o)"],
  "luaEntry": "main.lua",
  "luaModules": ["lib/roll.lua"],
  "traceError": { "code": "LUA_ERROR", "layer": "…", "message": "…", "cause": { … } }
}
```

- `delegateChain` accumulates across nested runs (parent's chain + own adapter id), so the record itself states its full ancestry beyond what `parent_id` links give structurally.
- **Prompt snapshots are captured when `debugPrompts` is enabled** (the existing setting that already gates `prompt.announced` broadcasts): the round-1 prompt (messages, tools, params, responseFormat) is stored under `meta.prompt`. This is inevitable for real debugging — but it's chat content and it balloons rows, so it rides the existing opt-in rather than becoming always-on. No API keys ever appear (prompts carry content, not secrets).
- `error_message` (existing column) keeps the rendered string; `meta.traceError` carries the structure.

## Piece 3: Surfacing

**Tool results (model-author's primary channel).** When a sub-agent run fails, `run_agent`'s tool result includes a compact trace instead of a bare string: rendered error chain + rounds + tool calls attempted + the failed delegation. Same when a nested tool call inside the sub-agent failed but the run recovered (as a `warnings` note, not an error). Success stays compact: final text, plus the trace id for reference.

**Dry-runs.** `backend_logic_test`'s outcome (which already returns `delegations[]`) gains `trace`: per-delegation layer, error chain if any, and the modules loaded. The recording delegate can be told to fail (`delegateResponse: { error }` already exists) so authors can test error paths explicitly.

**Workbench VFS (read-only).** `/generations/<id>/` — `meta.json` (the full record), `error.txt` (rendered chain), `prompt.json` (when captured). Trace ids appear in `run_agent` results and in the chat UI's generation records, so the no-discovery rule holds: the id always comes from context, `ls /generations/` refuses like every other collection. No `/chats/<id>/generations` listing this round.

**Human UI: deferred.** ~~The records are queryable; a viewer ships when we know what we actually look at.~~ ✅ **Shipped** — the chat header menu (⋮) has a **Generation traces** entry: a read-only, chat-scoped modal over `GET /api/chats/<id>/generations` (50 newest records) showing kind/backend/status/rounds/tool calls, sub-agent rows nested under their parent, expandable error chains (composed client-side from `meta.traceError`), and prompt snapshots when captured.

## Non-goals (this round)

- Per-round generation rows or a separate events table.
- ~~A chat-UI trace viewer.~~ ✅ Shipped (chat-scoped read-only modal). Cross-chat/global views and live updates remain non-goals.
- Workbench write access to traces (read-only, and traces are immutable anyway).
- Prompt capture without `debugPrompts`.

## Migration order

1. `TraceError` type + wrap-not-flatten at the boundaries (LuaBackendAdapter, delegate bridge, runner error paths, run_agent) + rendered strings.
2. Migration 007 (`generations.meta`) + runner writing meta per run (incl. `debugPrompts`-gated prompt snapshot).
3. Surfacing: run_agent result traces, dry-run trace, `/generations/<id>` VFS route.
4. Verification: unit tests per boundary (chain composition), harness test of the full depth-2 chain (card backend → run_agent → failing Lua backend) asserting the rendered chain and the meta records, migration test, e2e pass.

Steps 1–2 are the substance; step 3 is thin once they exist.
