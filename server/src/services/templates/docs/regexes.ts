/** Reference doc for the `regexes` topic, served by the Docs tool. */
export const REGEXES_DOC = `# Regex Rules

Regex rules transform text at two points: **prompt** (what the model sees; ephemeral — stored text is untouched) and **display** (what the user sees; applied server-side before markdown rendering). They never mutate stored messages.

## Rule shape

\`\`\`json
{
  "id": "uuid",
  "name": "HUD expander",
  "findRegex": "/\\\\[HP:(\\\\d+)\\\\]/g",
  "replaceString": "<span class=\\"hp\\">$1</span>",
  "replaceLua": "",
  "disabled": false,
  "userInput": false,
  "aiOutput": true,
  "prompt": true,
  "display": true
}
\`\`\`

- \`findRegex\` **must** be \`/pattern/flags\` delimited; bare patterns are rejected. Default flags: \`g\`.
- Placement: \`prompt\` and/or \`display\`.
- Role filters: \`userInput\` / \`aiOutput\`. Neither set = all roles. \`system\` and \`tool\` role messages never match when role flags are set.
- \`replaceLua\` (when non-empty) takes precedence over \`replaceString\`:

\`\`\`lua
function replace(match, captures)
  -- captures: 1-indexed array; nil for unmatched optional groups
  -- non-string/nil return keeps the original match
  return string.format('<span class="hp">%s</span>', captures[1])
end
\`\`\`

## Scope and order

- **Global** rules live in settings; **character-scoped** rules live on the card — Workbench fs: \`/characters/<id>/regex/\` — and travel with it.
- Merged global-first, character rules appended — so character rules see global rules' output and win on overlap.

## Execution facts

- Prompt rules run as the **first** prompt-assembly splice stage, before Author's Note / World Info, and before macro resolution in the renderer — a rule can inject macros, but macro output is not re-regexed.
- Display rules run on raw text before markdown — a rule can inject markdown or sanitized HTML (DOMPurify still applies; scripts can't smuggle XSS).
- Each rule executes in an isolated worker with a 1s timeout — a catastrophic-backtracking rule is skipped, text unchanged.
- Input is truncated at 100,000 characters per text part.
- \`replaceLua\` runs in a sandboxed Lua VM (5s, no io/os/net; \`json\`/\`base64\` available). Errors skip the rule.

## Porting from RisuAI regex scripts

- Type mapping: \`editdisplay\` → \`display: true\`; \`editprocess\` / \`editoutput\` → \`prompt: true\` (add \`aiOutput: true\` for output-only); \`editinput\` → \`prompt: true\` + \`userInput: true\`.
- RisuAI conditional macros inside replacements (\`{{#if …}}\`, \`{{greater_equal::…}}\`, \`{{getvar::…}}\`) have no plain-text equivalent — reimplement the logic in \`replaceLua\`, which can branch, compute, and format per match.
- Display rules may emit interactive HTML, including \`<button data-post-response="...">\` buttons (the click posts the attribute as the user's next message — see topic \`custom_backends\`) and \`<form data-post-response="root">\` response forms (submit serializes the fields to a fenced XML block posted as the user's next message — see topic \`chats\`). The default (permissive) sanitization keeps \`button\`/\`div\`/\`form\`/\`input\`/\`select\`/\`textarea\`/\`label\`/\`class\`/\`style\`.

## The HUD recipe: values in the tag

The canonical status-panel pattern needs NO state access in the regex — the backend (or card text) emits a compact tag carrying the values, and a display rule renders the panel. Stored text stays compact (the model sees \`[HUD|hp=7|mp=3]\` next turn, not markup it might imitate), the panel is branch-aware and era-correct for free (the values ARE the message), and visuals can be restyled later without touching stored content.

1. The backend/card emits a tag: \`[HUD|hp=7|mp=3]\`
2. A display rule renders it — findRegex \`/\\[HUD\\|([^\\]]+)\\]/g\` with \`replaceLua\`:

\`\`\`lua
function replace(match, captures)
  local fields = {}
  for pair in captures[1]:gmatch("[^|]+") do
    local k, v = pair:match("^(%w+)=(.+)$")
    if k then fields[k] = v end
  end
  return string.format(
    '<div class="hud"><span class="hp">HP %s</span> <span class="mp">MP %s</span></div>',
    fields.hp or "?", fields.mp or "?")
end
\`\`\`

3. Leave the tag visible to the model in the prompt — it is useful, updateable state. (Do NOT strip it with a prompt rule unless it confuses the model.)

Resist the alternatives: emitting fully-rendered HTML from the backend bloats the prompt and invites imitation; giving \`replaceLua\` access to live backend state would re-render OLD messages with CURRENT state (displayed history must stay immutable). If a panel ever needs aggregates that no single message carries, the answer is a per-message vars snapshot, not live state.

The same recipe styles USER inputs — set the rule's \`userInput\` role filter and the tag can be something the user sent. It pairs naturally with \`data-post-response\`: a button click or form submit posts a compact machine string (\`choice__3\`, a fenced XML block), and a display rule renders it as a readable bubble in the log while the stored text — and the model — keep the raw form. The inverse also works: a display rule can render a script-only tag like \`[sys]…[/sys]\` as nothing at all, hiding chrome from the log (see topic \`custom_backends\`).

## Appending constant chrome (display-only)

A display-only rule (\`prompt: false\`) can APPEND fixed text the model never sees — reminders, hints, footers. Anchor on a tag the message already carries and re-emit it with the addition: findRegex \`/\\[HUD\\|[^\\]]+\\]/g\`, replaceString \`$&\\n\\n*Remember: /help lists your options.*\`, \`display: true, prompt: false\`. Stored text and the prompt keep only the compact tag; the reminder is pure render — restylable anytime, era-correct per message for free, and it can never leak into the model's context or be imitated by it. Set \`aiOutput: true\` to keep it off user bubbles. (The inverse — constant text the MODEL sees but the player doesn't — is a prompt-only rule, same shape.)

## Authoring

Use the Workbench fs: \`write /characters/<id>/regex/new.json\` to add and \`write /characters/<id>/regex/<ruleId>.json\` to update (character-scoped), then always \`run {"verb":"test_regex",...}\` to preview both placements — including \`replaceLua\` — before saving. New character-scoped rules default to \`prompt: true, display: true\` (v1 "universal" parity); set the placement flags deliberately. \`findRegex\` may be omitted (or empty) to create an inert placeholder rule — it is stored and listed but does nothing until a pattern is set; empty or invalid patterns are always skipped at apply time, never errors.
`;
