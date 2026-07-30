# Pending Features

Master checklist of user-facing features that remain to be ported or implemented (Phase 3 onward). Features are grouped by domain and tagged with priority/complexity.

**Legend:**
- 🔴 **Blocker** — Required for a usable tamari release.
- 🟡 **Important** — Expected by existing users; should ship shortly after core release.
- 🟢 **Nice-to-have** — Can follow in point releases.
- ⚠️ **DISCUSS** — Questionable value, high maintenance burden, or conflicts with the new architecture. Needs explicit owner approval before implementation.

---

## 1. Macro System Parity

✅ **Complete.** All planned macros from SillyTavern have been ported.

| Feature | Status | Notes |
|---|---|---|
| ~~**Chat inspection macros**~~ | 🟡 ✅ | `lastMessage`, `lastMessageId`, `lastUserMessage`, `lastCharMessage`, `firstIncludedMessageId`, `currentSwipeId`. Query `MacroContext.messages` passed from `PromptBuilder`. |
| ~~**State macros**~~ | 🟡 ✅ | `lastGenerationType` (populated by `GenerationService`), `hasExtension` (checks `MacroContext.extensions`). |
| ~~**Loop / `{% for %}` block**~~ | 🟡 ✅ | `{% for varName::item1::item2::item3 %}...{% endfor %}`. Temporarily registers loop variable + `forIndex`. |
| ~~**Legacy variable shorthand**~~ | 🟡 ✅ | `{{.varname}}` → `macroVars`, `{{$varname}}` → `globalVars`. Handled in `evalExpr` fallback. |
| ~~**Macro autocomplete**~~ | 🟡 ✅ | Client-side dropdown in `MessageInput`. Triggers on `{{`, filters as you type. Enter/Tab to insert. |
| ~~**Resolve macros in stop strings**~~ | 🟢 ✅ | `customStoppingStringsMacro` — `GenerationService.resolveStopStrings()` runs `MacroResolver` over custom stopping strings before sending. Old `power_user` setting. |

---

## 2. Presets & Templates

| Feature | Priority | Notes |
|---|---|---|
| **Instruct templates for remaining HF models** | 🟢 | **33 built-in templates now ship** (see `server/src/pipeline/renderers/InstructTemplate.ts`): Alpaca, ChatML, Llama 2/3/4, Mistral 7B (v0.1/v0.3) / Nemo / Large 2411 / V3, Gemma 4, Nemotron 3, Phi-4 (mini / reasoning-plus), Granite 4.0, MiniMax-text-01, Kimi K2.6, GLM 5.1, Qwen 3.5/3.6, DeepSeek V4 Pro — most with normal + thinking variants. Still need: Cohere (Command R), THUDM (GLM-4), Tulu, older Gemma 2/3, Llama 3.1/3.2/3.3, and the long tail of the top-1000 HF downloads. No `hf-models-report.md` exists yet; the "~775" figure is a one-time scrape. |

---

## 3. Backend Adapters

| Feature | Priority | Notes |
|---|---|---|
| **NovelAI** | 🟢 | Kayra/Sigurd models, custom streaming format, custom tokenization. |
| ~~**Azure OpenAI**~~ | ❌ | **Explicitly rejected.** Use any adapter with the Lua request transformer. |
| ~~**AI Horde**~~ | ❌ | **Not planned.** Async generation queue, worker selection, kudos system. |

---

## 4. Character Cards

| Feature | Priority | Notes |
|---|---|---|
| **Character card V3 (decorators)** | 🟢 ✅ (partial) | `WiDecoratorParser.ts` parses `@@`-decorators (incl. `@@@` fallback); `WorldInfoInjector` honors `@@activate`, `@@dont_activate`, `@@depth`, `@@role`, `@@keep_activate_after_match`, `@@dont_activate_after_match`, `@@activate_only_after`, `@@activate_only_every`, `@@additional_keys`, `@@exclude_keys`. Parsed but ignored: `@@scan_depth`, `@@is_greeting`, `@@ignore_on_max_context`. **`@@position`** (recognized no-op): anchors content to a named prompt slot — spec values are `after_desc` / `before_desc` / `personality` / `scenario`; implementing it means extending the WorldInfo position enum with those slots (highest-value missing decorator; per spec it takes precedence over `@@depth`). **`@@reverse_depth` / `@@instruct_depth` / `@@reverse_instruct_depth` / `@@token_depth`: ❌ intentionally skipped** — these come from RisuAI's text-completion world and the spec says chat-based apps *SHOULD* ignore them (`@@reverse_depth N` ≡ `@@depth <messageCount> - N`). Note: `@@activate_only_after` counts total messages (spec says assistant messages); `@@activate_only_every` is implemented as cooldown, not "every Nth turn". |
| ~~**Character card V3 (macro extensions)**~~ | 🟢 ✅ | Added to `MacroResolver`: `{{reverse::A}}` reverses A; `{{comment::A}}`, `{{hidden_key::A}}`, and `{{// A}}` resolve to empty string. tamari uses `::` delimiter consistently. |
| **Character grouping / bogus folders** | ⚠️ | "Bogus folders" are tag-based virtual folders. A proper tag filter system may obsolete this. |
| ~~**Character hotswap**~~ | 🟢 ✅ | `HotswapBar.tsx` quick-switch bar of recently used characters, toggled by the `showHotswapBar` setting. |

---

## 5. World Info (Advanced)

