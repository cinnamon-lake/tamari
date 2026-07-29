# Character porting flow (RisuAI → tamari)

How to port a RisuAI card (CharX + `.risum` modules) to tamari using the Character
Workbench. tamari deliberately does **not** execute RisuAI triggerscripts, low-level
Lua, or CBS (`{{getvar::…}}`, `{{#if …}}`) — porting means re-expressing those
behaviors with three mechanisms:

| Mechanism | What it can do |
|---|---|
| `backend_logic` (card-coupled Lua) | Transform the outgoing prompt and pass through (`return { __passthrough = true, prompt = p }`), delegate generation (`backends.generate(p):await()`), post-process returned text, keep per-chat `state` (branch-persisted). |
| Regex rules (incl. `replaceLua`) | Static/dynamic find-replace on the prompt (`prompt=true`) and on rendered messages (`display=true`), role-filterable. `replaceLua` gets only `(match, captures)` — **no state, no message index**. |
| Native lorebook entries | `keys[]`/`secondaryKeys`/`selective`/`constant`/`order`/probability/sticky/cooldown/delay. |

Hard boundaries (anything needing these is a redesign, not a transliteration):
no chat-history mutation, no UI (buttons, alerts, popovers), no events other
than generation (no input/output/display/start/manual hooks), no lorebook
reads from Lua, no asset playback.

---

## Phase 0 — Import (user action, not the agent's)

- Import the `.charx` in the UI. The CharX import extracts card fields, the
  `character_book` (→ the card's tamari lorebook, linked 1:1), card assets, and the
  embedded `module.risum` (stored raw; metadata in `extensions.risuModules`).
- Attach any standalone `.risum` files in the character editor (module viewer →
  "Attach .risum…"). Standalone-module asset payloads are imported as ordinary
  character assets tagged `origin: 'risu-module'` + `moduleId`. (Deliberate
  asymmetry: module *behavior* stays sealed and inert in the raw module, but
  asset payloads flatten into the card's store — bytes tamari can serve, code it
  cannot run. Removing the module later keeps the assets.)

## Phase 1 — Recon (read-only)

1. `character_get { characterId }` — full card; note `worldInfoId`, fields, tags.
2. `risu_module_list { characterId }` → for each module:
   - `risu_module_get section=info` — name/namespace/toggles/lowLevelAccess.
   - `section=triggers` — summaries; then `section=trigger index=N` for each
     interesting one (full effect JSON incl. Lua source).
   - `section=regex`, `section=lorebook` — the port material.
   - `section=assets` — metadata triplets.
3. `character_asset_list { characterId }` — what media exists.
4. `lorebook_get { characterId }` — the imported `character_book` entries.
5. `regex_list { characterId }` — any tamari rules already present (SillyTavern
   `extensions.regex_scripts` are converted at import).

Build a feature inventory before writing anything: every trigger (type +
effects), every regex (stage/type!), every lore entry, every CBS macro used in
card fields. **Regex `type` is load-bearing** — RisuAI stages map as:
`editprocess`→`prompt`, `editdisplay`→`display`, `editoutput`→`display` +
`aiOutput`, `editinput`→`prompt` + `userInput`, `edittrans`→`prompt` and/or
`display` (no exact equivalent).

## Phase 2 — Static port

1. **Card fields** (`character_update`): description/personality/scenario/
   postHistoryInstructions — strip or resolve CBS first (see traps below).
   `first_mes`: if it's a CBS switch-matrix, do NOT port verbatim — pick
   representative greetings (`alternateGreetings`) or defer to backend_logic.
2. **Lorebook**: the `character_book` is already imported. For module-native
   lore (`section=lorebook`): `lorebook_entry_add` per entry — split RisuAI's
   comma-joined `key` into `keys[]`, `secondkey`→`secondaryKeys` + `selective`,
   `alwaysActive`→`constant`, `insertorder`→`order`, `useRegex`→`regex`.
   **Skip entries that duplicate the character_book** (CharX-embedded module
   lore is the same data). Entries that are pure CBS-gated blocks belong in
   backend_logic instead (Phase 3), not in the lorebook.
3. **Regex rules** (`regex_add`): one per `section=regex` script, with the
   stage mapping above. Convert RisuAI patterns to delimited JS form
   (`/…/g`, add `i` if the original was case-insensitive). `$1` backrefs carry
   over. Replacements containing CBS or `risu-btn`/`risu-trigger` attributes
   must be rewritten (static HTML) or moved to backend_logic.
4. **Assets**: already on the card from Phase 0. When porting *between* cards:
   `character_asset_copy` / `character_assets_copy` /
   `risu_module_assets_copy`. Set the avatar with `character_set_avatar`
   (attachment or `sourceCharacterId`).

## Phase 3 — Logic port (`backend_logic`)

Choose per feature; combine freely in one script.

- **Pattern A — prompt-transform + passthrough** (toggle-gated content,
  conditional system prompts, state seeding):
  ```lua
  function generate(prompt, ctx)
    if type(state) ~= "table" then state = { futa = 0, year = tonumber(os.date("%Y")) } end
    if state.futa == 1 then
      table.insert(prompt.messages, { role = "system", content = FUTA_BLOCK })
    end
    return { __passthrough = true, prompt = prompt }
  end
  ```
- **Pattern B — delegate + append** (side-channel generation like Lightboard):
  delegate the main reply with `backends.generate(prompt):await()`, build a
  second self-contained prompt (job instruction + recent chat slice + output
  schema — all inlined as Lua constants, since Lua cannot read lorebooks),
  delegate again, append the rendered block to the returned text.
- **Pattern C — output parsing → state** (`Year += 1`, `{ korea_country: japan }`):
  scan the returned text for the write-channel lines, update `state`, strip or
  rewrite the lines before returning.
- **Toggle UI → chat commands**: RisuAI buttons/alerts have no equivalent.
  Parse commands from the last user message (`/futa on`, `/year 1940`) and
  acknowledge in the returned text.
- **Dynamic display bits replaceLua can't do** (state-dependent rendering,
  recency gating, random picks that must match state): bake them into the
  returned text at generation time. `replaceLua` is only for pure
  match→string transforms (arithmetic, case logic, lookup tables).

