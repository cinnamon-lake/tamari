/** Reference doc for the `workbench` topic, served by the Docs tool. */
export const WORKBENCH_DOC = `# Workbench (virtual filesystem)

The \`workbench\` template is ONE filesystem-style surface over characters, backend configs, custom backends, toolsets, quick replies, and Lua tool templates. Seven tools: \`ls\`, \`read\`, \`grep\`, \`write\`, \`edit\`, \`rm\`, \`run\`. All errors come back as \`content\` strings starting with \`Error: \` — nothing throws, so read the message and retry.

## No discovery — ever

**Collections cannot be listed.** \`ls\` on \`/characters/\`, \`/backends/\`, \`/toolsets/\`, \`/luatools/\`, \`/custom-backends/\`, \`/quickreplies/\` (or \`/quickreplies/<scope>/\`) is refused: \`Error: cannot list collections — ids come from the user or chat context\`. There is no list/find anywhere — **entity ids come from the user or chat context**, or from create results (creation returns the real assigned path). \`grep\` follows the same rule: it searches WITHIN one entity and refuses collection paths.

What \`ls\` CAN list: \`/\` (the six domain names), a specific entity dir (\`/characters/<id>/\`, \`/custom-backends/<id>/\`, \`/luatools/<id>/\`), entity sub-collections (\`/characters/<id>/lorebook/\`, \`greetings/\`, \`regex/\`, \`assets/\`, \`modules/\`, \`backend_logic/\`), and a scoped quick-reply collection (\`/quickreplies/<scope>/<scopeId>/\` — scope + scopeId are context you supply).

## Layout

\`\`\`
/                                          ls / → the six domain names only
/characters/<id>/                          non-empty text fields + meta.json + present subdirs
/characters/<id>/<field>                   description, personality, scenario, first_mes, mes_example,
                                           system_prompt, post_history_instructions, creator_notes, nickname
/characters/<id>/meta.json                 { name, tags, alternateGreetings, avatarUrl, thumbnailUrl, worldInfoId }
/characters/<id>/lorebook/<entryId>.json   card lorebook entries (topic \`lorebooks\`)
/characters/<id>/greetings/<n>             alternate greetings — one TEXT file per index; \`write .../greetings/new\`
                                           appends; \`rm\` splices (later indices shift down); bulk replace via meta.json
/characters/<id>/regex/<ruleId>.json       character-scoped regex rules (topic \`regexes\`)
/characters/<id>/assets/<assetId>.json     metadata only; the binary is not readable
/characters/<id>/modules/<moduleId>.json[/<section>]   Risu modules; read + rm only —
                                           section: info | triggers | trigger/<n> | regex | lorebook | assets
/characters/<id>/backend_logic/            card-coupled backend script dir (topic \`custom_backends\`):
                                           main.lua entry point + module files behind \`require\`;
                                           listed only when enabled or non-empty
/characters/<id>/backend_logic.lua         legacy alias for backend_logic/main.lua
/backends/<configId>.json                  backend config; apiKey redacted to hasApiKey (topic \`backends\`)
/custom-backends/<id>/meta.json            { name, description, updatedAt }
/custom-backends/<id>/source.lua           registry custom-backend script (topic \`custom_backends\`)
/toolsets/<toolsetId>.json                 toolset record + resolved tool names (topic \`toolsets\`)
/quickreplies/<scope>/<scopeId>/<id>.json  scope: global | character | chat; global uses scopeId \`_\`
/luatools/<id>/meta.json                   { name, sandbox, configSchema }
/luatools/<id>/code.lua                    Lua tool template code (topic \`toolsets\`)
\`\`\`

Paths are absolute (leading \`/\`); \`.\` and \`..\` segments are rejected.

## Per-field files (no JSON escaping)

JSON-blob files — \`meta.json\`, \`lorebook/<entryId>.json\`, \`regex/<ruleId>.json\`, \`quickreplies/.../<id>.json\` — also expand into per-field files: append \`/<field>\` (snake_case) to read or write ONE field at a time. \`ls\` on the \`.json\` file lists its fields. String fields are raw text (\`write\` stores the content verbatim — the way to set regex patterns and scripts without JSON escaping); every other field (boolean, number, array, object) is written as a JSON value. Each field write patches just that field; whole-file \`.json\` reads/writes keep working unchanged.

Examples: \`/characters/<id>/regex/<ruleId>.json/find_regex\` (\`replace_string\`, \`replace_lua\`, \`disabled\`, \`user_input\`, \`ai_output\`, \`prompt\`, \`display\`, \`name\`), \`/characters/<id>/lorebook/<entryId>.json/content\` (\`comment\`, \`keys\`, \`secondary_keys\`, \`order\`, \`position\`, \`constant\`, \`disable\`, …), \`/quickreplies/<scope>/<scopeId>/<id>.json/script\` (\`label\`, \`icon\`, \`color\`, \`language\`, \`auto_execute\`, \`order_index\`), \`/luatools/<id>/meta.json/config_schema\`, \`/custom-backends/<id>/meta.json/description\`.

## The 7 tools

**ls { path? }** — one entry per line; dirs suffixed \`/\`; display names shown as annotations (\`abc123.json  "My Card"\`). \`path\` defaults to \`/\`. A character dir lists only non-empty fields and present subdirs — empty fields are always hidden.

**read { path, offset?, limit? }** — full read returns raw content (pretty-printed JSON for \`.json\`). \`offset\`/\`limit\` select a 1-based line range rendered as tab-numbered lines; a negative \`offset\` reads the tail (\`offset: -20\` → last 20 lines). Capped at ~400 lines per read — page with \`offset\`. Reading a directory is an error: use \`ls\`.

\`\`\`json
read {"path": "/characters/abc123/backend_logic.lua", "offset": 1, "limit": 80}
\`\`\`

**grep { pattern, path, regex?, ignoreCase? }** — substring match by default (\`regex: true\` for a JS RegExp), \`ignoreCase\` default true. \`path\` is REQUIRED and must resolve inside ONE specific entity (entity dir, sub-collection, or file) — never a cross-entity scan. Output \`path:line:text\`, capped at 50 matches.

\`\`\`json
grep {"pattern": "generate", "path": "/characters/abc123/"}
\`\`\`

**write { path, content }** — full-file create/replace. Text and \`.lua\` files are stored verbatim; \`.json\` bodies must be valid JSON and are schema-validated. \`.lua\` writes are load-validated before saving — invalid source is rejected unsaved. \`meta.json\` accepts only its writable keys (below). Modules and asset files are read-only. Per-field files (above) store string fields verbatim and parse a JSON value for everything else — prefer them over whole-file writes for regex patterns, scripts, and long content.

**edit { path, oldString, newString, replaceAll? }** — surgical replace in a text or \`.lua\` file; \`oldString\` must match exactly once unless \`replaceAll: true\`. JSON files: \`Error: use write for JSON files\`. The edited \`.lua\` source is re-validated before saving (\`backend_logic/main.lua\` must load and define \`generate\`; other \`backend_logic/\` modules must only load; luatool \`code.lua\` must load) — invalid edits are NOT saved. Validation resolves \`require\` against the card's module map; modules that don't exist YET are tolerated (main-before-modules is a legal authoring order — the \`test_backend_logic\` dry-run validates the full set). edit also works on per-field files (e.g. \`.../lorebook/<entryId>.json/content\`, \`.../regex/<ruleId>.json/find_regex\`) — the precise way to tweak one pattern or paragraph.

**rm { path }** — deletes lorebook entries, greetings, regex rules, assets, modules, \`backend_logic/\` module files, and \`/custom-backends/<id>/\`. Refused (with an explanation): character dirs (no character delete), backend configs (no delete — overwrite with \`write\` or switch the active config), toolsets (disable via \`write\` with \`{"enabled": false}\`), quick replies and Lua tool templates (no delete, by policy), \`meta.json\` files, text fields and \`backend_logic/main.lua\` (clear via \`write\` with empty content), collections.

**run { verb, args? }** — escape hatch for non-file actions: \`run {"verb": "<name>", "args": {...}}\`. An unknown or omitted verb returns the verb menu.

| Verb | Args |
|---|---|
| \`test_backend\` | \`{configId?, patch?, prompt?, mode: "dry"|"live"}\` — dry-run or live-test a backend config; configId defaults to the active backend; \`patch\` applies in memory only |
| \`test_custom_backend\` | \`{id?|luaSource?, input, state?, delegateResponse?}\` — dry-run a custom-backend script against a recording delegate |
| \`test_backend_logic\` | \`{characterId, input, luaSource?, state?, delegateResponse?}\` — dry-run a card's backend_logic (main.lua + its \`require\`d modules) |

For both dry-run verbs: \`state\` takes a JSON string OR a plain object (serialized for you — e.g. paste a previous run's \`stateOut\` either way), and \`delegateResponse\` takes plain text, \`{"text": "..."}\`, or \`{"error": "..."}\` to rehearse delegation failures.
| \`test_luatool\` | \`{id?|code?, sandbox?, toolName, args?, config?}\` — run a tool from a stored template or ad-hoc code |
| \`test_regex\` | \`{characterId?, text, role?}\` — preview merged regex rules (global + character) against sample text |
| \`clone_character\` | \`{sourceCharacterId, name?}\` — deep-copy a card (fields, lorebook, regex, modules, assets, avatar) |
| \`set_avatar\` | \`{characterId, attachmentId?|sourceCharacterId?}\` — avatar from an attachment image or another card |
| \`copy_assets\` | \`{characterId, sourceCharacterId, assetId?}\` — omit assetId to copy all |
| \`copy_module_assets\` | \`{characterId, sourceCharacterId, moduleId}\` — copy a Risu module's stored assets onto a card |
| \`move_lorebook_entry\` | \`{characterId, entryId, index}\` — move an entry to a 0-based position |
| \`add_game_lib\` | \`{characterId}\` — vendor the game lib (\`lib/*.lua\`: loop, ledger, todo, registry, rolling, …; topic \`game_cards\`) into the card's \`backend_logic/\` VFS. Overwrites \`lib/\` keys only; the card's own modules and main.lua are preserved |

## Creating entities: write to .../new(.json)

A \`write\` whose last segment is \`new\` or \`new.json\` creates the entity, and the result includes the real assigned path — this is where new ids come from:

- \`write /characters/new\` — body \`{ "name": ..., ...card fields }\` (\`name\` required; duplicate names fail)
- \`write /backends/new.json\` — backend config fields; \`"activate": true\` makes it the active config. Later writes to \`/backends/<id>.json\` patch it (\`providerParams\` is shallow-merged).
- \`write /custom-backends/new.json\` — \`{ name, description?, luaSource }\`
- \`write /toolsets/new.json\` — \`{ templateId, name?, config?, toolOverrides?, enabled? }\` (builtin template ids work)
- \`write /quickreplies/<scope>/<scopeId>/new.json\` — scope/scopeId forced from the path (global → \`_\`)
- \`write /luatools/new.json\` — \`{ name, code, sandbox?, configSchema? }\`; invalid code is rejected before saving
- \`write /characters/<id>/lorebook/new.json\` — add an entry (first add auto-creates and links the book)
- \`write /characters/<id>/regex/new.json\` — add a rule
- \`write /characters/<id>/assets/new.json\` — \`{ attachmentId, name?, type? }\` imports an attachment as an asset

After creation, custom-backends and luatools are two-file dirs (\`meta.json\` + \`source.lua\`/\`code.lua\`) you edit in place.

## meta.json writable keys

- \`/characters/<id>/meta.json\` — \`name\` (renames; uniqueness enforced), \`tags\`, \`alternateGreetings\` (bulk replace of the whole array — individual greetings live under \`greetings/\`). \`avatarUrl\`, \`thumbnailUrl\`, \`worldInfoId\` are read-only.
- \`/custom-backends/<id>/meta.json\` — \`name\`, \`description\`.
- \`/luatools/<id>/meta.json\` — \`name\`, \`sandbox\`, \`configSchema\`.

Each writable key is also a per-field file (\`meta.json/name\`, \`meta.json/tags\`, \`meta.json/config_schema\`, …) — see "Per-field files".

## Typical workflows

**Backend loop:** \`read /backends/<id>.json\` → \`run {"verb":"test_backend","args":{"mode":"dry","patch":{...}}}\` (shows before/after URL, headers, body — credentials scrubbed, nothing sent) → \`mode: "live"\` → \`write /backends/<id>.json\` to persist once green. Iterate on a broken script with the in-memory \`patch\` without dirtying the saved config.

**Risu module port:** \`run clone_character\` (keep the original untouched) → \`ls /characters/<clone>/modules/\` → \`read .../modules/<id>.json/triggers\` (+ \`/trigger/<n>\`, \`/regex\`, \`/lorebook\`) → port lore via \`write .../lorebook/new.json\` (module lorebooks are NOT auto-converted), display/HUD rules via \`write .../regex/new.json\` (+ \`run test_regex\`), and backend logic via \`write /characters/<id>/backend_logic.lua\` (+ \`run test_backend_logic\`; prefer \`edit\` for iterating on a large script). Assets: \`run copy_assets\` / \`run copy_module_assets\`; reference them with \`{{img::name}}\`. Full trigger→backend mapping: topic \`custom_backends\`.

## Related topics

\`characters\` (card fields), \`backends\` (config fields, providerParams), \`custom_backends\` (Lua backend contract), \`request_scripts\` (request transformer), \`regexes\` (rule fields), \`lorebooks\` (entry fields, \`@@\` decorators), \`toolsets\` (Lua tool templates), \`quick_replies\` (the \`st\` API), \`prompt_lists\`, \`macros\`.
`;