| Feature | Priority | Notes |
|---|---|---|
| ~~**Sticky entries**~~ | 🟡 ✅ | Once activated, stay in context for N messages even if trigger is gone. Implemented branch-aware in `WorldInfoInjector`. |
| ~~**Cooldown / Delay**~~ | 🟡 ✅ | Message-count-based activation delays. Implemented branch-aware in `WorldInfoInjector`. |
| **Group scoring** | ⚠️ | Multiple entries from the same group compete for token budget. The "scoring" part is a legacy 8k-context artifact, but **groups letting one lorebook entry deactivate another** is a real use case. Not yet implemented (no `group` field on `WorldInfoEntry`). |
| **Outlet entries** | ⚠️ | Entries that modify *where* content is injected. Never seen in the wild — mark for later investigation. |
| **Min activations / overflow alerts** | 🟢 | Warn user if expected entries didn't fire. |
| **AN integration** | 🟢 | World Info can inject into Author's Note slot. |

---

## 6. Group Chats

| Feature | Priority | Notes |
|---|---|---|
| **SWARM activation strategy** | 🟢 | Listed in old docs but never implemented in tamari. Current strategies are `NATURAL`, `LIST`, `MANUAL`, `POOLED`. |
| **Group chat queue display** | 🟢 | Visual indicator of which character is "typing" next in auto mode. |

---

## 7. Extensions (Built-in)

SillyTavern has ~15 built-in extensions. The new extension system (Phase 4) needs to land first, then these migrate.

| Extension | Priority | Notes |
|---|---|---|
| **TTS — additional providers** | ✅ (9 added) | **Nine providers ported from official API docs** (not the legacy code): ElevenLabs, OpenAI, Azure Speech (SSML), MiniMax (**hex**-encoded audio), VolcEngine (**base64**, `Bearer;token` semicolon auth), AllTalk, VITS (vits-simple-api), Silero (`ouoertheo/silero-api-server` wrapper), GPT-SoVITS (`api_v2`). Each is a `TtsAdapter` (`server/src/tts/*Adapter.ts`) returning raw bytes; the `speak` tool's `configSchema` gained a generic `model` + `appId` field (Azure region folds into `baseUrl`; GPT-SoVITS `voiceId` is the server-side ref-audio path). Covered by per-adapter unit tests (request shape + hex/base64 decode + SSML) and factory tests. **Not done:** Edge, Google Native, XTTS/Coqui, SBVITS2, GSVI — and Bert-VITS2-standalone/so-vits-svc were skipped as incompatible dialects / voice-conversion (the `vits` adapter covers the family). |
| ~~**Memory / Summarization**~~ | 🟡 ✅ | `MemoryService` produces a rolling summary anchored to a user message, branch-aware, with `[msg:ID]` citations stored in `extra.memory`. Injected as a synthetic system message at the start of history; a `memory` tool template exposes retrieval to the LLM. (Sliding-window truncation was the original plan; summarization superseded it.) |
| **Expressions / Sprites** | 🟢 | Character expression images based on mood detection (via LLM or local classifier). Includes sprite management endpoint, ZIP upload, RisuAI import, `#none` and `#emoji` fallbacks, and Visual Novel fullscreen layout mode. |
| **Gallery** | 🟢 | Browse character images in a gallery view. Depends on image metadata indexing. |
| ~~**Connection Manager**~~ | ❌ | **Cancelled.** Per-preset connection config (`api_url`, `api_key`) already covers the 90% use case. |
| **Caption** | 🟢 | Auto-generate image captions (for vision). SillyTavern had local transformers.js pipeline (`/caption`) and Claude-based captioning (`/caption-image`). |
| **Attachments** | 🟢 | Partially replaced by native attachment upload in tamari. May not need separate extension. |
| **Assets** | 🟢 | Shared asset library for characters. |
| **Local speech recognition (ASR)** | 🟢 | Local transformers.js ASR (`/recognize`) using WaveFile format. Old endpoint in `src/endpoints/speech.js`. |
| ~~**Stable Diffusion — img2img**~~ | 🟢 ✅ | `forge_image` tool template now uses the shared `applyRequestScript()` (full `request.url/method/headers/body` access) and exposes a `files` config field with multiple-upload support. Users can write Lua to do img2img, ControlNet, or whatever complicated bullshit they want. |

**DISCUSS — Extension candidates for removal:**

| Extension | Reasoning |
|---|---|
| **HypeBot** | ⚠️ Niche meme extension. Low usage, high maintenance. |
| **RVC** | ⚠️ Real-time voice conversion. Extremely niche, requires external ML pipeline. |
| **Dice** | ⚠️ Already covered by `{{roll}}` macro and built-in `dice` tool template. |
| **Objectives** | ⚠️ Quest-tracking extension. Complex, low adoption. May be better as a user script via Quick Reply. |

---

## 8. Slash Commands & Lua API Parity

### tamari Client Commands
**Ported:** `/send`, `/sys`, `/reset`, `/cut`, `/continue`, `/name`, `/impersonate`, `/regenerate`, `/regen`, `/swipe`, `/persona`, `/char`, `/lock`, `/unlock`, `/bg`, `/theme`, `/wi`, `/ask`, `/sysgen`, `/gen`, `/genraw`.

### Lua `st` API (Quick Reply)
The Lua API now covers the vast majority of legacy slash commands. Implemented functions include:

**Chat actions:** `send`, `continue`, `impersonate`, `regenerate`, `swipe`, `cut`, `edit`, `delete`, `hide`, `unhide`, `stop`, `reset_chat`, `add_swipe`, `set_active_child`, `trigger`, `send_as`, `send_narrator`, `comment`, `delete_by_name`, `set_message_role`, `set_message_name`, `set_message_extra`, `get_message_extra`, `repair_active_child`, `new_chat`, `rename_chat`, `delete_chat`, `temp_chat`, `ask`, `sysgen`, `genraw`.

