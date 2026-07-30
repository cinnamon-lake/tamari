# Breaking Changes

The following **will break** and require migration guides, reimplementation, or explicit user action. These are documented here so we don't lose track of the rationale — if a user asks "where did X go?", the answer should be in this file.

---

## Extension Ecosystem

| Feature | Why It Breaks | Migration |
|---|---|---|
| **Third-party extensions** | SillyTavern extensions depend on global mutable vars (`chat[]`, `characters[]`), jQuery DOM manipulation, and direct REST endpoint shapes. A thin client + event bus removes all three. | New extension API with server-side hooks (`beforePromptBuild`, `afterGenerate`) and client-side renderer plugins (designated slots, no DOM access). Grace period with legacy compatibility layer, then deprecation. |
| **jQuery plugins in extensions** | Extensions using jQuery UI, Select2, etc. directly will break when those libraries are removed. | New component library exposed via extension API. Extensions request UI elements programmatically. |
| **Extension HTML templates** | SillyTavern extensions render arbitrary HTML into the DOM. | Extensions register Solid components in designated slots. Template rendering is no longer supported. |
| **SillyTavern extension system (`extensions.js`)** | jQuery/DOM-based extension loader with global mutable state access and extension-specific slash commands. | Replaced by manifest V2 extension system (Phase 4). Server-side hooks + client-side renderer plugins in designated slots. |

---

## Theming & Customization

| Feature | Why It Breaks | Migration |
|---|---|---|
| **Custom CSS** | Custom CSS targets specific IDs (`#send_textarea`, `#chat`) and deeply nested div structures. Semantic HTML refactoring invalidates virtually all custom CSS. | Provide CSS custom properties (variables) as a stable theming API. Document migration guide mapping old selectors to new token names. |
| **Custom Themes (JSON)** | Theme JSON files target the current `--SmartTheme*` CSS variable names and DOM structure. | Version theme schema; provide migration script that maps old color keys to new semantic tokens (`--color-bg-primary`, etc.). |
| **Moving UI / Moving UI presets** | Stored as JSON files targeting specific DOM selectors and absolute positioning coordinates. The new layout is a CSS Grid with fixed regions. | **DISCUSS:** This feature may be abandoned. The new layout is responsive by default; draggable panels conflict with the component architecture. If kept, migrate to semantic layout descriptors (e.g., "sidebar visible", "compact mode"). |
| **waifuMode** | A legacy layout mode that significantly alters DOM structure for a fullscreen character-focused view. Incompatible with the new grid layout. | **DISCUSS:** Evaluate whether to reimplement as a "Zen mode" or drop. The new CSS architecture could support a layout toggle, but the old implementation is not portable. |
| **Pin styles (`pin_styles`)** | Pins custom CSS styles so they survive theme changes. | Obsolete — tamari's design-token system makes theme changes non-destructive. |

---

## Prompt & Generation Pipeline

| Feature | Why It Breaks | Migration |
|---|---|---|
| **Macro system** | `substituteParams()` and macro engine currently run client-side and touch DOM. New pipeline resolves macros server-side before WI scanning and prompt assembly. | ✅ **Already migrated.** `MacroResolver.ts` runs on the server. Supports `{{expr}}` macros and `{% block %}` control structures with pluggable handlers. Some advanced macros are still pending parity — see Pending Features. |
| **Text-completion story string templates** | SillyTavern had a completely separate template system for text-completion APIs (`renderStoryString`, `power-user.js`). | ❌ **Intentionally omitted.** `PromptManager` handles prompt assembly uniformly. Text-completion adapters render the same prompt collection into a flat string via `TextCompletionRenderer`. No separate template system. |
| **System prompt presets (legacy)** | SillyTavern had `sysprompt.js` presets alongside instruct mode as a parallel system. | ❌ **Intentionally omitted.** System prompt is the `main` prompt slot in `PromptManager`, overridable per-character. Instruct formatting is handled by `InstructTemplate` presets applied by `TextCompletionRenderer`. |
| **Context presets (story string, chat start, separator)** | SillyTavern's context presets included Handlebars-like template strings (`{{#if system}}{{system}}\n{{/if}}...`) that were rendered client-side. | Migrated to server-side `PromptManager` with the same semantic fields, but the template syntax is now the `MacroResolver` syntax (`{{if description}}...{{/if}}`), not Handlebars. Preset files need syntax migration. |
| **User prompt bias / Logit bias** | SillyTavern's bias system was client-side and backend-specific. | Reimplement as a server-side prompt injection or backend adapter parameter, depending on API support. |
| **Post-processing: `collapseNewlines` + `trimSpaces`** | Individual boolean toggles for newline collapsing and space trimming. | Unified into `whitespaceMode` enum (`none` / `essential` / `full`). `essential` trims leading/trailing whitespace; `full` also collapses internal whitespace and normalizes newlines. |
| **STScript / slash-command closures & scopes** | Custom parser, tokenizer, closures, scopes, pipe syntax (`|`), debugger with breakpoints. | ❌ **Intentionally omitted.** Replaced by Lua 5.4 (wasmoon) in Quick Reply. Lua provides real control flow, tables, and functions — no need to reinvent them. |
| **Pipe syntax & return value chaining** | Commands could pipe output into each other (`/command | /other`). | ❌ **Intentionally omitted.** Simpler model: Lua scripts and slash commands are fire-and-forget server actions. |
| **Runtime prompt injections (`/inject`, `/flushinject`, `st.inject`, `st.flush_inject`, the `injections` field on `action.generate` / `action.sendAndGenerate`)** | The feature rode `pendingInjections` — mutable cross-call state on GenerationService that needed its own race-fix regression tests. | ❌ **Intentionally removed.** Per the generation-runner design, any future runtime-injection capability returns as seed content on the generation target (same mechanism as the impersonation prompt), not as a side channel into prompt assembly. |
| **Unknown backend provider ids** | Mis-typed or legacy provider ids used to silently fall through to the OpenAI adapter, sending requests to the wrong API with the wrong shape. | ❌ **Intentionally changed.** The provider registry (`registerBackendProvider`) throws a loud error naming the provider and the known ids; generation surfaces it as the directed `NO_BACKEND` error. Fix the config's provider id (known: openai, openrouter, claude, gemini, llamacpp, tabbyapi, koboldcpp, moonshot, custom). |

