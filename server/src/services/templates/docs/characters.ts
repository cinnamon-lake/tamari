/** Reference doc for the `characters` topic, served by the Docs tool. */
export const CHARACTERS_DOC = `# Characters

A character is a card: named text fields, plus optional avatar, assets, character-scoped regex rules, a card-coupled backend script, and a linked lorebook. The text fields have **no fixed semantics of their own** — whether and where they reach the model is decided by the active prompt list (see topic \`prompt_lists\`).

## Core fields

| Field | Purpose |
|---|---|
| \`name\` | Display name. Fills \`{{char}}\`. Uniqueness is enforced on the workbench/\`st\` path only. |
| \`description\` | Free-form text field. Interpolated into the system prompt where the active prompt list places the \`charDescription\` marker; also fills \`{{description}}\`. If the list has no such marker, it is never sent. |
| \`personality\` | Free-form text field, interpolated via the \`charPersonality\` marker; also fills \`{{personality}}\`. |
| \`scenario\` | Free-form text field, interpolated via the \`scenario\` marker; also fills \`{{scenario}}\`. |
| \`mesExample\` | Example dialogue text, interpolated via the \`dialogueExamples\` marker. |
| \`firstMes\` | First greeting. Materialized as the chat's root message on first send (macro-resolved once, at that moment). |
| \`alternateGreetings\` | Additional greetings; materialize as sibling root messages — the greeting's swipes. |
| \`systemPrompt\` | Card-level override of the active prompt list's \`main\` prompt content (ignored if that prompt sets \`forbidOverrides\`). |
| \`postHistoryInstructions\` | Card-level override of the \`jailbreak\` prompt content. |
| \`creatorNotes\` | Free-form notes; no built-in marker interpolates it, so it never reaches the model unless a custom prompt list references it. |
| \`tags\` | String array for filtering/organization; never sent to the model. |
| \`worldInfoId\` | The character's linked lorebook (1:1 by convention). |

## Character-scoped feature data

Feature data attached to a card is edited through dedicated Workbench fs paths (topic \`workbench\`), never through \`meta.json\`:

- Character-scoped regex rules — \`/characters/<id>/regex/\` (see topic \`regexes\`).
- Card-coupled Lua backend — \`/characters/<id>/backend_logic/\` (\`main.lua\` + \`require\`d module files; \`backend_logic.lua\` aliases \`main.lua\`): a script that wraps the user's active adapter (see topic \`custom_backends\`). Workbench writes author the script only; the active flag is not writable through the fs, so imported cards never activate silently.
- RisuAI modules — \`/characters/<id>/modules/\` (read-only). **Effectively inert:** nothing in v2 executes module triggers, regexes, or lore; the raw module JSON is preserved purely as porting source material.
- Default \`{{getvar}}\` variables — imported cards may carry variables that seed when greetings materialize; not editable via the Workbench fs.

## Macros in card fields

All text fields are macro-resolved. Card fields are resolved at prompt build time (so \`{{random}}\`, \`{{time}}\`, \`{{user}}\` re-roll per generation); greetings are resolved once when materialized and stored resolved.

## Personas

The user's identity is a **persona** (name + description + avatar), bound per chat (\`chats.persona_id\`). \`{{user}}\` and \`{{persona}}\` resolve from the chat's persona. Generation reads the persona from the chat, not from global state.

## Character assets

Named media files attached to a card (from CharX cards or added directly): \`{ name, type, ext }\` where type is \`icon | background | emotion | other\`.

- Referenced in card text with the display-only macro \`{{img::filename.png}}\` (falls back to a sanitized name match).
- The \`scene\` template uses \`emotion\` assets as sprites and \`background\` assets as stage backdrops.
- Served at \`/api/characters/{id}/assets/{assetId}.{ext}\` — URLs are always provided by the server (\`assets[].assetUrl\` on character snapshots); never construct them by hand.
`;