**Queries:** `get_messages`, `get_chat`, `get_characters`, `find_character`, `get_character`, `get_personas`, `get_persona`, `get_message_by_id`, `get_message_count`, `get_last_message`, `get_head`, `get_active_child`, `get_swipes`, `get_siblings`, `get_children`, `get_message_chain`, `get_chats`, `get_message_at`, `get_message_index`, `find_message_by_content`, `find_messages_by_name`, `find_messages_by_role`, `messages_as_text`, `get_message_texts`.

**Character / Persona:** `set_persona`, `set_character`, `get_character_id`, `get_persona_id`, `get_character_name`, `tag_add`, `tag_remove`, `tag_list`, `set_system_prompt`, `get_system_prompt`.

**Branching:** `branch`, `checkpoint`, `hard_fork`.

**Settings / Presets / Backend:** `get_setting`, `set_setting`, `get_settings`, `get_backend_configs`, `get_backend_config`, `set_backend_config`, `get_model`, `set_model`, `get_api_url`, `set_api_url`, `get_temperature`, `set_temperature`, `get_max_tokens`, `set_max_tokens`, `get_context_length`, `set_context_length`, `get_backend`, `set_backend`.

**Variables:** `setvar`, `getvar`, `clear_variables`, `get_variables`.

**Author's Note:** `set_author_note`, `get_author_note`.

**Chat Metadata:** `set_chat_metadata`, `get_chat_metadata`.

**Delay:** `delay`.

**World Info:** `wi_list`, `wi_get`, `wi_add`, `wi_remove`.

**Utilities:** `token_count`, `count_tokens`, `upper`, `lower`, `trim_tokens`, `replace`, `replace_regex`, `match`, `test`, `substring`, `trim_start`, `trim_end`, `random`, `now`, `join`, `split`, `includes`, `starts_with`, `ends_with`, `json_encode`, `json_decode`, `abs`, `floor`, `ceil`, `round`, `clamp`, `array_wrap`, `array_unwrap`, `pass`, `is_empty`, `len`.

**Reasoning / Generation Info:** `get_reasoning`, `set_reasoning`, `clear_reasoning`, `get_generation_info`.

**Previously blocked — all now implemented:**

| Command | Priority | Behavior in New System | Notes |
|---|---|---|---|
| ~~`/ask`~~ | 🟡 ✅ | Generate a response as a specific character. | `GenerationService.handleAsk` resolves the character by name and reuses the group-chat character-override path. Lua: `st.ask`. |
| ~~`/sysgen`~~ | 🟡 ✅ | Generate a system/narrator message via LLM. | `handleSysGen` delegates to `handleGen` and appends the result as a system message; no distinct narrator framing yet. Lua: `st.sysgen`. |
| ~~`/gen`, `/genraw`~~ | 🟡 ✅ | Raw generation without chat context. | `handleGenRaw` builds a minimal single-message prompt, bypassing the pipeline entirely. Lua: `st.genraw`. |
| ~~`/wi`~~ | 🟡 ✅ | World info CRUD shortcuts. | `WorldInfoRepository` wired into `StApiDeps`; `wi_list`, `wi_get`, `wi_add`, `wi_remove` implemented. |

**Intentionally removed from core:**

| Feature | Reason |
|---|---|
| **STScript closures & scopes** | ⚠️ Replaced by Lua 5.4 (wasmoon) in Quick Reply. |
| **Slash command debugger** | ⚠️ Only needed because the scripting engine was so complex. |
| **Pipe syntax & return value chaining** | ⚠️ Simpler model: commands are fire-and-forget server actions. |

---

## 9. UI / Theming

| Feature | Priority | Notes |
|---|---|---|
| **Message ID display** | ⚠️ | Show internal message index. **DISCUSS:** Debug feature exposed to users. Do we need it in production? |
| **Zen sliders** | ⚠️ | Minimalist UI mode. **DISCUSS:** What does this actually do? Is it distinct from a well-designed default UI? |
| **Lab mode** | ⚠️ | Experimental features toggle. **DISCUSS:** Lab for what? If we don't have experimental features, we don't need a lab mode. |
| **Image overswipe** | ⚠️ | Swiping on an image triggers image generation. **DISCUSS:** Extremely niche interaction. Conflicts with standard gallery swipe. |
| **Mobile responsive polish** | 🟢 ✅ (mostly) | Halved spacing tokens and radii on mobile; fixed chat overflow with `min-width: 0`; input area wraps to two rows; message actions always visible (no hover opacity); message header refactored into left/right divs with burger menu on mobile; modal padding reduced; world info grid collapsed; stats grid 2×3. **Since landed:** all modals become bottom sheets under 768px (`utilities.css` `modal-slide-up`), 44px minimum tap targets on icon/action buttons, sidebar edge-swipe gesture, `visualViewport` keyboard handling. Remaining: swipe gestures for message navigation (message swipes are button-driven only). |
| ~~**Toast position control**~~ | 🟢 ✅ | 6-position toast notification placement. Old `power_user.toastr_position`. |
| ~~**Stream fade-in**~~ | 🟢 ✅ | `streamFadeIn` setting; CSS keyframes fade streamed tokens in. |
| ~~**Focus-aware sound**~~ | 🟢 ✅ | `messageSoundUnfocusedOnly` setting; message sound is gated on window focus in `serverStore`. |
| ~~**Fast UI mode**~~ | 🟢 ✅ | tamari UI is already fast/no-nonsense by default. No dedicated toggle needed. |
| **Name display toggles** | 🟢 | tamari has a single combined `hideChatNames` toggle, not the split user/character controls (`allow_name1_display` / `allow_name2_display`) from SillyTavern. Splitting them is a minor follow-up. |
| ~~**Hide chat avatars**~~ | 🟢 ✅ | `hideChatAvatars` setting globally hides avatars in chat view. |
| ~~**Swipe numbers on all messages**~~ | 🟢 ✅ | `swipeNumbersOnAllMessages` setting shows the swipe count on every message, not just the last. |
| ~~**Unlocked context sizes**~~ | 🟢 ✅ | Number inputs already allow arbitrary context/response sizes; no slider cap to remove. |
| ~~**Token padding**~~ | ❌ | Rejected — confusing feature, unclear value in tamari budget model. |
| ~~**Expand message actions**~~ | 🟢 ✅ | Message actions are always visible by default on desktop. |
| ~~**Auto-connect / Auto-load chat**~~ | 🟢 ✅ | Automatically connect to last API and load last chat on startup. Old `power_user.auto_connect`, `auto_load_chat`. |
| ~~**Touch gestures**~~ | 🟢 ✅ | Swipe to navigate on mobile. Old `power_user.gestures`. |

