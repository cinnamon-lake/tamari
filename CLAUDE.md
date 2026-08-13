# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

tamari — a ground-up rewrite of the LLM frontend (branch `refactor-v2`, `package.json` version `2.0.0-alpha.0`). It is a TypeScript npm-workspaces monorepo where the **server is the single source of truth** (SQLite + WebSocket event bus) and the client is a thin SolidJS UI. The legacy SillyTavern codebase is not part of this repository or the tamari build.

## Workspace layout

| Workspace | Package | Role |
|---|---|---|
| `packages/types` | `@tamari/types` | Shared Zod schemas, domain types, WS message types. **Consumed via `dist/` — must be built first.** |
| `server` | `@tamari/server` | Express 5 + `ws`, SQLite (`@libsql/client`), prompt pipeline, backend adapters, Lua runtime. |
| `client` | `@tamari/client` | SolidJS + Vite SPA. Thin renderer over server state. |
| `e2e` | `@tamari/e2e` | Playwright browser tests + a mock LLM server. |

`@tamari/types` has a `prepare` lifecycle script, so it builds on `npm install`. When iterating on types while dev servers run, rebuild it (`npm run build --workspace=packages/types`) — the server/client import its compiled `dist/`.

## Commands

All commands run from repo root unless noted.

```bash
# Install
npm install                          # builds @tamari/types via prepare hook

# Dev (runs server + client watchers together)
npm run dev
npm run dev --workspace=server       # tsx watch, port 8000
npm run dev --workspace=client       # vite dev server

# Build (order matters: types → server → client — root script handles this)
npm run build
npm start                            # build then run server/dist/main.js

# Lint / format (per workspace, except lint:css which runs at root)
npm run lint --workspace=server
npm run lint --workspace=client
npm run format --workspace=server    # prettier
npm run lint:css                     # root: CSS §16 hookable-elements audit (CI-enforced)

# Unit tests (Vitest) — runs across all workspaces
npm test
npm test --workspace=server
npm test --workspace=client

# Single test file / single test (pass args after --)
npm test --workspace=server -- src/repos/CharacterRepository.test.ts
npm test --workspace=server -- -t "creates a character"   # filter by name
# Or invoke vitest directly inside the workspace dir:
#   cd server && npx vitest run path/to/file.test.ts -t "name"

# E2E (Playwright) — REQUIRES a prior `npm run build` (webServer runs the built server)
npm run install:browsers --workspace=e2e   # one-time
npm run test:e2e                            # headless chromium (smoke + journeys)
npm run test:e2e:smoke                      # fast per-feature specs only
npm run test:e2e:journeys                   # long serial user journeys only
npm run test:e2e:ui                         # interactive UI mode

# DB
npm run db:migrate                   # tsx server/src/db/migrate.ts
npm run db:seed                      # tsx server/src/db/seed.ts
```

CI (`.github/workflows/ci.yml`) runs: `npm ci`, `npm audit`, lint for client/server/`packages/types` plus `npm run lint:css`, then client+server tests. A separate `e2e` job builds the app and runs `npm run test:e2e:smoke` on every PR/push; the full suite (smoke + journeys, `npm run test:e2e`) runs only on push to main.

## Architecture (read `docs/design/AGENTS.md` for the full rules — it is authoritative)

The server owns all shared state; the client only renders server broadcasts. This is the most important thing to internalize before touching state.

### Mutation flow (the only valid way to change shared state)
```
user action → client sends WS message → dispatcher.ts → repository (SQLite)
            → bus.broadcast / bus.sendTo → client serverStore
```
- **Never mutate client shared state optimistically.** No `setState` before the server broadcasts.
- WebSocket mutations go through `bus` (`client/src/bus/WebSocketBus.ts`). HTTP is reserved for file uploads, exports/downloads, stats, secrets, and "data maid" — and any HTTP handler that mutates shared state *must* call `bus.broadcast()` after the DB write.
- All WS messages are validated by Zod (`ClientMessageSchema`) at the server boundary in `main.ts`.