---

## Data & Persistence

| Feature | Why It Breaks | Migration |
|---|---|---|
| **PNG-character direct editing** | Users who edit character PNG metadata with external tools will need to use the API/UI instead, because the database is now canonical. | Keep import/export roundtrip; just change canonical storage. External tools should import/export through tamari. |
| **Direct file system backups** | Users who back up `data/` by copying JSON/JSONL files will need SQLite backup procedures. | Provide `npm run backup` command (`VACUUM INTO`) and automated backup scheduler. Document SQLite backup for power users. |
| **World Info file format** | JSON lorebooks will migrate to SQLite. | Import on first run; keep export capability. |
| **Chat metadata / script injects** | SillyTavern's chat metadata was a flat JSON blob with ad-hoc keys. New schema normalizes some metadata into columns. | Migration script maps known keys; extension data goes into `extension_data` table. |
| **Quick Reply preset JSON files** | SillyTavern QRs stored as flat JSON files in `data/quickreplies/`. | Migrated to first-class `quick_replies` SQLite table. Legacy QRs imported with a "⚠ STScript" badge and do not execute. |

---

## API & Integration

| Feature | Why It Breaks | Migration |
|---|---|---|
| **Frontend REST API shape** | Moving logic server-side means `/api/settings/save`, `/api/chats/save`, etc. change or disappear. | Document new WebSocket message types; provide adapter for transition period. REST only used for uploads/exports now. |
| **Custom request / Extras API** | The Extras API was a separate Python service. The new architecture handles these features as server-side extensions or built-in services. | TTS, captioning, etc. become built-in adapters or server extensions that call external services directly. No need for a separate microservice. |
| **TTS global settings + REST endpoint** | SillyTavern's TTS was configured globally in Settings and triggered via `/api/tts/generate` REST endpoint (auto-play or manual read-aloud). | ❌ **Intentionally changed.** TTS is now a built-in `speak` tool template. Configuration lives per-toolset in the ToolsModal. The LLM decides when to speak by calling the tool. Natural-language prosody tags (e.g. `[whisper in small voice]`) flow directly to providers like FishAudio S2 Pro. |
| **Multi-user admin / auth endpoints** | SillyTavern supported multi-user with login, registration, admin CRUD, password reset. | ❌ **Intentionally omitted.** tamari is explicitly single-user architecture. Shared-secret auth (`TAMARI_SECRET`) replaces user accounts. |
| **Server URL autocomplete history** | Remembered last 5 API URLs per server label. | Obsolete — tamari uses per-preset connection config (`api_url`, `api_key`). |

---

## What We Are Explicitly *Not* Porting

These are **intentional removals**, not oversights.

| Feature | Reason |
|---|---|
| `power-user.js` story string templates | Replaced by unified `PromptManager`. |
| `sysprompt.js` parallel preset system | Replaced by `main` prompt slot + per-character override. |
| Client-side token counting (primary) | Token counting is now server-side with model-specific counters. Client may show cached counts. |
| `SSE-stream.js` and `streaming-display.js` | Replaced by WebSocket `generation.token` events and SolidJS reactive rendering. |
| `public/script.js` monolith | Decomposed into server stores + SolidJS components. |
| **Azure OpenAI dedicated adapter** | Explicitly rejected. The universal Lua request transformer (available on every adapter) covers 100% of Azure OpenAI use cases (deployment-based URLs, Entra ID auth, etc.) without a dedicated adapter. |
| **AI Horde** | Async generation queue, worker selection, kudos system. Not planned — niche and high maintenance. |
| **Translate extension** | Modern LLMs roleplay natively in any language. Removing simplifies the codebase and reduces external API dependencies. |
| **Connection Manager extension** | Per-preset connection config (`api_url`, `api_key`) already covers the 90% use case. A separate connection profile manager adds UI complexity for marginal gain. Users can duplicate presets if they need multiple API URLs for the same backend. |
| **Token Counter extension** | Per-message token counts are already displayed in message headers. The standalone popup with color-coded chunks is a nice-to-have but not essential. |
| **Connection status indicator** | SillyTavern's indicator tracked backend API reachability, not server connectivity; was broken and misleading. |
| **Moving UI + Moving UI presets** | Draggable panels fight responsive design and component boundaries. High complexity for low utility. |
| **HypeBot extension** | Niche meme extension. Low usage, high maintenance. |
| **RVC extension** | Real-time voice conversion. Extremely niche, requires external ML pipeline. |
| **Objectives extension** | Quest-tracking extension. Complex, low adoption. Better as a user script via Quick Reply. |

---

## Migration Wizard (Planned)

On first run of tamari:

1. Detect `data/` directory (legacy).
2. Show modal: "Welcome to tamari. Your data needs to be migrated to a new database format."
3. Options:
   - "Migrate now" (recommended)
   - "Backup first, then migrate"
   - "Skip for now" (runs empty, old data untouched)
4. Progress bar: "Importing 3,421 messages..."
5. On completion: "Migration complete. Old data backed up to `data-backup-pre-v2/`."
6. Link to this breaking changes doc.