---

## 10. UI Interactions, Behaviors & QoL

### 10.1 Avatar & Image Handling

| Feature | Priority | Notes |
|---|---|---|
| **Image metadata indexing** | 🟢 | SHA-256 hash, aspect ratio, animated detection, dominant color via Jimp. Old `src/endpoints/image-metadata.js`. Centralized index with virtual folders. Distinct from avatar thumbnails, which are already implemented. |
| **Image swipe / gallery** | 🟢 | Navigate between multiple media attachments in a message. |
| **Content seeding / seed manager** | 🟢 | Seed default content (characters, presets, themes, sprites, backgrounds, workflows, error pages, stylesheets, scaffolds) from `default/content/` and `default/scaffold/` on first run. Old `src/endpoints/content-manager.js`. |

### 10.2 Messages & Chat Navigation

| Feature | Priority | Notes |
|---|---|---|
| ~~**Swipe picker popup**~~ | 🟡 ✅ | Clicking the swipe counter opens a popup listing all swipes with content previews, active highlight, click-to-jump, and fork-from-historical-swipe. No server changes (reuses `chat.update` + `chat.softFork`). |
| ~~**Chat backups browser**~~ | ❌ | **Obsolete in tamari.** SillyTavern needed automatic JSONL backups because chats were stored as fragile flat files (partial writes, crashes). tamari uses SQLite in WAL mode with transactions — the database *is* the durability layer. Automatic snapshots would be redundant. If database-level backup is desired, it belongs in Phase 5 (polish) as `VACUUM INTO` snapshots or documenting `DATA_DIR` backup. |
| **Bookmarks / Checkpoints** | 🟡 ✅ | Backend `st.checkpoint()` Lua API exists. `CheckpointsPanel` UI added to `ChatHeader` for creating, browsing, restoring, and deleting checkpoints. |
| **Pinned / Recent chats** | 🟢 | Recent-chats browsing exists in the sidebar; pinning (`PinnedChatsManager`) is not yet implemented. Old `welcome-screen.js`. |

### 10.3 Character Management Interactions

| Feature | Priority | Notes |
|---|---|---|
| **Bulk character edit** | 🟢 | Select multiple characters via checkboxes, then delete or tag them all at once. |
| **Character context menu** | 🟢 | `ContextMenu` on character cards supports New / Edit / Export / Delete. **Duplicate** is not yet wired (no `character.duplicate` message type). |
| ~~**Character hotswap bar**~~ | 🟢 ✅ | Quick-switch bar of recently used characters at the top of the chat. |
| ~~**Fuzzy search**~~ | 🟢 ✅ | Fuse.js fuzzy matching in character list search bar. Old `power_user.fuzzy_search`. |
| **Tag import behavior** | 🟢 | ASK/KEEP/REPLACE when importing characters with tags. Old `power_user.tag_import_setting`. |
| **Tag sort mode** | 🟢 | Manual vs automatic tag sorting. Old `power_user.tag_sort_mode`. |

### 10.4 Settings & Accessibility

| Feature | Priority | Notes |
|---|---|---|
| ~~**Keyboard accessibility system**~~ | 🟡 ✅ | Done by other means: SillyTavern's MutationObserver approach was deliberately replaced with a component-level system — `client/src/lib/focusUtils.ts` (`trapFocus`, `saveFocus`/`restoreFocus`, `onEnterActivate`), consistent `role="button" tabindex={0}` + Enter/Space patterns across components, ~35 hand-written `:focus-visible` rules (not auto-generated from `:hover`), skip-link + aria-live announcements, `inert` toggling on background panels when modals open. |
| **A11y roles** | 🟢 | Semantic HTML should handle most cases; verify coverage. |
| ~~**Context menus**~~ | 🟢 ✅ | Shared `ContextMenu` component with click-outside/Escape dismissal, applied to character cards in the sidebar. |
| ~~**Encode tags**~~ | 🟢 ✅ | Raw-output display mode: render message text inside `<pre><code>` instead of markdown/HTML. DOMPurify already handles XSS sanitization. Old `power_user.encode_tags`. |
| ~~**Browser-specific patches**~~ | 🟢 ✅ | Firefox `<q>` copy sanitization, Safari body class detection, mobile viewport hack for GBoard. Old `browser-fixes.js`. |
| ~~**Custom HTML audio player**~~ | 🟢 ✅ | `AudioPlayer.tsx` inline player with progress bar, volume, and drag-scrubbing; wired into chat message rendering. |

---

## 11. Server Infrastructure & Utilities

Features from the old server that have no equivalent in tamari yet.