### Client state: two stores, never mixed
- `client/src/stores/serverStore.ts` — synced, persisted, broadcast state. Lists (sidebars) + `activeX` full-object snapshots. Replaced wholesale on broadcast (never merged) — applied via Solid's `reconcile()` so unchanged rows keep their identity and `<For>` doesn't remount editors on every echo; sidebar lists are driven only by `*.listed` rebroadcasts, and per-message updates arrive as full-object `message.snapshot` events (`chat.updated` carries the full `Chat`).
- `client/src/stores/uiStore.ts` — per-tab ephemeral chrome (which chat is clicked, modal open/close, form buffers, drafts). Never persisted, never broadcast.
- `client/src/i18n/` — `@solid-primitives/i18n` provider + `useI18n()`; English strings live in per-domain fragments under `i18n/locales/`, language hot-switches via `AppSettings.language` (only `en` ships).
- Render views from `state.activeChat` / `state.activeCharacter`, **never** from `state.chats.find(...)`.

### Active Entity pattern
Opening an item for view/edit: client sends `X.select` → server replies with `X.snapshot` (full object) → the modal/component opens itself from a `bus.on` listener that checks `msg.clientId === state.clientId`. No "pending" signals. Reuse for characters, personas, world info, presets, toolsets.

### Broadcasting rules
- After any list mutation, rebroadcast the **entire list** via `*.listed` (eliminates client-side list-mutation bugs). `.created/.updated/.deleted` still fire for snapshots/active entities.
- `.created`/`.updated` always carry the **full object**.
- Client handlers must **silently ignore** broadcasts for entities not in their list (guard before mutating).
- Server is canonical for all URLs (e.g. `avatar_url`, `export_url`). Client never constructs resource URLs from IDs.

### Naming boundary
Domain types + Zod API schemas = **camelCase** (`firstMes`, `characterId`). SQLite columns + `XRowSchema` = **snake_case** (`first_mes`, `character_id`). Repositories translate at the DB boundary via `rowToX()` functions. SQL strings always use snake_case.

## Server subsystems

- **`repos/`** — repositories, one per entity. Each parses raw rows with `XRowSchema`, maps to camelCase domain objects in `rowToX()`. Wrapped in `withLogging()` at startup.
- **`pipeline/`** — prompt assembly. `PromptBuilder` executes an ordered, replaceable stage list (`PromptStages.ts`: hidden-filter → macro ctx → WI scan → prompt slots → history splices → collection → cache depth → render), orchestrating `PromptManager` (prompt slots/order) + `ChatCompletionRenderer` + `MacroResolver`, `WorldInfoInjector`, `ExampleBuilder`, `RegexEngine`. The pipeline always produces a message list — text-completion adapters flatten it themselves via `backends/formatTextPrompt.ts` + their `InstructTemplate` (no separate story-string system, no token-budget truncation anywhere; history is bounded only by the `promptHistoryLimit`/`chatTruncation` message counts).
- **`backends/`** — one adapter per LLM provider (OpenAI, OpenRouter, Claude, Gemini, llama.cpp, KoboldCpp, TextCompletion), created by `factory.ts`. All adapters support a universal Lua request transformer. `RequestLogger`/`RequestScript` wrap every call.
- **`generation/`** — the generation core: `GenerationRunner` (the ONE loop: mutex, backend resolution, tool-call loop, streaming) + `GenerationTarget` implementations (`AssistantMessageTarget`, `DraftTarget`, `TranscriptTarget`) + `ChatPromptAssembly`. Kind-blind runner; the two kind-varying policies (prompt assembly, persistence) live on targets. See `docs/design/generation-runner.md` and AGENTS.md §8.
- **`services/`** — `GenerationService` (thin facade over `generation/` — validates, resolves characters, constructs targets), `ToolRegistry` + `ToolTemplate`, `GroupChatService`, `RAGService` (vectra vector store), `MemoryService`, `SecretService` (encrypted), `RegexEngine`, `DataMaid`.
- **`scripting/`** — server-side Lua runtime (`wasmoon`): `LuaRuntime`, `QuickReplyService`, the `st` API (`StApi.ts`), and `ScriptGenerationApi` (the narrow generation surface exposed to scripts).
- **`tts/`** — TTS adapter factory + providers (OpenAI, ElevenLabs, Azure, FishAudio S2, Kokoro FastAPI, GPT-SoVITS, Silero, VITS Simple API, AllTalk, MiniMax, VolcEngine), served via `/api/tts`.
- **`api/`** — HTTP routers (attachments, characters, chats, files, data maid, models, personas, secrets, stats) for uploads/exports and the non-WS surface; any handler that mutates shared state must call `bus.broadcast()`.
- **`bus/EventBus.ts`** — pub/sub with `sendTo` / `broadcast`. `dispatcher.ts` composes the per-domain handler modules under `dispatch/` (one `Map`-style handler per `ClientMessage` type, exhaustiveness enforced by a typed `HandlerMap`) that perform repo mutations + broadcasts.
- **`db/`** — `@libsql/client` SQLite, WAL mode, migrations in `db/migrations/*.sql` (run in order). `import-legacy.ts` performs one-time import from SillyTavern's flat-file `data/`.

