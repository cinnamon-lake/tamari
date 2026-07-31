# The Workbench

The workbench is a filesystem-style tool surface that lets the AI read and edit your tamari data — characters, backend configs, custom backends, toolsets, quick replies, and Lua tool templates — while you chat. Instead of clicking through editors yourself, you ask the model: it sees your data as a virtual filesystem and works on it with seven tools: `ls`, `read`, `grep`, `write`, `edit`, `rm`, and `run`.

## Enabling the Workbench

The workbench ships as a built-in tool template named `Workbench`. To use it:

1. Open the sidebar and click **Tools**.
2. In the Tools modal, click **New Toolset**.
3. In the toolset's **Template** dropdown, pick **Workbench**.
4. Give the toolset a name and make sure it is toggled **Enabled**.

> **Tip:** Enable the **`docs`** toolset alongside the workbench for any workbench task. The workbench gives the model hands; the `docs` tool gives it the field names, tool semantics, and scripting contracts for whatever it's editing. Workbench-without-docs works, but the model has to guess at schemas it could have looked up.

While the toolset is enabled, the model can call the seven tools during generation. Things you can ask for:

- "Read Seraphina's description and tighten it up."
- "My backend is returning 404s — dry-run it and figure out what's wrong."
- "Add a lorebook entry for the Obsidian Order to this character."
- "Port the Risu module on this card to native lorebook and regex rules."
- "Write a quick reply that rolls a d20 and appends the result."

> **Note:** The workbench edits your real data. Changes the model makes with `write`, `edit`, and `rm` are saved immediately, the same as if you made them in the UI.

## The No-Discovery Rule

**Collections cannot be listed — ever.** There is no way for the model to browse all your characters, backends, or toolsets. Asking it to `ls /characters/` (or any other collection) is refused:

```
Error: cannot list collections — ids come from the user or chat context
```

Entity ids come from **you** (paste the id into chat) or from **chat context** (the model knows which character the current chat belongs to), or from the result of creating something new. `grep` follows the same rule: it searches inside one entity and refuses to scan across them.

What `ls` *can* list:

- `/` — the six domain names
- One specific entity directory, e.g. `/characters/<id>/`
- An entity's sub-collections, e.g. `/characters/<id>/lorebook/`
- A scoped quick-reply collection, e.g. `/quickreplies/chat/<chatId>/`

## Path Layout

```
/                                          ls / → the six domain names
├── characters/
│   └── <id>/                              non-empty text fields + meta.json + present subdirs
│       ├── description                    plain-text card fields: description, personality,
│       ├── personality                    scenario, first_mes, mes_example, system_prompt,
│       ├── ...                            post_history_instructions, creator_notes, nickname
│       ├── meta.json                      { name, tags, alternateGreetings, avatarUrl,
│       │                                    thumbnailUrl, worldInfoId }
│       ├── lorebook/<entryId>.json        card lorebook entries
│       ├── greetings/<n>                  alternate greetings — one text file per index
│       ├── regex/<ruleId>.json            character-scoped regex rules
│       ├── assets/<assetId>.json          asset metadata only; the binary is not readable
│       ├── modules/<moduleId>.json        Risu modules; read + rm only. Sections:
│       │   └── <section>                  info | triggers | trigger/<n> | regex | lorebook | assets
│       ├── backend_logic/                 card-coupled backend script, as a directory
│       │   ├── main.lua                   entry point (listed when enabled, scripted, or modules exist)
│       │   └── <path>.lua                 modules require()'d from main.lua (e.g. lib/utils.lua)
│       └── backend_logic.lua              legacy alias for backend_logic/main.lua
├── backends/<configId>.json               backend config; apiKey redacted to hasApiKey
├── custom-backends/<id>/
│   ├── meta.json                          { name, description, updatedAt }
│   └── source.lua                         registry custom-backend script
├── toolsets/<toolsetId>.json              toolset record + resolved tool names
├── quickreplies/<scope>/<scopeId>/<id>.json   scope: global | character | chat
│                                          (global uses scopeId `_`)
└── luatools/<id>/
    ├── meta.json                          { name, sandbox, configSchema }
    └── code.lua                           Lua tool template code

/generations/<id>/                         debug traces, read-only:
    ├── meta.json                          the full generation record (kind, rounds, tool calls, traceError)
    ├── error.txt                          rendered error chain (only when the run failed)
    └── prompt.json                        round-1 prompt snapshot (only when debugPrompts was on)
```

