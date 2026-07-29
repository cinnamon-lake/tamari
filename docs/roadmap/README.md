# tamari Refactoring Roadmap

> **Goal**: Transform tamari into a clean single-user architecture where the server owns state, persistence, and inference, and clients are thin, reactive UIs connected via a real-time event bus.
>
> **Non-goals**: Multi-user SaaS, horizontal scaling, cloud deployment, Electron compatibility.

## Principles

1. Server is the single source of truth.
2. Client is thin — it renders state and captures input, nothing more.
3. All connected devices see the same state in real time (event bus).
4. TypeScript everywhere, strict mode.
5. SQLite3 for persistence.
6. If something lives on both client and server, it needs a written justification.
7. **Never validate API key formats** (length, prefix, etc.). Users run reverse proxies, local backends, and custom auth schemes. Format checks break legitimate setups with no benefit.

---

## Quick Links

- **[Breaking Changes](breaking-changes.md)** — What breaks, why we broke it, and how users migrate.
- **[Pending Features](pending-features.md)** — Remaining features to port from SillyTavern, categorized by priority and complexity.
- **[Completed Work](completed.md)** — High-level summary of finished foundation work.
- **[Intentionally Omitted](breaking-changes.md#what-we-are-explicitly-not-porting)** — Features we have deliberately decided not to port.

---

## Current Status (July 2026)

The architectural foundation is **solid and operational**. All foundation phases (0–2) are complete. Phase 3 (Feature Port) is well underway — the vast majority of core user-facing features are implemented.

**Recently landed:**
- Security audit — shared-secret auth, CSP, origin validation, path traversal fixes, Lua sandbox hardening, SSRF mitigation
- Global message pool — `chat_id` dropped from `messages`; reachability via `parent_id` chains from `chats.active_child_id`
- Migration chain squashed — all internal migrations consolidated into `001_init.sql` (with `002_add_chat_materialized.sql` added later for the chat-materialized view)
- RAG scaffold — vectra-based vector store, OpenAI-compatible embedding client, semantic retrieval for World Info entries
- Universal Lua request transformer — available on **all** backend adapters
- Backend adapter model listing — live `/models` for all adapters
- Character card V3 — `ccv3` PNG chunk, CharX ZIP import/export, asset storage & serving, embedded URI resolution in chat
- Active Entity pattern — characters, personas, world info, presets all follow snapshot flow
- Personas coupled to chats — `persona_id` on `chats` table
- In-chat message search, popup system parity, tag filters & sorting
- Post-processing filters — `singleLine`, `trimSentences`, `autoFixGeneratedMarkdown`, `removeXML`, plus unified `whitespaceMode` (`none` / `essential` / `full`)
- Design tokens, theming, backgrounds, custom CSS, chat/avatar display styles
- **Lua `st` API expansion** — `send_as`, `send_narrator`, `comment`, `trigger`, `branch`, `checkpoint`, `hard_fork`, `delay`, `set_author_note`, `get_backend_configs`, `set_backend_config`, `set_model`, `set_backend`, `token_count`, `trim_tokens`, `json_encode`, `json_decode`, and 50+ more functions for near-complete SillyTavern slash-command parity
- **TTS infrastructure** — `/api/tts` endpoint with adapter factory; FishAudio S2 and Kokoro FastAPI providers implemented
- **AGENTS.md compliance** — Canonical URL enrichment (`export_url`, `charx_url`, `avatar_upload_url`, `jsonl_export_url`, `txt_export_url`) replaces all heuristic URL construction in client
- **Auto-save migration** — `AuthorsNotePanel` and `PersonaManager` converted from manual Save buttons to debounced auto-save (600ms) with Saved indicators
- **`/wi` slash command + Lua API** — `wi_list`, `wi_get`, `wi_add`, `wi_remove` in `st` API; client `/wi list/get/add/del` subcommands
- **Checkpoints UI** — `CheckpointsPanel` modal in `ChatHeader` for creating, browsing, restoring, and deleting chat checkpoints
- **Template-based Tool Architecture** — Replaced monolithic `tool_instances` with `ToolTemplate` interface (built-in + Lua), `Toolset` user instances with per-tool overrides, branch-aware state via `serialize()` / `deserialize()`, and unified `ToolsModal` UI with inline auto-save
- **Memory / Summarization** — `MemoryService` rolling-summary anchored to a user message, branch-aware, with `[msg:ID]` citations stored in `extra.memory`; a `memory` tool template (`memory_get_raw`, `memory_summarize_range`) exposes retrieval to the LLM
- **Expanded instruct templates** — 33 built-in templates now ship (Mistral Nemo/Large 2411/V3, Llama 4, Gemma 4, Nemotron 3, Phi-4, Granite, MiniMax, etc.) with normal + thinking variants
- **Backend configs** — Reusable named connection profiles (`BackendConfigModal` + `backend_configs` table) with live model listing, replacing the cancelled Connection Manager extension
- **Internationalization (i18n)** — `@solid-primitives/i18n` provider + `useI18n()` (first Solid Context in the client); English extracted across all 34 components into per-domain fragments (~600 keys); language persisted in `AppSettings.language` with hot-switch (no reload) + `<html lang>`; Language picker in Settings. Only `en` ships — non-English locale selection/translation is the remaining step (drop-in: a `locales/<code>.ts` + `REGISTRY` entry).

**Remaining work** is overwhelmingly *user-facing feature surface* (TTS providers, Stable Diffusion, advanced World Info features, mobile polish, macro parity, thumbnail generation, content seeding) rather than architectural unknowns.

### Foundation Checklist

| Item | Status |
|---|---|
| SQLite3 with WAL mode, migrations, one-time SillyTavern import | ✅ |
| Tree-structured messages (`parent_id`) for swipes and branches | ✅ |
| WebSocket event bus with snapshot replay and multi-tab sync | ✅ |
| Server-side prompt pipeline (`PromptBuilder`, `PromptManager`, `MacroResolver`, `WorldInfoInjector`, renderers) | ✅ |
| Backend adapters: OpenAI, OpenRouter, Claude, Gemini, llama.cpp, TabbyAPI (via Text Completion), KoboldCPP, Text Completion, Moonshot | ✅ |
| SolidJS thin client with message pagination, markdown rendering, reactive stores | ✅ |
| Basic CRUD for characters, chats, world info, personas, presets | ✅ |
| Group chat backend with activation strategies | ✅ |
| Quick Reply (Lua scripting engine) — server-side `wasmoon` runtime, `st` API with ~80 functions, atomic chat-locking execution | ✅ |
| Virtual greeting materialization | ✅ |
| Backend format parity — OpenRouter, Claude, Gemini tool/reasoning/vision formatting | ✅ |
| Claude prompt caching — auto depth, non-deterministic macro guard | ✅ |
| World Info at-depth injection + recursive activation | ✅ |
| Per-preset connection config | ✅ |
| Universal Lua request transformer | ✅ |
| Backend adapter model listing | ✅ |
| Character card V3 (core fields, assets, CharX) | ✅ |
| Security audit (auth, CSP, origin, path traversal, Lua sandbox, SSRF, ReDoS, SQL injection, request-body scrubbing) | ✅ |
| Template-based tool architecture (built-in + Lua templates, toolsets, branch-aware state) | ✅ |

---

## Intentional Architectural Breaks

These are **deliberate, permanent changes** that improve the codebase. They are not temporary regressions.

| Decision | Old Way | New Way | Why |
|---|---|---|---|
| **Story string templates** | Separate `renderStoryString` system for text-completion APIs | `PromptManager` + `TextCompletionRenderer` use the same `PromptCollection` for all APIs | One prompt assembly pipeline, less code, no divergence between chat and text modes |
| **SillyTavern system prompt presets** | Parallel `sysprompt.js` preset system alongside instruct mode | System prompt is the `main` prompt slot in `PromptManager`, overridable per-character | Eliminates a redundant preset system that confused users |
| **Client-side macro engine** | Regex-based substitution in `substituteParams()`, client-side only | Server-side `MacroResolver.ts` with typed, pluggable handlers and block control structures | Macros must resolve before WI scanning and prompt building; server-side is the only place with full context |
| **jQuery + global mutable state** | `chat[]`, `characters[]`, direct DOM manipulation | SolidJS reactive stores + WebSocket sync | Enables multi-tab sync, testability, and eliminates an entire class of sync bugs |
| **Flat-file persistence** | JSON/JSONL/PNG metadata in `data/` | SQLite3 with relational schema and migrations | Enables search, aggregation, transactions, and prevents data corruption from partial writes |
| **Theme system** | JSON themes targeting `--SmartTheme*` CSS variables and DOM selectors | CSS custom properties (design tokens) with semantic naming | Stable theming API that survives DOM refactors; old themes will need migration |
| **Extension API** | Direct DOM access, global vars, jQuery plugins | Server-side hooks + client-side renderer plugins in designated slots | Extensions can't break the UI or leak memory; server extensions can access DB and HTTP |
| **Post-processing filters** | Individual toggles for `collapseNewlines`, `trimSpaces`, etc. | Unified `whitespaceMode` enum (`none` / `essential` / `full`) | Simpler UI; `essential` trims leading/trailing whitespace, `full` also collapses internal whitespace and normalizes newlines |

See [Breaking Changes](breaking-changes.md) for the full migration guide.

---

## Technology Stack

| Layer | Old | New |
|---|---|---|
| Server language | JavaScript (ES modules) | TypeScript (strict) |
| Server framework | Express | Express + `ws` |
| Database | Flat files (JSON/JSONL) | SQLite3 (`@libsql/client`) |
| Client framework | Vanilla JS + jQuery | SolidJS |
| Client bundler | Webpack (libs only) | Vite |
| Styling | jQuery UI + custom CSS + inline | CSS custom properties + Tailwind |
| State sync | Ad-hoc REST POST | WebSocket event bus |
| Testing | Jest (backend only) | Vitest (monorepo — **619 type-safe client tests across 52 files**, all pass `tsc --noEmit`) |
| API validation | None | Zod |
| Package manager | npm | npm workspaces |

---

## Roadmap Phases (Condensed)

| Phase | Focus | Status |
|---|---|---|
| 0 | Foundation — monorepo, DB schema, event bus protocol, TS setup | ✅ Done |
| 1 | Server Becomes the Brain — migration script, repos, prompt pipeline, backend adapters, generation lifecycle | ✅ Done |
| 2 | Thin Client Rebuild — SolidJS, stores, message pagination, components, design tokens | ✅ Done |
| 3 | Feature Port — character management, world info, presets, slash commands, swipes, group chats, stats, data maid | 🟡 In Progress (~75% complete) |
| 3a | Backend format parity (OpenRouter tools, reasoning reconciliation, multimodal embedding) | ✅ Done |
| 3b | Claude prompt caching (beta headers, auto depth, non-deterministic macro guard) | ✅ Done |
| 3c | Universal Lua request transformer, per-preset connection config, model listing per adapter | ✅ Done |
| 4 | Extension System — manifest V2, server/client hosts, built-in extensions migrate | 🟡 Not Started |
| 5 | Polish — backup/export, testing, performance, migration wizard | 🟡 Not Started |

See [Pending Features](pending-features.md) for the detailed Phase 3–5 checklist.