Iterate with `backend_logic_test` (dry-run, canned delegation, `state`/`stateOut`
ping-pong) — never enable an unverified script. Save with `backend_logic_set`
(new scripts default to `enabled = false`; enable only after verification).

## Phase 4 — Verification

1. `regex_test { characterId, text, role }` for every ported rule — check both
   the prompt and display variants.
2. `backend_logic_test` per pattern: prompt injection (does the block land?),
   state transitions (feed `stateOut` back as `state`), delegation behavior
   (`delegations` log), error paths (`pcall` around `backends.generate` —
   hard failures throw).
3. Live chat smoke test, then `backend_logic_set { enabled = true }`.
4. Cleanup: `risu_module_remove` once a module is fully ported (its raw JSON
   stays until then — the safety net).

---

## Case study: the Touhou/Hearts bundle (checked 2026-07-24)

Source: `Touhou Project Simulator.charx` (V9.3) + 6 standalone modules,
`Hearts of Risu.charx` (V3.3), same author, one engine. Full-fidelity decode
of every module is available through `risu_module_get` (the project's own
RPack/TLV decoder; verified against these exact files).

### What the bundle is

- **Touhou card**: 46 KB description with ~29 `{{#if getvar}}` blocks; **163 KB
  first_mes = 112-branch greeting matrix** (14 places × 2 familiarity × 4
  languages); 210-entry book (~8 "Settings" entries are fully CBS-gated);
  694 assets; embedded module: 56 triggers (54 manual button-cyclers driving
  ~25 toggle vars, dice via `v2Random`+`v2Impersonate`, cosplay via
  `v2SystemPrompt`), 32 regexes (13 `edittrans` Korean normalizers, rich
  display HTML for status/news/BBS/portraits, recency-gated).
- **Hearts card**: HOI4-style map sim. 32 always-active leader-bio lore
  entries; the map is ~360 `*_country`/`*_color` vars written by the model via
  `{ prov_country: x }` chat lines (`{{setvar}}` inside editoutput/editinput
  regexes) and rendered as a 47 KB HTML map with double-dereferenced
  `{{getvar::{{getvar::X}}_color}}`.
- **Lightboard Backend V3**: 1,145-line low-level Lua mini-framework —
  after each reply, per manifest (stored as lorebook key=value entries) it
  builds a standalone prompt and side-generates newspaper/BBS blocks, appending
  them to the last message; plus reroll/interaction buttons. Lore-as-code:
  `lightboard-prelude` (10.6 KB Lua), `toon.*`, manifests, format schemas.
- **Bunbunmaru / Kakashi / Gensonet**: miniboard renderers (~200 lines Lua
  each) + 7 prompt-fragment lore entries each.