### Tool architecture
Tools are LLM-callable functions organized into **templates** (`ToolTemplate` — built-in TS or Lua script, same interface) with a shared `configSchema` and branch-aware state via `serialize()`/`deserialize()`. Users create **toolsets** (template instances with their own config + per-tool `toolOverrides`). `ToolRegistry` resolves by template ID (built-ins first, then Lua). See AGENTS.md §7.

## Non-obvious gotchas

- **ESM `.js` import extensions are required** in server + types (tsconfig `module: NodeNext`). Write `import { x } from './foo.js'` even for `.ts` source files. The client (Vite, `moduleResolution: bundler`) uses extensionless imports — match each workspace's convention.
- **`@tamari/types` must be built** before server/client can resolve it; the `prepare` hook covers `npm install`, but if you edit types during a dev session, rebuild it.
- **`noUncheckedIndexedAccess` is on** (both workspaces) — `arr[i]` is `T | undefined`; the compiler will force you to handle it.
- **Never validate API key formats** (length, prefix, etc.) — users run reverse proxies, local backends, and custom auth. This is an explicit roadmap principle.
- **Auth**: single shared secret (`TAMARI_SECRET` env, random if unset). Bearer token on WS (`?token=`) and HTTP (`Authorization` / `?token=`). If unset at boot, the server logs a masked random one and warns it won't persist across restarts.
- **CSP is hand-maintained** in `main.ts` with exact-hashed font/CDN URLs — adding an external asset origin means editing that allowlist (or the `allowExternalMedia` setting for `img-src`).
- **E2E chromium path is NixOS-specific**: `e2e/playwright.config.ts` hardcodes `/run/current-system/sw/bin/chromium-browser`. On other OSes, remove `executablePath` and rely on `npx playwright install`. E2E wipes `server/.test-data` each run and needs `npm run build` first.
- **CSS**: tokens only — no raw hex/rgb, no `!important`, flat selectors (max two), `gap` over margins, every element needs a class/ID (users target these in custom CSS — never remove a shipped class). Full rules in `docs/design/css-principles.md`.
- **Theming** is CSS custom properties (design tokens in `client/src/styles/tokens.css`), not SillyTavern's `--SmartTheme*` JSON theme system.

## Key docs to consult

- `docs/design/AGENTS.md` — architecture rules (state, mutation flow, broadcasting, active-entity, naming, tools, code style). **The bible.**
- `docs/design/css-principles.md` (+ `css-audit-plan.md` runbook) — CSS rules every component must follow, and how to audit the client against them.
- `docs/quality/` — review checklists and plans: `llm-wont-do-checklist.md` (security/a11y/code-quality prompts) and `coverage-improvement-plan.md` (test-coverage targets). Dated audit reports live in `docs/quality/audits/`.
- `docs/roadmap/README.md` — what's done, the tech-stack table, intentional architectural breaks.
- `docs/roadmap/breaking-changes.md` — SillyTavern→tamari migration paths.
- `docs/user/macros.md`, `docs/user/lua-scripting.md` — user-facing macro + Lua `st` API reference.
- `docs/external/` — upstream specs the code implements (Character Card v2/v3, provider API docs). Not original project docs.
- `e2e/README.md` — E2E harness: Playwright projects (smoke vs journeys), fixtures, test-data isolation.