| Feature | Priority | Notes |
|---|---|---|
| **Web search & scraping** | ⚠️ | Proxy for SerpApi, SearXNG, YouTube transcript extraction. May be better as Lua tool templates. Old `src/endpoints/search.js`. |
| **Token Counter visualization** | 🟢 | Standalone popup showing tokenizer name, token IDs, and color-coded token chunks (rainbow per token) for pasted text. Old `extensions/token-counter/`. Distinct from per-message header counts. |
| **Persona description injection controls** | 🟢 | Persona description exists as a built-in prompt slot with the generic position / depth / order controls. Missing vs SillyTavern: lorebook linkage, show-notifications toggle, dedicated sort-order UI. Old `power_user.persona_description`. |
| ~~**Always force Name2**~~ | ❌ | Rejected — legacy quirk, not meaningful in tamari prompt pipeline. |
| **Smooth streaming sub-options** | 🟢 | Custom drain speed (`smoothStreamingDelay`) is implemented. Missing: the skip-reasoning-tags option (`smooth_streaming_no_think`). |
| **Data Maid interactive cleanup dialog** | 🟢 | Backend GC exists (`DataMaid.ts` — orphaned attachments/generations/chat-members, messages with deleted parents, filesystem orphans) with `scan()` + `clean()`. Missing: the browser UI, and several SillyTavern categories (chat/settings backups, background/persona thumbnails, group chats). Old `data-maid.js`. |
| ~~**Stats modal / report**~~ | 🟢 ✅ (partial) | `StatsService` + `StatsModal.tsx` ship: global counts (characters/chats/messages/generations/prompt+completion tokens), per-character and per-chat tables. Missing vs SillyTavern: total generation time, word counts, swipe counts, chat age. |
| **Server URL autocomplete history** | ❌ | Obsolete — replaced by per-preset connection config. |

---

## 12. Localization & SillyTavern-Audit Gaps

Features found in the SillyTavern codebase during the July 2026 roadmap audit that have no tamari equivalent and were previously absent from this list.