- **Music / NSFW modules**: pure asset packs (61 mp3, 1,485 png).

### Target architecture per card

**Touhou** — one backend_logic script combining all three patterns:
- `state` seeded from `defaultVariables` (note `year = {{time::YYYY}}` →
  `tonumber(os.date("%Y"))`); chat commands replace the 54 toggle buttons.
- Pattern A injects the active "Settings" blocks (futa/gl/yandere/horror/…,
  inlined from the gated lore entries) and the cosplay checklist.
- Pattern C handles `Year += N`.
- first_mes: ship 3–5 representative greetings as `alternateGreetings`; do not
  port the 112-branch matrix.
- Regexes: the 13 `edittrans` normalizers (prompt+display), Status/News/
  Gensonet/Thread/Post as display rules (static HTML, `risu-btn` stripped),
  prompt-side cleanup rules (`<Year>` injection becomes Pattern A text).
- Lightboard as Pattern B: inline manifests/guidelines/formats as Lua
  constants; sequential `backends.generate` calls; append blocks to the reply.
  Reroll/interaction/lazy → chat commands or drop.

**Hearts** — backend_logic Pattern C parses `{ prov_country: x }` /
`{ prov_color: #… }` into `state.map`; Pattern A injects current owners/colors
into the prompt (replacing the 209 `{{getvar}}` lines in the description).
Map rendering: the 47 KB live-recolored HTML map has **no equivalent**
(display regex can't read state) — render a per-message snapshot from
backend_logic (substitute state into the template at generation time) or fall
back to a text table. Old messages freeze their map either way (RisuAI
re-rendered live).

### Drop list (no tamari equivalent)

Music playback (`{{audio}}`), `v2ShowAlert`/`v2GetAlertInput` popups,
`v2Impersonate` message injection, reroll/interaction/lazy buttons,
`backgroundHTML` global CSS (inline `<style>` into replacements instead),
`axLLM` aux-model distinction, `getTokens` (budget by characters ÷ 4),
recency gating of display rules, `depth_prompt`/`sdData`/`vits`.

### Traps found while checking this bundle

1. **State flows through chat text** — `ModifyMap` and `Year Change` write
   vars via `{{setvar}}` inside regex *replacement output*. Treating regexes
   as display sugar silently breaks the map/year mechanics. Port these first.
2. **Upstream bugs — do not replicate**: Kakashi's Lua is byte-identical to
   Bunbunmaru's (wrong title/ids, strips the wrong tag); Gensonet's renderer
   calls an undefined global (`escQuotes` unqualified) and silently degrades;
   the `(xml|html) → ""` rules delete those literal words from prose; touhou
   trigger "22" and the Music/SelectMusic triggers are empty husks.
3. **Doubly-nested CBS** (`{{getvar::{{getvar::sweden_country}}_color}}`) —
   don't build a mini-CBS in replaceLua; do state→template substitution in
   backend_logic.
4. **Lore-as-code** — Lightboard's lorebook is a config/Lua database read by
   comment name. In tamari these become Lua constants, never lorebook entries.
5. **Hidden module coupling** — the card's display regexes render tags the
   Lightboard modules generate; the NSFW module's PNGs are referenced by
   filename convention from the portrait regex. Port as one system.
6. **Licensing** — Lightboard is CC BY-NC-SA 4.0 (amonamona): keep attribution
   in ported Lua. The 61 mp3s are copyrighted Touhou OST rips.
7. **Multilingual** — toggle values are Korean strings (`place=하쿠레이_신사`);
   preserve exact strings in state defaults and keys.

---

## Check-over status of this flow

- **Verified against the actual files**: all counts/inventories above come from
  decoding both CharX cards and all six `.risum` files with the project's own
  parser (`lib/risum.ts`, `lib/charx.ts`) — not from upstream documentation.
- **Verified against the tamari runtime**: the passthrough-with-modified-prompt
  contract (`{ __passthrough = true, prompt = p }`), delegation, state
  persistence, and the replaceLua signature were read from
  `LuaBackendAdapter.ts` / `RegexEngine.ts`, and the workbench tools named here
  are the shipped interface (26 tools, incl. the copy tools used in Phase 2).
- **Not yet validated**: no card has been run through this flow end-to-end.
  The first real port (recommend: Hearts map first — single mechanism, easy to
  eyeball) will likely surface gaps in Phase 3 patterns; update this doc then.
