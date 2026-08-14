# tamari Documentation

This directory contains design documents, roadmaps, external specifications, and user guides for the tamari project.

## Directory Layout

| Directory / File | Purpose |
|------------------|---------|
| [`design/`](./design/) | Engineering standards — tamari architecture rules, CSS principles/audit, and design proposals (scriptable layers). |
| [`roadmap/`](./roadmap/) | High-level roadmap, breaking changes, completed work, and pending features. |
| [`user/`](./user/) | **User-facing documentation** — getting started, characters, backends, world info, tools, the workbench, macros, Lua scripting, and more. Start at [`user/getting-started.md`](./user/getting-started.md). |
| [`external/`](./external/) | **External specifications** imported from other projects — not original tamari docs. |

---

## User Documentation

**Start here:** [`user/getting-started.md`](./user/getting-started.md) — install, run, configure, and your first chat.

**Core features**

- [`user/characters.md`](./user/characters.md) — Character cards: fields, import/export (PNG, CharX, .risum), tags, greetings, and group chats.
- [`user/personas.md`](./user/personas.md) — Your identity in chat: personas, per-chat selection, avatars.
- [`user/backends.md`](./user/backends.md) — Backend configs: providers, API keys & secrets, samplers, instruct templates, model listing.
- [`user/world-info.md`](./user/world-info.md) — Lorebooks: keyword activation, depth injection, `@@` decorators, semantic (RAG) mode.
- [`user/regexes.md`](./user/regexes.md) — Regex scripts for prompt and display transforms, including Lua replacements.
- [`user/assets.md`](./user/assets.md) — Character assets vs chat attachments, embedding media, CharX/ccv3 asset handling.
- [`user/tts.md`](./user/tts.md) — Text-to-speech via the `speak` tool, with all 11 provider adapters.
- [`user/slash-commands.md`](./user/slash-commands.md) — Complete `/command` reference.
- [`user/ui-customization.md`](./user/ui-customization.md) — Themes, design tokens, custom CSS, backgrounds, display styles.

**Scripting & automation**

- [`user/macros.md`](./user/macros.md) — Complete reference for the `{{...}}` macro system, including all built-in macros, conditional blocks, and variables.
- [`user/lua-scripting.md`](./user/lua-scripting.md) — Guide to writing Lua scripts for Quick Replies and backend request transformations, with full `st` API reference.
- [`user/tools.md`](./user/tools.md) — The tool-call loop, toolsets, the built-in template catalog, and authoring Lua tool templates.
- [`user/workbench.md`](./user/workbench.md) — The workbench: a filesystem-style surface the LLM uses to read and edit your cards, backends, toolsets, and scripts.
- [`user/unpacked-cards.md`](./user/unpacked-cards.md) — Unpacked cards: character cards as plain folders on disk (read-only in the app), plus the read/test-only MCP server and `test_card` chat simulation for LLM agents.
- [`user/custom-backends.md`](./user/custom-backends.md) — Replacing or decorating the generation backend with Lua (registry scripts and card-coupled `backend_logic.lua`).
- [`user/request-scripts.md`](./user/request-scripts.md) — Per-backend Lua request transformers: the `request` table, safety limits, and dry-run testing.

---

## Engineering Standards (`design/`)

- [`design/AGENTS.md`](./design/AGENTS.md) — Core tamari architecture rules (server state vs UI state, mutation flow, active entity pattern, snapshot contract). **The authoritative reference.**
- [`design/css-principles.md`](./design/css-principles.md) — CSS architecture rules (tokens, flex+gap, flat selectors, etc.).
- [`design/css-audit-plan.md`](./design/css-audit-plan.md) — Step-by-step guide for auditing the client against `css-principles.md`, including the `audit_css_hooks.cjs` runbook.
- [`design/scriptable-layers.md`](./design/scriptable-layers.md) — **Proposal.** tamari's answer to RisuAI TriggerScript: three single-purpose scriptable layers (custom Lua backends, memoized display transforms, `data-post-response` button protocol) under a "no render-time code, immutable displayed history" contract.
- [`design/generation-runner.md`](./design/generation-runner.md) — **Proposal.** Unify generate/continue/regenerate/impersonate/quiet behind one `GenerationRunner` loop driven by `GenerationTarget` state — the foundation for sub-agent tool-calling and composable custom backends.
- [`design/complex-card-scripting.md`](./design/complex-card-scripting.md) — **Implemented.** Multi-file `backend_logic` (card VFS + sandboxed `require`, Workbench `backend_logic/` directory) and script-facing structured output (`response_format`, `json.parse_result`).
- [`design/debug-traces.md`](./design/debug-traces.md) — **Implemented.** Structured error chains across nested backends/sub-agents, `generations.meta` trace records, and trace surfacing via tool results, dry-runs, and the read-only `/generations/<id>/` workbench route.
- [`design/character-porting.md`](./design/character-porting.md) — End-to-end flow for porting RisuAI cards (CharX + .risum) with the Character Workbench, plus a checked case study of the Touhou/Hearts bundle.

## Roadmap (`roadmap/`)

- [`roadmap/README.md`](./roadmap/README.md) — High-level project roadmap, status, and technology stack overview.
- [`roadmap/breaking-changes.md`](./roadmap/breaking-changes.md) — Intentional breaking changes in tamari and migration paths.
- [`roadmap/completed.md`](./roadmap/completed.md) — High-level summary of finished foundation work.
- [`roadmap/pending-features.md`](./roadmap/pending-features.md) — Remaining features to port, categorized by priority.

---

## External Specifications

These are community standards that SillyTavern implements. They are **not** original project documentation.

### Character Card Specifications
- [`external/character-card-spec-v2/`](./external/character-card-spec-v2/) — Character Card V2 specification (community standard).
- [`external/character-card-spec-v3/`](./external/character-card-spec-v3/) — Character Card V3 specification (community standard).

### API Documentation
- [`external/api/`](./external/api/) — Copies of third-party API docs referenced by backend adapters (OpenAI, Claude, Gemini, OpenRouter, llama.cpp, TabbyAPI, KoboldCPP, etc.).