Paths are absolute and start with `/`. `.` and `..` segments are rejected.

## The Seven Tools

All errors come back as text starting with `Error: ` — nothing throws silently, so when the model gets an error it can read the message and retry.

### `ls`

`ls { path? }` — lists a directory, one entry per line. Directories end in `/`, and files may show a display name as an annotation:

```
abc123.json  "My Card"
def456.json  "NPC Template"
```

`path` defaults to `/`. A character directory lists only **non-empty fields and present subdirs** — empty fields are always hidden, so a sparse card shows a sparse listing.

### `read`

`read { path, offset?, limit? }` — reads a file. A full read returns the raw content (pretty-printed for `.json` files). `offset`/`limit` select a 1-based line range, rendered as tab-numbered lines; a negative `offset` reads the tail:

```json
read {"path": "/characters/abc123/backend_logic.lua", "offset": 1, "limit": 80}
read {"path": "/characters/abc123/description", "offset": -20}
```

Output is capped at about 400 lines per read — longer files are paged with `offset`. Reading a directory is an error; use `ls` instead.

### `grep`

`grep { pattern, path, regex?, ignoreCase? }` — searches for text **inside one entity**: a character's fields, lorebook, and scripts; one Lua tool's code; and so on. Never a cross-entity scan. Substring match by default; pass `regex: true` for a JavaScript RegExp. `ignoreCase` defaults to `true`.

```json
grep {"pattern": "generate", "path": "/characters/abc123/"}
```

Output is `path:line:text`, capped at 50 matches.

### `write`

`write { path, content }` — creates or replaces a whole file.

- Text and `.lua` files are stored verbatim.
- `.json` bodies must be valid JSON and are schema-validated before saving.
- `.lua` writes are load-validated before saving — invalid source is rejected unsaved.
- `meta.json` accepts only its writable keys (see below).
- Modules and asset files are read-only.

