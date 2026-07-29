# Completed Work

High-level summary of finished foundation work. Detailed implementation notes remain in commit history and source code comments.

---

## Phase 0: Foundation

- **Monorepo structure** — `server/`, `client/`, `packages/types/` with npm workspaces.
- **SQLite schema** — Tree-structured messages (`parent_id`), relational characters/chats/settings/world_info/secrets/generations/extension_data/attachments. Uses `@libsql/client` for zero-native-compilation deployment.
- **Event bus protocol** — WebSocket with typed `ServerMessage` / `ClientMessage`, snapshot replay on connect, heartbeat, and "persist before broadcast" guarantee.
- **TypeScript setup** — Strict mode across all packages, Zod for runtime validation.

---

## Phase 1: Server Becomes the Brain

- **One-time data migration** — `import-legacy.ts` reads old `data/` (settings.json, PNG characters, JSONL chats, world JSON, group JSON) and populates SQLite. Backs up old data to `data-backup-pre-v2/`.
- **Repository pattern** — Async repos with `NotFoundError`/`ConflictError` semantics and transactional batches.
- **Prompt pipeline** — `PromptBuilder` → `PromptManager` → `MacroResolver` → `WorldInfoInjector` → `ChatCompletionRenderer` / `TextCompletionRenderer`. Token budgets, per-message overhead, macro resolution before WI scanning.
- **Backend adapters** — `OpenAIBackendAdapter`, `OpenRouterBackendAdapter`, `ClaudeBackendAdapter`, `GeminiBackendAdapter`, `TextCompletionBackendAdapter`, `LlamaCppBackendAdapter`, `KoboldCppBackendAdapter`. Streaming, tools, vision, reasoning blocks.
- **Generation lifecycle** — Server-managed from `action.send` through `generation.done`, with `AbortSignal` cancellation and multi-tab sync via snapshot replay.

---

## Phase 2: Thin Client Rebuild

- **SolidJS + Vite** — Fine-grained reactivity for streaming tokens, tiny bundle.
- **Server-state store** — `createStore` with full `ServerMessage` wiring. Snapshot restoration on reconnect includes active generation buffer.
- **Message pagination** — Renders the most recent `displayLimit` messages (50 by default) with a "Load more messages" button to grow the window on demand. The global message pool keeps render cost decoupled from total chat size. (A dedicated virtual-scroll component was evaluated and set aside — the load-more model is simpler and sufficient for now.)
- **Message pagination** — Bounded recursive CTE on server (`O(limit)` regardless of chat size). Client fetches pages on demand.
- **Markdown rendering** — `marked` + `DOMPurify` + `highlight.js`, collapsible reasoning blocks.
- **Design tokens** — CSS custom properties in `tokens.css` (surfaces, text, accent, status, borders, motion, typography, radii, layout).

---

## Phase 3: Feature Port

### Core Chat & Generation