| Feature | Priority | Notes |
|---|---|---|
| **Internationalization (i18n)** | ✅ (infra) | **Infrastructure complete; English fully extracted.** `@solid-primitives/i18n` provider + `useI18n()` (the codebase's first Solid Context); English source split into per-domain fragments under `client/src/i18n/locales/en/` (~600 keys across all 34 components — inline JSX, tooltips, placeholders, popup messages); locale persisted in `AppSettings.language` (server source of truth, hot-switch via the `settings.set` WS path, sets `<html lang>`); Language dropdown in SettingsModal; `useI18n()` falls back to a static English translator so component tests need no provider wrapping. Only `en` ships — **remaining work** is selecting + translating locales (SillyTavern's 16 are the candidate pool; adding one = drop a `locales/<code>.ts` exporting a partial `RawDictionary` + a `REGISTRY` entry). RTL + locale-aware date/number formatting deferred (parity with SillyTavern). |
| **Advanced sampler parameters UI** | ✅ (subset) | **High-value local-LLM subset ported.** `BackendConfigModal` now renders a provider-gated "Advanced Sampling" section (`client/src/components/samplerProfiles.ts`): mirostat (mode/tau/eta), typical_p, tfs, penalty_alpha, DRY, XTC, smoothing, dynamic temperature, seed, EOS/BOS/skip-special-token toggles, banned tokens, and grammar (GBNF) — with per-provider wire names (llama.cpp / text / KoboldCPP / chat). Knobs are stored in `BackendConfig.providerParams` (no migration). **Per-knob enable/disable:** each sampler has a checkbox; unchecking omits it from the request while preserving the value (`providerParams.samplerDisabled` record) — for models that drop a sampler (e.g. Opus 4.6 `top_k`). **Also fixed a latent wiring bug:** the typed knobs and `providerParams` were stored but never reached any adapter — `GenerationService.buildBackendSettings` now merges them into the provider's `*.params` blob (de-duplicating three call sites), and `factory.ts` passes `openai.params` to the OpenRouter adapter. Chat profiles expose only `seed`. **Deferred:** `sampler_order` reorder UI (4 provider formats); the remaining ~40 niche knobs (epsilon/eta cutoff, rep_pen_range/slope, nsigma, adaptive_p, beam search, CFG) — niche needs stay covered by the Lua `requestScript`. `jsonSchema`/`response_format` explicitly rejected (fights the prompt/tool pipeline). Covered by unit tests + an e2e journey (`tests/journeys/sampler-wiring.spec.ts`) asserting knobs reach the LLM request body. |
| ~~**Secrets management UI**~~ | 🟡 ✅ | Full client UI: `SecretsModal.tsx` (CRUD with labels, masked values, reveal toggle; opened from the sidebar) + `SecretPicker.tsx` inserting `secret:<key>` refs, consumed by `BackendConfigModal` and `SchemaForm`; `client/src/lib/secrets.ts` talks to `/api/secrets`. **Per-provider multi-key pools (activate/deactivate, keys-exposure toggle): ❌ rejected** — SillyTavern's key pools were a rate-limit-rotation workaround, not a feature. Store backup keys as separate labeled vault entries and point the preset at the `secret:<key>` ref you want; if rotation ever becomes a real need, a per-key `disabled` flag is the preferred smaller change. |
| **Server-side plugin loader** | ⚠️ | SillyTavern let self-hosters drop a JS file in `./plugins/` to mount authenticated Express routes (SillyTavern's `plugins.js` + `src/plugin-loader.js`). tamari has Lua tools + pipeline hooks but no way to add HTTP routes. **DISCUSS:** add as pending, or explicitly omit (Lua tools + TSX components may cover extensibility). |
| **Variables UI (`/listvar`)** | 🟢 | Full data layer exists (`message.extra.macroVars`, `globalVars`, Lua `setvar` / `getvar`), but no UI to inspect/edit variables and no `/listvar` slash command. |
| **`chat_template` hash → preset auto-binding** | 🟢 | SillyTavern (`chat-templates.js`) hashed a GGUF's tokenizer `chat_template` and auto-bound the matching instruct/context preset. Big UX win for users who swap local models; no tamari equivalent. |
| **Welcome-page Assistant + shortcuts** | 🟢 | SillyTavern's welcome screen rendered a permanent Assistant character + greeting, a Temporary-Chat shortcut, and Docs/GitHub/Discord quick-links. tamari only shows "Select a chat." |
| **Markdown parity — dinkuses & underscore italics** | 🟢 | SillyTavern's `showdown-exclusion` left user-listed strings (e.g. `***`, `---`) untouched by markdown, and `showdown-underscore` enabled single-underscore italics. tamari's `marked` has neither; old cards authored with `_italics_` may render differently. |
| **In-chat reference messages** | 🟢 | SillyTavern (`system-messages.js`) built `help` / `welcome` / `hotkeys` / `formatting` / `macros` / `slash_commands` reference messages and a `SAFETY_CHAT` fallback when a character is deleted. No tamari equivalent. |
| **Docker compose + entrypoint** | 🟢 | tamari ships a `Dockerfile` but no `docker-compose.yml` or entrypoint helper (SillyTavern had both in its `docker/` directory). |
| **`maxToolRounds` user setting** | 🟢 | Tool-call loop depth defaults to 100 in `GenerationService` (`maxToolRounds` dep). SillyTavern exposed a 1–50 slider (`tool_call_recurse_limit`). |
| ~~**Tool `stealth` flag**~~ | 🟢 ✅ | Implemented as **`endsTurn`**: a tool definition flag that ends the generation turn after successful execution (no follow-up round). Deliberate semantic difference from SillyTavern `stealth`: the result is **not** hidden — it is saved and rendered, with display governed by the `renderType` contract. Used by `present_choices` (`lua_choices`). |

---

## 13. Legacy / Questionable Features — Needs Discussion

These features exist in SillyTavern but have unclear value, high maintenance cost, or conflict with the new architecture. **Do not implement without explicit approval.**

| Feature | Old Code | Case For | Case Against |
|---|---|---|---|
| **waifuMode** | `power-user.js` | Dedicated character-focused fullscreen layout. | Incompatible with new grid layout. Can be replicated with "Zen mode" or just good default UI. |
| **movingUI + movingUI presets** | `power-user.js`, `RossAscends-mods.js` | Users can drag and reposition panels. | Draggable panels fight responsive design and component boundaries. High complexity for low utility. |
| **auto_swipe** | `power-user.js` | Auto-swipe if response is too short or matches a blacklist word. | Encourages wasting API tokens. Blacklist-based auto-swipe is brittle. |
| **image_overswipe** | `power-user.js` | Swipe on images to generate new ones. | Non-standard interaction. Conflicts with attachment browsing. |
| **mesIDDisplay_enabled** | `power-user.js` | Show message index. | Debug feature, not a user feature. |
| **zoomed_avatar_magnification** | `power-user.js` | Magnify avatar on hover? | Extremely niche. |
| **bogus_folders** | `power-user.js`, `tags.js` | Virtual folders via tag prefixes. | Workaround for poor list UI. A good tag filter system removes the need. |
| **Spoiler-free mode** | `power-user.js` | Hides character description/first message to avoid spoilers. | Extremely niche. Can be replicated by collapsing character info panels. |
| **Itemized prompts (debug)** | `itemized-prompts.js` | Shows the raw prompt sent for each message. | Debug feature for power users. Can be replaced by a simple "view last prompt" button. |
| **Token probabilities / logprobs** | `logprobs.js` | Visualizes alternative tokens and their probabilities per generated token. | Extremely niche. Requires API support (OpenAI logprobs). Complex visualization UI. |
| **CFG Scale / Guidance** | `cfg-scale.js` | Classifier-Free Guidance UI with global/per-character scale, negative prompt, positive prompt, chat-level CFG. | Niche diffusion-inspired feature. Not mentioned anywhere in tamari. |

---

## 14. Security (Post-Audit)

Core auth, CSP, origin validation, path traversal, header injection, Lua sandbox, SSRF, ReDoS, SQL injection, and request-body scrubbing mitigations landed in the April–May 2026 security hardening passes. Remaining defense-in-depth items:

| Feature | Priority | Notes |
|---|---|---|
| **Rate limiting** | 🟡 ✅ (partial) | WS generation actions throttled: `SlidingWindowRateLimiter` (20 msgs / 60s per connection) covers `action.generate`, `regenerate`, `continue`, `impersonate`, `gen`, `genraw`, `ask`, `sysgen` (`dispatcher.ts`), over-limit messages get `RATE_LIMITED` errors. Still open: REST endpoints (no HTTP throttling) and non-generation WS message types. |
| ~~**Attachment MIME validation**~~ | 🟡 ✅ | Upload allowlist (`mimeAllowlist.ts`): `image/*`, `audio/*`, `video/*` + `text/plain`/`markdown`, PDF, JSON, octet-stream; HTML/JS/XML rejected. Download forces `Content-Disposition: attachment` for non-media types. Remaining gap: `image/svg+xml` passes the allowlist and is served inline — SVG can carry scripts (stored-XSS risk worth a second look). |
| **DOMPurify link hardening** | 🟢 | No `target="_blank" rel="noopener"` on links. External images not blocked (tracking pixels possible). |
| **Migration integrity checks** | 🟢 | Migration files run verbatim SQL with no checksum/signature validation. Low risk since files are shipped with the app. |
| **CSS injection (`themeCustomCss`)** | 🟢 | `/theme` slash command and `ThemeInjector` allow arbitrary CSS injection. Can exfiltrate data via attribute selectors. Single-user app — low priority. |

---

## 15. Scriptable Layers (RisuAI TriggerScript Replacement)

Design doc: `docs/design/scriptable-layers.md`. Three layers: **custom backends** (generation-time Lua), **display transforms** (render-time find/replace), **button protocol** (user-action postback). Guiding principles: code runs at generation time or user action (never at render), displayed history is immutable, interaction is honest text, credentials never enter Lua scope, one job per layer.

**Landed (server-side, tested):** Type A custom backends (registry scripts, `custombackend.*` WS CRUD, delegation by config id, depth cap 4); Type B card-coupled contextual backends (`character.extensions.contextualBackend`, travels with export, wraps the active adapter); script state protocol (`state` global ⇄ `extra._toolState` snapshots, branch-aware); `.risum` raw import + workbench exposure; blackjack e2e (`GenerationService.contextualBackend.test.ts`).

| Feature | Priority | Notes |
|---|---|---|
| ~~**`toolCalls` return mapping in `LuaBackendAdapter`**~~ | 🟡 ✅ | GenerationService's tool loop fires on `result.toolCalls` from any adapter (incl. custom); the Lua return contract now maps `toolCalls = { { name, arguments, id? } }` into it. Custom backends can request `speak`/`forge_image`/any registered tool; the follow-up round re-enters `generate()` with results as `tool_result` parts on the latest assistant prompt message. This is the media-delegation answer — no separate TTS/forge bridge needed. Covered by adapter unit tests + e2e (`GenerationService.contextualBackend.test.ts`). |
| ~~**Backend-logic dry-run workbench tool**~~ | 🟡 ✅ | `backend_logic_test` (Character Workbench, 25 tools total): feeds a sample user message (+ optional canned `state` and `luaSource` override) to the script's `generate()` against a recording delegate, returns `{ text, toolCalls, stateOut, delegations, usage, error }`. `stateOut` feeds back as `state` for multi-turn verification. Implemented in `server/src/backends/customBackendDryRun.ts`; runtime wired via `CharacterWorkbenchDeps.luaRuntime`. |
| ~~**Layer 3 — button protocol**~~ | 🟡 ✅ | `<button data-post-response="...">` in message HTML → click posts the value as the user's next message + generates (same sequence as `present_choices`). Landed: DOMPurify whitelist (`button`, `div`, `data-post-response` — with `ALLOW_DATA_ATTR: false` so it's the only surviving `data-*`), click handler in `ChatView` (live in the read-only virtual greeting too — the click sends `chat.materialize` first, then posts), button styling, markdown + component tests. `ctx.generationType` already lets backends distinguish regen/continue. The `data-post-response-fill` fill-only variant was deferred as unneeded. |
| ~~**Layer 3 — response forms**~~ | 🟡 ✅ | `<form data-post-response="root">` in message HTML → submit serializes fields to a flat, elements-only XML profile (always-escaped, so a documented 6-line Lua `gmatch` recipe parses it), wrapped in a ```` ```xml ```` fence, posted via the same `action.send` + `action.generate` sequence. Landed: `client/src/lib/responseForm.ts` serializer (HTML form semantics: checkbox/radio when checked, repeated names → repeated elements, name coercion, `file`/`password` ignored), mirrored DOMPurify whitelists (`form`/`input`/`select`/… tags + `name`/`type`/`value`/… attrs; `action`/`formaction`/`on*` deliberately excluded) with `SANITIZE_DOM: false` (DOMPurify's clobbering guard was eating `name="target"`), delegated `onSubmit` in `ChatView` (unconditional `preventDefault`, submittable in the read-only virtual greeting like buttons), form styling, serializer + markdown + DisplayRenderer + ChatView tests, and a blackjack-style e2e (`GenerationService.responseForm.test.ts`): the exact client payload parsed by the documented Lua recipe, verbatim honest text in the log, graceful degradation on a plain backend. Design: `docs/design/scriptable-layers.md` §4 "Forms". |
| ~~**Client UI for custom backends**~~ | 🟡 ✅ | Full UI landed. Type A: `CustomBackendsModal.tsx` (WS-driven CRUD, sidebar entry next to Secrets) + `custom` provider in `BackendConfigModal` (script dropdown, delegate dropdown excluding self, API URL/key hidden, `custombackend.list` on mount, empty selections drop the providerParams keys). Type B: `CharacterBackendEditor.tsx` ("Backend logic" section in the character editor, `extensions.contextualBackend`, reuses the auto-save path). Store: `state.customBackends` + four event handlers. New i18n fragment `customBackends.ts`. 18 new tests; suite 742/742, tsc clean. |
| ~~**Layer 2 — `replaceLua` for regex rules**~~ | 🟢 ✅ | `RegexRule.replaceLua` (types rebuilt): `replace(match, captures)` Lua replacement, takes precedence over `replaceString`, works for prompt AND display placement. Runs server-side in a 5s wasmoon sandbox wherever plain regexes run (PromptBuilder, DisplayRenderer, ChatBroadcastService); script failure skips the rule like a worker failure. Workbench `regex_add`/`regex_update` accept it; `regex_test` exercises it. Client UI: both regex editors (character + global settings) have a Text/Lua toggle, Lua field, and list badge; parse paths preserve the field. 9 engine tests + workbench round-trip + editor UI tests. **Still open:** `displayText` memoization + var-snapshot ctx. |
| ~~**Custom backends in group chats**~~ | 🟢 ✅ | Semantics ("active backend runs per speaker, scripts branch on `ctx.characterId`") verified by e2e: NATURAL-strategy group with one scripted + one plain character — the script answers only its own character's turns, the writer serves the other (`GenerationService.contextualBackend.test.ts`). Per-character backend override remains deferred by design. |
| ~~**Type A custom-backend workbench tools**~~ | 🟢 ✅ | Backend Workbench gained six tools: `custom_backend_list/get/create/update/delete` (with the dispatcher's rebroadcast semantics) + `custom_backend_test` (same recording-delegate dry-run as `backend_logic_test`, works on stored scripts by id or ad-hoc `luaSource`). Backend Workbench is at 11 tools; deps gained `customBackends` + `luaRuntime`. |
| ~~**Asset import for ported cards**~~ | 🟢 ✅ | Standalone `.risum` attach imports asset PAYLOADS as ordinary character assets (`storeRisuModuleAssets` — servable, re-exported with the card; verified against the real Lightboard packs: 61 mp3s/170MB, 1485 pngs/140MB, payload↔triplet alignment 1:1). Attach flow: the user attaches external modules DIRECTLY to the character — an "Attach .risum…" button in the character editor's module viewer (→ `POST /characters/:id/risu-module`). No chat-attachment detour and no filesystem paths cross the tool boundary; the workbench gets read access (`risu_module_*`, `character_asset_list`) once the user has attached. CharX-embedded modules still skip payloads (card assets already extracted). |
| ~~**Frontend porting tooling**~~ | 🟡 ✅ | Full stack done. Server: WS `custombackend.test` → `custombackend.testResult` dry-run pair (luaSource > registry id > character id resolution) + REST module reads (`GET /characters/:id/risu-modules[/:moduleId?section=…]`, extraction shared with the workbench). Client: shared `BackendDryRunPanel` (requestId-correlated, state feedback button, delegation previews) in the Custom Backends modal + character backend section, and read-only `RisuModuleViewer` in the character editor. Human and LLM porting loops are both fully in-frontend now. |
| ~~**Delegate reference portability**~~ | 🟢 ✅ | Documented in the design doc (§5): explicit `delegateConfigId` / `backends.generate("<id>", …)` is local-install-only; exportable cards must use default delegation, which resolves to the recipient's own active backend. Delegate-by-name fallback only if shared cards ever need explicit targets. |
| ~~**wasmoon timeout error mapping**~~ | 🟢 ✅ | `isLuaTimeoutError()` in `LuaRuntime.ts` matches the `Aborted(native code called abort())` shape; `LuaBackendAdapter` maps it to `custom backend "<name>": script timed out (<limit>s execution limit)`. The generate timeout is now injectable (`generateTimeoutMs`, default 10 min) for testability. |
| **`st` API in backend states** | ⚠️ | Design doc allows injecting the chat API with append-only ops if scripts need it. Not built; wait for a concrete card that needs it. |

**Big validation target:** port the Touhou Project Simulator card — import charx, attach the 4 Lightboard `.risum` modules, then agent-driven port via `risu_module_get` → `backend_logic_set`. Full fidelity needs the button protocol (Lightboard's reroll buttons) and the dry-run tool first.

---

## Appendix: Porting Checklist (Old → New File Map)

| Old File | New Location | Status |
|---|---|---|
| `public/scripts/openai.js` (7,080 lines) | `server/src/pipeline/` + `server/src/backends/` | 🟡 Partial |
| `public/scripts/macros/` (15+ files) | `server/src/pipeline/MacroResolver.ts` | 🟡 Partial |
| `public/scripts/power-user.js` (4,460 lines) | `server/src/services/PowerUserService.ts` + client settings | 🟡 Partial |
| `public/scripts/world-info.js` (6,289 lines) | `server/src/pipeline/WorldInfoInjector.ts` | 🟡 Partial |
| `public/scripts/slash-commands.js` (7,067 lines) | `client/src/lib/slashCommands.ts` + `server/src/dispatcher.ts` | 🟡 Partial |
| `public/scripts/group-chats.js` (2,490 lines) | `server/src/services/GroupChatService.ts` | 🟡 Partial |
| `public/scripts/extensions.js` (2,082 lines) | `server/src/extensions/` + `client/src/extensions/` | ❌ Not started |
| `src/prompt-converters.js` (1,445 lines) | `server/src/backends/converters/` | ❌ Not started |
| `src/endpoints/backends/chat-completions.js` (2,789 lines) | `server/src/backends/` (per adapter) | 🟡 Partial |
| `src/endpoints/stable-diffusion.js` | `server/src/services/templates/ForgeImageTemplate.ts` | ✅ Done (txt2img via tool template; advanced features pending) |
| `src/endpoints/thumbnails.js` | `server/src/api/thumbnails.ts` (planned) | ❌ Not started |
| `src/endpoints/sprites.js` | `server/src/api/sprites.ts` (planned) | ❌ Not started |
| `src/endpoints/classify.js` | `server/src/api/classify.ts` (planned) | ❌ Not started |
| `src/endpoints/caption.js` | `server/src/api/caption.ts` (planned) | ❌ Not started |
| `src/endpoints/search.js` | Lua tool template or `server/src/api/search.ts` | ⚠️ Undecided |
| `src/endpoints/content-manager.js` | `server/src/services/ContentSeeder.ts` (planned) | ❌ Not started |
| `src/endpoints/speech.js` | `server/src/api/speech.ts` (planned) | ❌ Not started |
| `src/endpoints/themes.js` | Settings REST or WS persistence | 🟡 Partial |
| RisuAI `.risum` / CharX `module.risum` | `server/src/lib/risum.ts` + `server/src/services/characterRisuModules.ts` + Character Workbench `risu_module_*` tools | ✅ Raw import done (full-fidelity preserve + workbench exposure for porting). Execution of ported behavior pending `docs/design/scriptable-layers.md` layers. |