`write` is also how new entities are created — see [Creating Entities](#creating-entities).

### `edit`

`edit { path, oldString, newString, replaceAll? }` — surgical search-and-replace inside a text or `.lua` file. `oldString` must match **exactly once** unless `replaceAll: true` is set. Whole `.json` files are refused (`Error: use write for JSON files`), but `edit` *does* work on per-field files (below) — the precise way to tweak one regex pattern or one paragraph.

Edited `.lua` source is re-validated before saving: `backend_logic/main.lua` (and its `backend_logic.lua` alias) must load and define `generate`, a `backend_logic/` module must load (top-level `return` allowed — modules don't need `generate`), and a luatool `code.lua` must load. Invalid edits are **not** saved.

### `rm`

`rm { path }` — deletes lorebook entries, greetings, regex rules, assets, modules, and whole `/custom-backends/<id>/` directories.

Refused, with an explanation:

- Character directories (characters can't be deleted this way)
- Backend configs (overwrite with `write`, or switch the active config)
- Toolsets (disable instead: `write` with `{"enabled": false}`)
- Quick replies and Lua tool templates (no delete, by policy)
- `meta.json` files, text fields, and `backend_logic/main.lua` (clear them by writing empty content); `backend_logic/` itself is a directory
- Collections

### `run`

`run { verb, args? }` — the escape hatch for actions that don't map to files: testing backends, cloning characters, copying assets. Calling `run` with no verb (or an unknown one) returns the verb menu. See [Run Verbs](#run-verbs).

## Per-Field Files (No JSON Escaping)

JSON-blob files — `meta.json`, `lorebook/<entryId>.json`, `regex/<ruleId>.json`, `quickreplies/.../<id>.json` — also expand into **per-field files**: append `/<field>` (snake_case) to read or write one field at a time. Running `ls` on the `.json` file lists its fields.

- **String fields** are raw text — `write` stores the content verbatim. This is the way to set regex patterns and scripts without fighting JSON escaping.
- **Everything else** (booleans, numbers, arrays, objects) is written as a JSON value.

Each field write patches just that field; whole-file `.json` reads and writes keep working unchanged.

Examples:

```
/characters/<id>/regex/<ruleId>.json/find_regex     also: name, replace_string, replace_lua,
                                                     disabled, user_input, ai_output, prompt, display
/characters/<id>/lorebook/<entryId>.json/content    also: comment, keys, secondary_keys, order,
                                                     position, depth, role, probability, constant,
                                                     selective, disable, ...
/quickreplies/<scope>/<scopeId>/<id>.json/script    also: label, icon, color, language,
                                                     auto_execute, order_index
/luatools/<id>/meta.json/config_schema
/custom-backends/<id>/meta.json/description
```

> **Note:** Character-scoped regex rules use a **delimited JavaScript pattern** in `find_regex`, e.g. `/foo/gi`. Bare patterns like `foo` are rejected.

## Creating Entities

A `write` whose last path segment is `new` or `new.json` creates a new entity, and the result includes the real assigned path — this is where new ids come from:

| Path | Body |
|------|------|
| `/characters/new` | `{ "name": ..., ...card fields }` — `name` required; duplicate names fail |
| `/backends/new.json` | Backend config fields; `"activate": true` makes it the active config |
| `/custom-backends/new.json` | `{ name, description?, luaSource }` |
| `/toolsets/new.json` | `{ templateId, name?, config?, toolOverrides?, enabled? }` — builtin template ids work |
| `/quickreplies/<scope>/<scopeId>/new.json` | Quick reply fields; scope/scopeId are forced from the path (global → `_`) |
| `/luatools/new.json` | `{ name, code, sandbox?, configSchema? }` — invalid code is rejected before saving |
| `/characters/<id>/lorebook/new.json` | Add an entry (the first add auto-creates and links the book) |
| `/characters/<id>/greetings/new` | Append an alternate greeting |
| `/characters/<id>/regex/new.json` | Add a rule |
| `/characters/<id>/assets/new.json` | `{ attachmentId, name?, type? }` — imports an attachment as an asset |

After creation, custom backends and Lua tools are two-file directories (`meta.json` + `source.lua` / `code.lua`) that you edit in place. Later writes to an existing `/backends/<id>.json` patch it — `providerParams` is shallow-merged into the existing record.

> **Warning:** Greetings are one text file per index. `rm` on `greetings/<n>` splices the array — later indices shift down. To reorder or rewrite many greetings at once, use the `alternateGreetings` array in `meta.json` instead.

## meta.json Writable Keys

Each entity's `meta.json` accepts only specific keys in a `write`:

- `/characters/<id>/meta.json` — `name` (renames the character; uniqueness enforced), `tags`, `alternateGreetings` (bulk-replaces the whole array). `avatarUrl`, `thumbnailUrl`, and `worldInfoId` are read-only.
- `/custom-backends/<id>/meta.json` — `name`, `description`.
- `/luatools/<id>/meta.json` — `name`, `sandbox`, `configSchema`.

Every writable key is also a per-field file (`meta.json/name`, `meta.json/tags`, `meta.json/config_schema`, …) — see [Per-Field Files](#per-field-files-no-json-escaping).

## Run Verbs

`run {"verb": "<name>", "args": {...}}` covers the non-file actions:

| Verb | Args | What it does |
|------|------|--------------|
| `test_backend` | `{configId?, patch?, prompt?, mode: "dry"\|"live"}` | Dry-run or live-test a backend config. `configId` defaults to the active backend; `patch` applies in memory only |
| `test_custom_backend` | `{id?\|luaSource?, input, state?, delegateResponse?}` | Dry-run a custom-backend script against a recording delegate |
| `test_backend_logic` | `{characterId, input, luaSource?, state?, delegateResponse?}` | Dry-run a card's backend_logic (main.lua + its `require`d modules) |
| `test_luatool` | `{id?\|code?, sandbox?, toolName, args?, config?}` | Run a tool from a stored template or ad-hoc code |
| `test_regex` | `{characterId?, text, role?}` | Preview merged regex rules (global + character) against sample text |
| `clone_character` | `{sourceCharacterId, name?}` | Deep-copy a card: fields, lorebook, regex, modules, assets, avatar |
| `set_avatar` | `{characterId, attachmentId?\|sourceCharacterId?}` | Set an avatar from an attachment image or another card |
| `copy_assets` | `{characterId, sourceCharacterId, assetId?}` | Copy character assets; omit `assetId` to copy all |
| `copy_module_assets` | `{characterId, sourceCharacterId, moduleId}` | Copy a Risu module's stored assets onto a card |
| `move_lorebook_entry` | `{characterId, entryId, index}` | Move an entry to a 0-based position |

## Worked Examples

### Fixing a Broken Backend (dry → live → persist)

The safe loop for backend repairs — nothing is saved until it works:

1. **Inspect:** `read /backends/<id>.json` shows the saved config (API key redacted to `hasApiKey`).
2. **Dry-run:** `run {"verb": "test_backend", "args": {"mode": "dry", "patch": {...}}}` builds the request and applies the request script without sending anything — it shows the before/after URL, headers, and body, credentials scrubbed. The `patch` is applied in memory only, so the saved config stays untouched while the model iterates.
3. **Live-test:** once the dry run looks right, `mode: "live"` sends a minimal request (30s timeout) to confirm the endpoint actually responds.
4. **Persist:** only when the test is green, `write /backends/<id>.json` saves the fixed fields.

### Porting a Risu Module

Risu modules on a card are read-only under `modules/`, so porting means re-creating their behavior natively:

1. `run {"verb": "clone_character", "args": {"sourceCharacterId": "<id>"}}` — work on the clone, keep the original untouched.
2. `ls /characters/<clone>/modules/` → `read .../modules/<id>.json/triggers` (plus `/trigger/<n>`, `/regex`, `/lorebook`) to see what the module does.
3. Port the pieces:
   - **Lore** → `write /characters/<clone>/lorebook/new.json` per entry. Module lorebooks are **not** auto-converted.
   - **Display/HUD rules** → `write /characters/<clone>/regex/new.json`, previewed with `run test_regex`.
   - **Backend logic** → `write /characters/<clone>/backend_logic/main.lua`, dry-run with `run test_backend_logic`. Bigger scripts split into modules: `write /characters/<clone>/backend_logic/lib/utils.lua` and `require('lib/utils')` from `main.lua`. Prefer `edit` when iterating on a large script.
4. **Assets** → `run copy_assets` or `run copy_module_assets`, then reference them in card text with `{{img::name}}` (see [Macro System](./macros.md)).

## Safety Notes

- **Lua is validated before saving.** `backend_logic/main.lua` (alias `backend_logic.lua`) must load and define `generate`; `backend_logic/` modules must load; a luatool `code.lua` must load. Invalid `write` and `edit` attempts are rejected and nothing is stored.
- **Most things can't be deleted.** Characters, backend configs, toolsets, quick replies, and Lua tool templates have no delete path — `rm` refuses them with an explanation. Deletable items are limited to lorebook entries, greetings, regex rules, assets, modules, and custom backends.
- **Credentials are redacted.** Backend configs come back with `apiKey` replaced by `hasApiKey`, and `test_backend` dry runs scrub credentials from the URLs, headers, and bodies they display.
- **Dry runs send nothing.** `test_backend` in `dry` mode, and the `test_custom_backend` / `test_backend_logic` script tests, never touch the network or your saved config.

## Tips & Gotchas

- **Give the model an anchor.** Because collections can't be listed, "fix my character" only works when the model knows which one — work from a chat with that character, or paste the id.
- **Prefer per-field files for patterns and scripts.** Writing `.../regex/<ruleId>.json/find_regex` stores the pattern verbatim; writing the whole `.json` means escaping every quote and backslash.
- **Page long files.** `read` caps at ~400 lines; use `offset`/`limit` (or a negative `offset` for the tail) instead of re-reading from the top.
- **Empty fields are invisible.** A character directory only lists non-empty fields, so an absent `scenario` file just means the field is empty — `write` it to create it.
- **Disable, don't delete, toolsets.** `rm` refuses toolsets; `write /toolsets/<id>.json` with `{"enabled": false}` turns one off.

## See Also

- [Tools & Toolsets](./tools.md) — the Tools modal, toolsets, and Lua tool templates
- [Custom Backends](./custom-backends.md) — the Lua backend contract behind `backend_logic/` and `custom-backends/`
- [Request Scripts](./request-scripts.md) — the request transformer applied in `test_backend` dry runs
- [Assets](./assets.md) — attachments, character assets, and avatars
- [Macro System](./macros.md) — `{{img::...}}` and other macros usable in card fields
- [Lua Scripting](./lua-scripting.md) — Lua basics for scripts and tools