- **Author's Note** — Core feature stored in `chat.metadata`, server-side injection in `PromptBuilder`, client modal in `ChatHeader`.
- **Continue (`/continue`)** — Three modes: chat completion + nudge, chat completion + prefill, text completion. Supports `continue_on_send`.
- **Impersonation (`/impersonate`)** — `runQuietGeneration` with impersonation prompt injection. Chat + text completion modes.
- **Quiet generation** — `runQuietGeneration()` in `GenerationService`.
- **Logit bias** — Stored as `logit_bias` JSON, injected into `openai.params`, rendered as an editor in `BackendConfigModal`. (The SillyTavern per-token slider / drag-sort editor is not yet ported — see pending.)
- **Reasoning templates** — Built-in + user-defined CRUD, server-side `ReasoningEngine`, prompt re-injection toggle.
- **Auto-continue** — `autoContinueEnabled` + `autoContinueTargetLength`. Recursive continue if below target (max 3 depth).
- **Model icons in timestamps** — `model` stored in `message.extra`, displayed as badge in `MessageBubble`.
- **Single-line mode** — `singleLine` setting applied server-side before saving.
- **Trim sentences** — `trimSentences` setting cuts at last sentence-ending punctuation.
- **Whitespace handling** — Unified `whitespaceMode` setting (`none` / `essential` / `full`). Replaces old individual toggles (`collapseNewlines`, `trimSpaces`). `essential` trims leading/trailing whitespace; `full` also collapses internal runs of whitespace and normalizes newlines to double-newline max.
- **Message sound effects** — Plays `public/sounds/message.mp3` on `generation.done`.
- **Smooth streaming** — Token queue in `serverStore.ts` buffers `generation.token` events; `startSmoothDrain()` releases at configurable delay.
- **Custom stopping strings** — Global `customStoppingStrings` array merged with preset stop strings, optional macro resolution.
- **Chat truncation** — `chatTruncation` setting hard-caps `promptHistoryLimit`.
- **Pin examples / Strip examples** — `stripExamples` omits `dialogueExamples` from prompt.
- **Auto-fix generated markdown** — Repairs unclosed backticks, code blocks, and unbalanced asterisks.
- **Message action buttons** — Edit, delete, hide/unhide, regenerate, continue, swipe left/right.
- **Auto-resizing textarea** — `scrollHeight`-based auto-resize in `MessageInput`.
- **Remove XML / Trim spaces** — Post-processing filters in `GenerationService`.
- **Empty send handling** — Empty sends dispatch `action.generate` without creating an empty user message.
- **Auto-select chat on creation** — `pendingChatId` signal auto-selects newly created chats.
- **Stop generation + Lua abort** — Red Stop button aborts backend stream and any running Lua script.

### Macro System

- **Core macros** — `space`, `newline`, `noop`, `trim`, `if`/`unless` blocks, env macros (`user`, `char`, `description`, etc.), time macros, variable macros (`getvar`, `setvar`), instruct macros.
- **Dice / roll macros** — `random(min,max)`, `pick(a,b,c)`, `roll(NdM)` with `2d6` parsing.
- **Chat inspection macros** — `lastMessage`, `lastMessageId`, `lastUserMessage`, `lastCharMessage`, `firstIncludedMessageId`, `currentSwipeId`. Query `MacroContext.messages` passed from `PromptBuilder`.
- **State macros** — `lastGenerationType` (populated by `GenerationService`: `send`/`continue`/`regenerate`/`impersonate`), `hasExtension` (checks `MacroContext.extensions`).
- **`{% for %}` loop block** — `{% for varName::item1::item2::item3 %}...{% endfor %}`. Temporarily registers loop variable + `forIndex` macro per iteration.
- **SillyTavern variable shorthand** — `{{.varname}}` → `macroVars`, `{{$varname}}` → `globalVars`. Handled in `evalExpr` fallback.
- **Macro autocomplete** — Client-side dropdown in `MessageInput`. Triggers on `{{`, filters as you type; Enter/Tab inserts the top match (arrow-key navigation not implemented). Hardcoded `MACROS` array stays in sync with server.

### Presets & Templates

- **Context presets (MVP)** — `stop_strings` in preset schema, wired through `PromptBuilder`.
- **Instruct templates** — 33 built-in templates (Alpaca, ChatML, Llama 2/3/4, Mistral 7B/Nemo/Large 2411/V3, Gemma 4, Nemotron 3, Phi-4, Granite 4.0, MiniMax-text-01, Kimi K2.6, GLM 5.1, Qwen 3.5/3.6, DeepSeek V4 Pro, plain, etc.) with normal + thinking variants, plus user-defined custom templates with full field parity.
- **Reasoning templates** — Built-in + user-defined, stored in settings, `ReasoningEngine` for parsing/reconstruction.
- **API presets per backend** — Unified `presets` table with `backend` column. OpenRouter provider selection.
- **Context size presets** — `max_tokens` and `context_length` editable per preset.
- **Default preset loading** — Loads default presets from `default/content/presets/` on first run.

