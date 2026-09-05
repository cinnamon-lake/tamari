/** Reference doc for the `request_transformers` topic, served by the Docs tool. */
export const REQUEST_TRANSFORMERS_DOC = `# Request Transformers (message-array transform chains)

A **transformer chain** is a named, ordered list of steps that rewrites the final rendered message array. Steps are either built-in transforms (typed params) or user Lua transformer scripts. Chains are standalone entities (the \`transformer_chains\` table, Lua sources in \`transformer_scripts\`), referenced by a backend config via \`BackendConfig.transformerChainId\` — one chain per config, like an instruct template, not a per-config flag.

Chains run as the LAST prompt stage (\`requestTransformers\`), after render: macros are already resolved, and the transform sees exactly \`Prompt.messages\`. Because both chat-completion and text-completion adapters consume that array (text-completion adapters flatten it themselves with their instruct template), one chain works for every backend alike.

Steps run in order, each receiving the previous step's output. Disabled steps are skipped silently. A chain NEVER aborts a generation: unknown builtin ids, invalid params, missing Lua sources, and Lua failures all skip the step with a trace note (see Trace below).

Chains replace the removed global \`whitespaceMode\` / \`reasoningAddToPrompts\` settings — existing installs were migrated to a seeded "Default" chain (id \`default\`) holding those old values, pointed at by every backend config.

## Step shapes

\`\`\`json
{ "kind": "builtin", "id": "history-squash", "enabled": true, "params": { "role": "user" } }
{ "kind": "lua", "scriptId": "<transformer_scripts.id>", "enabled": true }
\`\`\`

## Builtin catalog

| id | params | what it does |
|---|---|---|
| \`squash-system\` | (none) | Merge consecutive system messages with string content into one, joined by a blank line. Runs on the WHOLE rendered array, history included — can merge across the pre-history/history boundary. The renderer's own group-local squash runs regardless; this step is an opt-in extra. |
| \`whitespace\` | \`mode\`: \`none\` (default) / \`trim\` / \`full\` | Normalize whitespace in every message's text parts. \`trim\` strips leading/trailing whitespace; \`full\` additionally collapses internal runs — runs containing a newline become \`\\n\\n\`, others a single space. Applies per request; stored messages stay verbatim. |
| \`strip-reasoning\` | (none) | Remove reasoning / tool_use / tool_result parts from every assistant message EXCEPT the latest (the continuation target keeps its blocks), keeping only the final text. Opt-in: the default everywhere is that full thinking blocks are sent. |
| \`history-squash\` | \`role\`: \`user\` (default) / \`assistant\`; \`userPrefix\`?, \`userSuffix\` (\`''\`), \`charPrefix\`?, \`charSuffix\` (\`''\`), \`separator\` (\`'\\n\\n'\`) | Collapse all user/assistant turns into ONE message of the target \`role\`, placed at the first collapsed turn's position. Covers the classic user-squash extension (\`role: 'user'\`) and noass (\`role: 'assistant'\`) — the same transform differing only in role. Each turn is wrapped in its per-role prefix/suffix (prefixes default to \`<userName>: \` / \`<charName>: \` from the resolved names) and joined with \`separator\`. System and tool messages stay untouched in place (preamble stays preamble, jailbreak stays last); textless user/assistant messages (e.g. the empty trailing stream target) are left alone. NoAss's advanced post-processing (history cropping, rearranging, inter-split prompts, \`{{lastlines}}\`) is out of scope — a Lua step can do it. Incompatible with prompt caching: the whole history block is rewritten every turn. |
| \`ensure-thinking\` | \`placeholder\` (string, default \`''\`) | For APIs where every assistant message must carry a thinking block: prepend a placeholder reasoning part to assistant messages that lack one. OpenAI-family adapters re-send it as \`reasoning_content\`; Claude requires signed thinking blocks, so the unsigned placeholder degrades to plain inline text there. Textless assistant messages (the empty trailing stream target) are skipped. |

Builtin params are validated per step; invalid params skip that step with a trace note (never an abort).

## Lua steps

The chunk must define a global \`handle\` function. Messages and context are passed as ARGUMENTS and the result comes back as the RETURN value — nothing is injected as a global, and mutating the argument in place does nothing unless it is also returned:

| Argument | Description |
|---|---|
| \`messages\` | The rendered prompt as a plain array of \`{ role = 'system'\\|'user'\\|'assistant'\\|'tool', content = string \\| array of content parts, reasoningFormatted = string? }\`. |
| \`ctx\` | \`{ userName, charName, generationType, model, backendProvider }\` — names are final (post-macro). |

\`\`\`lua
function handle(messages, ctx)
  -- drop every message whose text matches a pattern
  local out = {}
  for i, m in ipairs(messages) do
    local text = type(m.content) == 'string' and m.content or ''
    if not text:match('^%[OOC%]') then out[#out + 1] = m end
  end
  return out  -- MUST return the (possibly new) message array
end
\`\`\`

Sandbox and failure contract:

- No \`st\` API, no network, no \`fetch\`. Stripped: \`io\`, \`os\`, \`debug\`, \`package\`, \`require\`, \`load\`, \`loadstring\`, \`loadfile\`, \`dofile\`.
- 5-second execution deadline; 64 MB Lua heap cap. A runaway script fails the step, never the server.
- \`messages\` is deep-cloned before the call, so a failing script cannot corrupt the pre-step array.
- A missing \`handle()\`, any error, timeout, or malformed/nil return keeps the PRE-STEP messages and records a trace note; the chain continues with the next step.

## Ordering

Steps compose, so order matters:

- \`strip-reasoning\` BEFORE \`ensure-thinking\`: strip collapses old assistant messages to plain text, then ensure-thinking prepends the required placeholder to exactly those stripped messages.
- \`whitespace\` BEFORE \`history-squash\`: clean the text first, then wrap/join it, so no stray runs survive inside the collapsed block.
- \`squash-system\` works on consecutive system messages wherever they end up; it composes fine with history-squash, which leaves system messages in place.

## Append-only layout

\`appendOnlyPromptLayout\` (prompt caching byte-prefix mode) disables chains entirely: post-render rewriting would break the byte-prefix invariant, so no chain is even resolved. If one is passed anyway it is dropped with the trace note \`request transformers disabled under append-only prompt layout\`. Note \`history-squash\` defeats prompt caching regardless of the layout switch.

## Trace

Skipped/failed steps never fail the request — they surface as notes on \`Prompt.transformerTrace\`, copied into the generation record at \`generations.meta.transformers\` (alongside \`meta.appendOnly\`). Check that field when a chain seems to do nothing — e.g. \`builtin step 'history-squash': invalid params (...) — skipped\`, \`lua step '<id>': script not found — skipped\`, \`lua step '<id>': script must define handle(messages, ctx) — kept pre-step messages\`, or \`lua step '<id>': script failed: <err> — kept pre-step messages\`.
`;
