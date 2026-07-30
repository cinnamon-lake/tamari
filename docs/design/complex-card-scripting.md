# Complex Card Scripting — Design Proposal

**Status:** implemented on `main` (all three pillars: card VFS + sandboxed `require`, Workbench `backend_logic/` directory, `response_format` ergonomics + `json.parse_result`). Trace/debug surface remains deferred.
**Goal:** let models author cards with genuinely complicated scripting. Two pillars: multi-file `backend_logic`, and structured output (`response_format`) that scripts can actually use. Trace/debug surface is acknowledged but deferred.

## Background

- `backend_logic.lua` (card-coupled contextual backend, scriptable-layers.md §2 Type B) is a single string at `extensions.contextualBackend.luaSource`. The sandbox disables `require` outright (`LuaRuntime.ts:76`).
- `Prompt.responseFormat` exists and is honored by the OpenAI/Claude/Gemini adapters — but nothing in the app sets it, and Lua backends can neither see nor request it.
- The **Workbench tool** is the LLM's authoring surface: one VFS (`ls`/`read`/`write`/`rm`) routed by path, with per-domain routes (characters, backends, customBackends, toolsets, quickReplies, luaTools) delegating to provider classes. A card's script is currently exposed as the single file `/characters/<id>/backend_logic.lua`; the dry-run verb is `backend_logic_test`.

## Pillar 1: Card VFS + sandboxed `require`

**Storage: an s3-style KV filesystem in card extensions.** `extensions.contextualBackend.files: { [path: string]: string }` — keys are slash-separated paths (`lib/utils.lua`), values are Lua source. Rides the card JSON, so PNG/CharX export and import carry it automatically (extensions already deep-copy on clone/export). No new repository, no asset records.

**Entry point stays `luaSource`.** No data migration: the existing single-blob script keeps working unchanged. `require` pulls from `files`; a script that never calls `require` is exactly today's behavior.

**Require semantics:**
- `require('lib/utils')` resolves to `files['lib/utils.lua']` — strip leading `./`, append `.lua` if absent, no `..`, no leading `/`, Lua identifiers + `-`/`_` per segment.
- Modules are standard Lua: the chunk's return value is the module; `module = true` semantics. Circular requires throw a named error.
- Cache per runtime invocation (one card generation = one module cache) — no cross-generation state leakage beyond the existing scriptState channel.
- Resolution is against the card VFS ONLY. The filesystem is never touched; `require` stays disabled for anything the VFS doesn't contain (no fallback to Lua's package path).

**One mechanism, scoped per surface.** The resolver is built once (`scripting/LuaVfs.ts`) over a `Record<string, string>` source map. backend_logic uses the card's `files` map; Lua tool templates and quick replies can adopt the same resolver later over their own scopes — no filesystem variant ever.

## Pillar 2: The Workbench VFS exposes the files

The LLM's authoring surface is the **Workbench tool** — one VFS (`ls`/`read`/`write`/`rm`) routed by path (`server/src/services/templates/workbench/`), whose per-domain routes delegate to the `services/workbench/*Workbench.ts` providers. A card's script already appears as the single file `/characters/<id>/backend_logic.lua`. Multi-file turns that file into a directory backed by the `files` KV:

- `/characters/<id>/backend_logic/main.lua` — the entry point (maps to `luaSource`; reads/writes go through `backend_logic_set`, which preserves the `enabled` flag and load-validates, same as today).
- `/characters/<id>/backend_logic/<path>` — modules (maps to `files[path]`), with the require path rules enforced on write.
- The legacy single-file path `/characters/<id>/backend_logic.lua` keeps working as an alias for `main.lua` (existing scripts and prompts that reference it don't break).
- `ls` on the card dir shows `backend_logic/` when the script is enabled or any file exists; `ls` inside it lists modules. No new verb family, no new tool — just route expansion.
- `backend_logic_test` (the CharacterWorkbench dry-run verb) runs the full set: entry + `files` visible to `require`, so the dry-run tests what generation will run.

Human editing (character editor textarea) stays as-is for now; a file-tab editor is a possible later UI, not part of this.

## Pillar 3: Structured output for scripts

**See it:** the Lua-facing prompt table gains `response_format` (the `Prompt.responseFormat` value: `{type:'json_schema', schema}` / `{type:'json_object'}` / `{type:'text'}`), so a contextual backend can inspect what was requested.

**Request it:** scripts delegating to the writer backend can pass `response_format` on the delegate call (the Lua delegate API — the one LuaBackendAdapter exposes for blocking/passthrough calls — accepts it and maps it onto the outgoing `Prompt`). Adapters that support it map it (already done); adapters that don't ignore it silently. It is a hint, never a guarantee.

**Consume it:** no adapter-level schema validation and no magic retries — reverse proxies and local backends will emit garbage, and the script is the right place to handle that. The Lua `json` module gains a result-style parse:

```lua
local res = json.parse_result(text)
-- success: { value = <decoded> }
-- failure: { error = "expected value at line 1 column 4" }
```

Rust-style envelope: callers pattern-match on `res.error` / `res.value`; `json.parse` keeps its current throw-on-garbage behavior for scripts that want the exception.

## Explicit non-goals (this round)

- Sub-agent trace/debug surface (deferred; generation records already form the tree).
- Multi-file for Lua tool templates / quick replies (the resolver is built to accept their scopes later, but no verbs/UI this round).
- File-tab human editor for backend_logic.
- Adapter-level schema validation or retry loops.

## Migration order

1. `LuaVfs` resolver + `require` wiring into the sandbox + card `files` storage (backwards-compatible: `luaSource` untouched).
2. Workbench `backend_file_*` verbs + multi-file `backend_logic_test`.
3. `response_format` in the Lua prompt contract + delegate calls + `json.parse_result`.

Each step is independently shippable and tested; step 1 unblocks nothing else but is the largest.