### Backend Adapters

- **llama.cpp server** — Dedicated `LlamaCppBackendAdapter` for native `/completion` endpoint.
- **TabbyAPI** — Routed through `TextCompletionBackendAdapter` (OpenAI-compatible `/v1/completions`).
- **KoboldAI / KoboldCPP** — Native API via `/api/extra/generate/stream` (SSE) with token-per-event format.
- **Model listing per adapter** — `BackendAdapter.listModels()` for all adapters.
- **Moonshot (Kimi)** — Dedicated `MoonshotBackendAdapter` for the Moonshot API.
- **Universal Lua request transformer** — Lua script hook available on **all** backend adapters.
- **Backend format parity** — OpenRouter extends `OpenAIBackendAdapter` with correct `tool_calls`, `image_url`, and reasoning formatting. Claude and Gemini adapters have native tool formatting.
- **Claude prompt caching** — Native + OpenRouter Claude caching with auto-calculated cache depth, non-deterministic macro guard, beta headers.
- **World Info `atDepth` placement** — New `position: 'atDepth'` with `depth` and `role` fields.
- **Absolute preset prompt injection** — Enabled absolute prompts injected into `historyMessages` during newest-first traversal.

### Character Cards

- **Character card V3 (core fields)** — New DB columns (`group_only_greetings`, `nickname`, `creator_notes_multilingual`, `source`), V3 PNG chunk support, `?format=v2` query param for backward compatibility.
- **Character card V3 (assets)** — `assets` array with `icon`/`background`/`emotion`/`user_icon` types, `embeded://` URI resolution, filesystem-backed asset storage, `GET /api/characters/:id/assets/:assetId` serving.
- **CharX format** — ZIP-based `.charx` import/export. Import detects polyglot/SFX archives (JPEG+ZIP). Export bundles `card.json` + assets.
- **Tag filters & sorting** — Multi-select tag chips + sort dropdown (Name A-Z, Recently Updated, Recently Created).
- **Character List Grid View** — `charListGrid` setting toggles grid layout with larger avatars.
- **Avatar crop on upload** — `CropModal.tsx` with `cropperjs`, canvas crop with 512×512 max, PNG output.
- **Avatar thumbnails** — `resizeThumbnail()` generates 96×96 Jimp center-crops on upload/import. Stored in `avatars/thumbs/`, referenced by `avatarThumbnailPath` on characters and personas. Used in character list, persona manager, group chat panel, and chat view for performance.
- **Never resize avatars toggle** — Skips `CropModal` when enabled.

### World Info

- **Basic WI** — Entry editor (keys, content, position, order, probability, constant, selective, regex), WebSocket CRUD, "test triggers" feature.
- **At-depth injection** — WI entries injected into chat history at specific depth and role.
- **Recursive activation** — Entries marked `recursive: true` can trigger other entries across multiple rounds (max 3 depth).
- **Semantic retrieval (RAG)** — `retrieval_mode: 'semantic'` on `WorldInfoEntry`. Vectra-based vector store, OpenAI-compatible embedding client.

### Group Chats

- **Backend + basic UI** — `GroupChatService` with activation strategy enum (`NATURAL`, `LIST`, `MANUAL`, `POOLED`), auto-mode timers, `chat_members` table, client right-drawer panel.
- **Disable group trimming** — `disableGroupTrimming` setting removes lines starting with other member names from generated messages.
- **Timer enabled** — Shows generation duration per message in message header.

> **Note:** `SWARM` was previously listed as an activation strategy but has not been implemented. The implemented strategies are `NATURAL`, `LIST`, `MANUAL`, and `POOLED`.

### Extensions (Promoted to Core)

- **Author's Note** — Promoted from extension to core feature.
- **Regex** — Promoted to core: `RegexEngine` with four placement modes (User Input, AI Output, Prompt, Display). Stored in settings JSON, test area in `SettingsModal`.
- **Quick Reply** — Promoted to core: server-side Lua (`wasmoon`) runtime, `st` API with ~80 functions covering near-complete SillyTavern slash-command parity (`send_as`, `send_narrator`, `comment`, `trigger`, `branch`, `checkpoint`, `hard_fork`, `delay`, `set_author_note`, `get_backend_configs`, `set_backend_config`, `set_model`, `set_backend`, `token_count`, `trim_tokens`, `json_encode`, `json_decode`, and 50+ more), atomic chat-locking execution. First-class DB table, client button bar, editor modal, global settings manager. SillyTavern STScript imported with badge.
- **Vector Memory / RAG** — Promoted to core: WI-entry semantic retrieval scaffolded. Chat-memory RAG intentionally deferred in favor of summarization.
- **Memory / Summarization** — `MemoryService` produces a rolling summary anchored to a user message `depth` behind the leaf, re-summarized every `updateInterval` messages via a dedicated backend config. Summaries carry `[msg:ID]` citations stored in `extra.memory`, are branch-aware (`findLatestApplicableSummary`), and inject as a synthetic system message at the start of history. Exposes a `memory` tool template (`memory_get_raw`, `memory_summarize_range`) for LLM-callable retrieval.
- **TTS infrastructure** — `TtsAdapter` layer with `FishAudioS2Adapter` and `KokoroFastApiAdapter`. Exposed via the `speak` built-in tool template. The LLM calls `speak(text)` with natural-language prosody tags; audio is saved as an attachment and returned as `{{attachment::ID}}`. Per-toolset config (provider, voice, URL, API key) with Lua `requestScript` hook. Old `/api/tts` REST endpoint and global settings UI removed in favor of tool-template architecture.

### Slash Commands

- **Core commands** — `/send`, `/sys`, `/reset`, `/cut`, `/continue`, `/name`, `/impersonate`, `/regenerate`, `/regen`, `/swipe`, `/persona`, `/char`, `/lock`, `/unlock`, `/bg`, `/theme`, `/wi`.
- **`/wi` subcommands** — `list` (shows entries as system message), `get <key>` (shows entry content), `add <keys> <content>` (creates entry), `del <key>` (deletes entry by key).
- **Client-side parser + autocomplete dropdown**.

### UI / Theming

- **Theme system (MVP)** — `ThemeInjector` applies `themeCustomCss`. Background image + blur via `BackgroundInjector`.
- **Custom CSS** — Via `themeCustomCss` setting + `ThemeInjector`.
- **Background images** — Via `backgroundImageUrl` + `backgroundBlur` settings.
- **Chat display styles** — Default, Bubbles, Document.
- **Avatar styles** — Round, Rectangular, Square, Rounded via CSS variable.
- **Message timestamps** — Displayed in `MessageBubble` header.
- **Message token counts** — Server-side `TokenCounterProvider`, displayed as badge in message header.
- **Send on enter behavior** — Auto / Enabled / Disabled.
- **Compact input area** — Reduces input height from 44px to 32px.
- **Auto-scroll to bottom** — Toggle + floating scroll-to-bottom button.
- **Media display mode** — List vs Grid for message attachments.
- **Click to edit** — Single-click message edit mode.
- **Font scale / Chat width / Blur strength / Shadow width / No shadows** — All implemented via `DesignTokenInjector`.
- **Reduced motion** — Global animation/transition disable.
- **Toast notifications** — Reactive queue with auto-dismiss.
- **Toast position control** — Six-position placement (top-left, top-center, top-right, bottom-left, bottom-center, bottom-right).
- **Popup system parity** — Promise-based confirm/alert/prompt/input modals replacing native dialogs.
- **Auto-save panels** — `AuthorsNotePanel` and `PersonaManager` converted from manual Save buttons to debounced auto-save (600ms) with Saved indicators.
- **Checkpoints UI** — `CheckpointsPanel` modal in `ChatHeader` for creating, browsing, restoring, and deleting chat checkpoints (soft forks).
- **Quick Continue / Quick Impersonate buttons** — One-click buttons next to send button.
- **Image paste from clipboard** — `MessageInput` handles paste events.
- **Drag & drop files** — `ChatView` handles dragover/drop with overlay.
- **Scroll-to-bottom button** — Floating down-arrow when user scrolls up.
- **Confirm message delete** — Browser `confirm()` dialog before delete.
- **Auto-save message edits** — Save on textarea blur.
- **Streaming cursor** — Blinking `▋` cursor appended to the streaming target message. Generating indicator pill removed in favor of cleaner UI.
- **In-chat message search** — `chatSearchQuery` filters loaded messages by content/name.
- **Markdown hotkeys** — Ctrl+B bold, Ctrl+I italic, Ctrl+U underline, Ctrl+K code, Ctrl+Shift+` strikethrough.
- **Restore user input** — Per-chat draft map, restored when switching chats.
- **Auto-load last chat on startup** — `autoLoadLastChat` setting restores the previously active chat after reconnect; `lastChatId` is persisted whenever a chat is selected.
- **Touch swipe for message swipes** — Horizontal swipe on the active assistant message (and greeting) triggers swipe left/right, with `touch-action: pan-y` to avoid browser navigation on mobile.
- **Mobile bottom-sheet modals** — On viewports ≤768px, all `.modal` panels render as full-width bottom sheets with top-only border radius, reduced padding, and a slide-up animation.
- **Larger mobile tap targets** — Message action buttons and swipe buttons are enlarged to 40×40px with bigger gaps on ≤768px viewports.
- **Edge-swipe sidebar on mobile** — Swipe right from the left screen edge opens the character sidebar; swipe left on the open sidebar closes it.
- **Encode tags / raw message display** — `encodeTags` setting renders message text as escaped raw text inside `<pre><code>` instead of rendered HTML/markdown.
- **External media policy** — `allowExternalMedia` setting extends the CSP `img-src` directive with `*` when enabled, allowing chat messages to load images from external URLs.
- **Browser-specific patches** — Firefox `<q>` copy sanitization, Safari body class detection, and mobile viewport hack for GBoard. Ported from old `browser-fixes.js` into `client/src/lib/browser.ts`.
- **Fuzzy character search** — `fuzzySearch` setting toggles Fuse.js fuzzy matching in the character list search bar (name + tags).
- **Context menus** — Shared `ContextMenu` component with item icons, danger styling, click-outside/Escape dismissal; wired to character cards in the sidebar.
- **Character hotswap bar** — `showHotswapBar` setting toggles a quick-switch bar of recently used characters above the chat.
- **Message actions always visible** — Action buttons on chat messages are now always visible on desktop instead of being hidden until hover.
- **Auto-select input on chat switch** — Focuses + selects textarea when `activeChatId` changes.

### Template-Based Tool Architecture

- **Tool Template interface** — `ToolTemplate` defines `getDefinition()`, `execute()`, `serialize()`, `deserialize()`. Built-in templates (assets, agent, lua_runner, **forge_image**) and Lua templates (dice, time, encouragement, memory, todo) both implement the same interface.
- **Forge Image Generator (`forge_image`)** — Built-in tool template for Stable Diffusion via Forge/A1111. Calls `/sdapi/v1/txt2img`, supports prompt, negative prompt, orientation (square/portrait/landscape), and Lua `requestScript` hook for mutating the request body. Generated images saved as attachments and returned as inline `image` content parts.
- **Speak (`speak`)** — Built-in tool template for TTS. Uses the existing `TtsAdapter` layer (`FishAudioS2Adapter`, `KokoroFastApiAdapter`). The LLM calls `speak(text)` with natural-language prosody tags (e.g. `[whisper in small voice]`), the tool generates audio via the configured provider, saves it as an attachment, and returns `{{attachment::ID}}` for the client to render as an inline audio player. Supports per-toolset config overrides (provider, voice, URL, API key) and a Lua `requestScript` hook.
- **Toolset model** — User-created `Toolset` instances reference a template by ID, with per-instance `config` and per-tool `toolOverrides` (name, description, parameter descriptions). No `templateType` discriminator — templates are looked up by ID only (built-ins first, then Lua).
- **Branch-aware state** — Tools within a template share state via `stateKey`. The executor stores `extra._toolState[stateKey]` on `tool_result` messages; on next execution `findLatestStateSnapshot()` scans `context.messages` backwards, making state naturally fork-aware across chat branches.
- **Lua tool contract** — Scripts return `getDefinition()` with `tools: [...]` array and receive `toolName` as 3rd arg to `execute()`. The `LuaToolExecutor` caches compiled Lua and invalidated on template updates.
- **Tool Registry** — IoC registry resolves toolsets → templates, applies overrides, and executes tools. `getDefinitionsByToolsets()` returns backend tool definitions for the prompt pipeline.
- **WebSocket CRUD** — `toolset.create/update/delete` and `toolTemplate.create/update/delete` messages with corresponding broadcast events.
- **Client UI (`ToolsModal`)** — Two-column layout: toolset cards with enable/disable toggle, inline name/template/config editors, per-tool override editors; Lua template list with auto-save code editor (600ms debounce). Create → edit pattern (no explicit Save buttons).

### Architecture & Polish

- **Active Entity pattern** — Every major entity type (characters, personas, world info, presets) follows snapshot flow: `activeXId` in `uiStore`, `activeX` in `serverStore`, `X.select` → `X.snapshot`.
- **Personas coupled to chats** — `persona_id` on `chats` table. Generation reads from chat, not action parameter.
- **Default persona concept removed** — Always ensure at least one persona exists; delete blocked if count ≤ 1.
- **Client ID negotiation** — Server assigns `c:N` IDs on connect; broadcasts carry originator ID.
- **Data trimming (summary types)** — `CharacterSummary`, `PersonaSummary`, `PresetSummary`, `WorldInfoSummary` for list broadcasts.
- **Active entity sync + dirty gates** — Editor modals re-sync from server but bail early while `dirty()` is true.
- **Lorebook refactor** — Removed `character_book` JSON blob; replaced with `world_info_id` FK. `WorldInfoEditor` becomes single editor for both global and character-linked lorebooks.
- **Inline CSS purge** — Extracted ~40 inline `style={{...}}` blocks into proper CSS classes + utility classes.
- **CSS architecture refactor** — Split `global.css` into `utilities.css` + `global.css`. Migrated to native nested CSS.
- **Design token consolidation** — Added missing semantic tokens, replaced 15+ hardcoded `rgba(...)` values.
- **Message tree index** — Composite `idx_messages_chat_parent` covering `getSiblings` exactly.
- **Virtual greeting materialization** — Client-driven lazy materialization of character greetings. Swiping cycles `chat.metadata.selectedGreetingIndex` with no DB writes.
- **Connection status indicator removed** — Stripped broken indicator and all supporting infrastructure.
- **Developer tooling** — Prettier (2-space, single quotes, trailing commas, 120 width) and ESLint (TypeScript + SolidJS-aware).
- **Backend configs** — `BackendConfigModal` + `BackendConfigService` + `backend_configs` table provide reusable named connection profiles (api_url, api_key, model, provider, samplers, logit bias, Lua request transformer, instruct template) with live model listing via `/api/models`. Subsumes the SillyTavern per-preset connection config and the cancelled "Connection Manager" extension.
- **Prompt lists (Prompt Manager)** — `PromptListModal` + `PromptListService` + `prompt_lists` table: orderable prompt lists with per-entry enable/role/content editors and multiple named lists.
- **Outbound proxy** — `proxy.ts` honors `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` env vars (and DB settings) to route outbound backend requests through HTTP/HTTPS/SOCKS proxies.

### Localization

- **i18n infrastructure** — `@solid-primitives/i18n` provider + `useI18n()` (the client's first Solid Context). English is bundled as the `createResource` `initialValue` (no first-paint fetch); other locales lazy-load via `import.meta.glob` and deep-merge over English (identity fallback).
- **English fully extracted** — Every user-facing string across all 34 components moved into per-domain fragments under `client/src/i18n/locales/en/` (~600 keys: inline JSX, tooltips, placeholders, popup messages). `useI18n()` returns a static English fallback translator when used outside the provider, so the existing component tests render without provider wrapping.
- **Locale persistence** — Active locale stored in `AppSettings.language` (server source of truth), hot-switched via the existing `settings.set` WebSocket path (no reload), with `<html lang>` kept in sync. Language picker in `SettingsModal`.
- **Status** — Only `en` ships. Adding a language is a drop-in: a `locales/<code>.ts` exporting a partial `RawDictionary` + a `REGISTRY`/`LOCALES` entry. RTL and locale-aware date/number formatting deferred (parity with SillyTavern).

### Database & Migrations

- **Migration chain squashed** — All internal migrations consolidated into `001_init.sql`, with `002_add_chat_materialized.sql` added subsequently for the chat-materialized view.
- **Global message pool** — `chat_id` dropped from `messages`. Reachability via `parent_id` chains from `chats.active_child_id`.
- **Soft/hard fork schema** — `forked_from_chat_id` / `forked_at_message_id` on `chats`.
- **DataMaid GC rewrite** — Global mark-and-sweep orphan deletion.
- **StatsService rewrite** — Recursive CTEs compute per-chat message counts based on reachability.
- **Import-legacy audit & fixes** — Fixed `active_child_id`/`head_message_id` semantics, `character_book` → `world_info_id` import, `vectorized` → `retrieval_mode: 'semantic'` mapping.

### Security Audit (April–May 2026)

- **Shared-secret authentication** — `TAMARI_SECRET` env var. All `/api/*` endpoints require Bearer token. WebSocket validates token from URL query params.
- **Auth login modal** — Client `AuthGate` prompts for secret, stores in `localStorage`.
- **CSP + security headers** — `helmet` with strict CSP.
- **WebSocket origin validation** — `verifyClient` rejects cross-origin connections.
- **Path traversal fix** — `FileStorage` validates paths, rejects `..`, verifies prefix.
- **Response header injection fix** — `Content-Disposition` filenames sanitized.
- **Lua sandbox hardening** — Stripped `load`, `loadstring`, `enableProxy: false` in `RequestScript`.
- **SSRF mitigation** — Blocks private IP ranges and non-HTTP(S) schemes after Lua mutation.
- **SQL injection pattern fix** — `hasColumn` uses parameterized queries.
- **Body limits** — `express.json` 5MB, WebSocket `maxPayload` 1MB.
- **Reconnection spam fix** — Stops auto-reconnecting after `auth.error`.
- **ReDoS mitigation** — `RegexEngine.ts` enforces `MAX_INPUT_LENGTH = 100_000` and `MAX_EXECUTION_MS = 5_000` per-rule timeout guard.
- **SSRF hardening** — `RequestScript.ts` rewritten with `ipaddr.js` to block all loopback variants, IPv4-mapped IPv6, decimal/octal IPs, and private ranges. DNS rebinding mitigated by resolving at time-of-use.
- **Avatar MIME validation** — `ALLOWED_AVATAR_MIMETYPES` allowlist (PNG, JPEG, WebP, GIF) on character/persona upload endpoints.
- **Request body scrubbing** — `RequestLogger.ts` recursively scrubs sensitive keys (`api_key`, `token`, `secret`, `access_token`, etc.) from JSON request bodies before logging.
- **SQL injection fix** — `QuickReplyRepository.ts` whitelists `ALLOWED_QR_COLUMNS` before interpolating dynamic keys into SQL.
- **TypeScript cast cleanup** — Removed 6 unchecked `as` casts across `GeminiBackendAdapter.ts`, `charx.ts`, `ChatCompletionRenderer.ts`, `serverStore.ts`, and `ChatView.tsx`.
- **AGENTS.md compliance** — Canonical URL enrichment on server (`withCharacterAvatar`, `withPersonaAvatar`, `withChatUrls`) adds `export_url`, `charx_url`, `avatar_upload_url`, `jsonl_export_url`, `txt_export_url`. All heuristic URL construction removed from client (`CharacterEditor.tsx`, `ChatHeader.tsx`, `PersonaManager.tsx`).
- **Client architecture fixes** — Removed `state.chats.find(...)` lookups for group-chat detection; server now auto-sends `group.members` on `chat.select`. Extracted message list assembly from `ChatView.tsx` into `getVisibleMessages()` helper. Avatar resolution now uses `state.chatCharacter` snapshot for non-group chats.

### Client Test Suite

- **619 tests across 52 test files** (all passing, as of July 2026 — the count grows continuously). Built incrementally in 6 phases; the per-phase breakdown below covers the original 465 tests.
- **Stack**: Vitest + `@solidjs/testing-library` + jsdom + `@testing-library/jest-dom`.
- **Phase 1 — Infrastructure + utilities (127 tests)**: Vitest config, WebSocket mock, `lib/` tests (markdown, auth, API fetch, regex, charx, slash commands), simple store tests (toast, popup, lightbox, dnd, uiStore).
- **Phase 2 — Bus + server store (96 tests)**: `WebSocketBus` (18), `serverStore` (78) with dynamic-import isolation for global bus handlers.
- **Phase 3 — Components (99 tests)**: `ToastContainer`, `PopupContainer`, `SafeImage`, `ImageLightbox`, `ThemeInjector`, `BackgroundInjector`, `DesignTokenInjector`, `AuthGate`, `QuickReplyBar`, `QuickReplyEditor`, `AuthorsNotePanel`, `CheckpointsPanel`.
- **Phase 4 — Library modules + mid components (62 tests)**: sound, upload attachments, `materializeChat`, `StatsModal`, `ChatHeader`, `GroupChatPanel`, `CropModal`.
- **Phase 5 — Complex components (41 tests)**: `getVisibleMessages`, `WorldInfoEditor`, `PersonaManager`.
- **Phase 6 — App shell + major components (40 tests)**: `App` (drag-drop, layout), `Sidebar` (filter, sort, pagination, modal triggers), `MessageInput` (send dispatch, slash autocomplete, streaming state, lock/unlock, attachments).

**Type safety:**
- All 52 test files pass `tsc --noEmit` with `strict: true`. Test mocks match `@tamari/types` interfaces exactly — no `as any` casts or exclusions.
- `serverStore.ts` exports `ServerState` interface for test consumption.

**Testing conventions established:**
- `serverStore.ts` registers global `bus.on()` at import time — tests use `vi.resetModules()` + dynamic `import()` for isolation.
- `state.clientId` must be set directly for own-client detection in WS handlers.
- `activeChatId()` signal from `uiStore.ts` is checked by store handlers, not `state.activeChat`.
- jsdom quirks documented (empty `alt` → `presentation`, `File.prototype.arrayBuffer` missing, SolidJS uncontrolled `<select>` requires manual `value` set, `createResource` errors need `ErrorBoundary`, etc.).

---

## Deleted / Intentionally Omitted

- `public/script.js` monolith
- `public/scripts/sse-stream.js`, `streaming-display.js`
- `public/scripts/sysprompt.js` (parallel preset system)
- Story string template system (`renderStoryString`)
- Client-side macro regex engine (`substituteParams`)
- User prompt bias — Replaced by native `assistant_prefill` support and Quick Reply Lua scripts.
- `chat_start_string` — Redundant with system prompts and preset prompt injections.
- System / narrator / comment messages — OOC is handled by normal message content.
- Translate extension — Modern LLMs roleplay natively in any language.
- Token Counter extension — Per-message token counts already displayed in headers.
- Connection status indicator — Old indicator tracked backend reachability, not server connectivity; was broken and misleading.
