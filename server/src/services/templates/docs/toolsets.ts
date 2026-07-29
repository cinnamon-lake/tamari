/** Reference doc for the `toolsets` topic, served by the Docs tool. */
export const TOOLSETS_DOC = `# Toolsets & Tool Templates

**Templates** define tools; **toolsets** are enabled instances of a template with their own config and per-tool overrides. Only tools from **enabled** toolsets reach the model. Enablement changes apply on the *next* generation (tools are collected at generation start).

## The tool-call loop

Per generation: model gets all enabled tools → returns tool calls → each executes → results are appended as \`tool_result\` parts on the same assistant message → the prompt is rebuilt → the model goes again. Up to 100 rounds (default; \`MAX_TOOL_ROUNDS\` env). Tool errors come back as \`isError\` results the model can see and retry — they don't abort the turn. A tool defined with \`endsTurn: true\` ends the turn after SUCCESSFUL execution (no follow-up round); on error the flag is ignored.

Tool result content is rendered raw (no markdown), unless the result carries an \`extra.renderType\`, which hydrates an interactive widget in the chat.

## Toolsets

- \`config\` — values for the template's \`configSchema\` (JSON Schema; rendered as a form).
- \`toolOverrides\` — per-tool \`{ name?, description?, parameterDescriptions? }\` renames/descriptions applied before tools are advertised. The override-renamed name is what the model calls.
- \`enabled\` — master switch. Disable instead of deleting.

If two enabled toolsets expose the same effective tool name, the first match wins — nothing dedupes. Avoid collisions with overrides.

## Lua tool templates

A Lua template is a script returning a global \`Tool\` table:

\`\`\`lua
Tool = {}
Tool.state = {}

function Tool.getDefinition()
  return {
    stateKey = "my_template_state",   -- shared state namespace for all tools in this template
    configSchema = {},                -- JSON Schema for the toolset config form
    tools = {
      { name = "remember", description = "Store a fact.",
        parameters = { type = "object",
          properties = { fact = { type = "string" } }, required = {"fact"} } },
      { name = "recall", description = "Recall facts.",
        parameters = { type = "object", properties = {} }, endsTurn = false },
    },
  }
end

function Tool.execute(args, context, toolName)
  -- context: { chatId, config, messages }
  if toolName == "remember" then
    table.insert(Tool.state, args.fact)
    return { content = "Got it." }
  end
  return { content = table.concat(Tool.state, ", ") }
end

function Tool.serialize() return json.encode(Tool.state) end
function Tool.deserialize(raw) Tool.state = json.decode(raw) end

return Tool
\`\`\`

- **Branch-aware state:** after each execution, \`serialize()\` output is stored on the \`tool_result\` message's \`extra._toolState[stateKey]\`; the next execution restores the newest snapshot found scanning the current branch backwards. Forks get independent state; swipes don't lose it.
- **Media results:** \`execute\` may return \`content\` as an array of inline parts mixing text (with \`{{attachment::ID}}\`) and media parts — see the seeded \`forge_image\` template for the reference pattern.
- **Sandbox flags (per template):** \`allowIo\`, \`allowOs\`, \`allowDebug\`, \`allowRequire\` (all off = fully sandboxed; \`os.execute\`/\`os.exit\` always stripped), \`allowNet\` (async \`fetch\`, SSRF-guarded), \`allowFiles\` (\`attachments.create(base64, mime)\`), \`allowSt\` (curated \`st\` API: queries, entity writes, variables, settings, quiet generation — chat-history mutations and generation flow excluded).
- A broken \`getDefinition\` silently removes the template's tools from prompts (warn-only) — check the Workbench \`run test_luatool\` output.

## The Workbench

Lua tool templates and toolsets are edited through the \`workbench\` template's filesystem (topic \`workbench\`):

- \`/luatools/<id>/\` — \`meta.json\` (\`name\`, \`sandbox\`, \`configSchema\`) + \`code.lua\`. Code is load-validated before saving; \`run {"verb":"test_luatool","args":{...}}\` runs a tool from a stored template or raw unsaved code with fresh state — iterate the same way as backend scripts. Create via \`write /luatools/new.json\` (\`{ name, code, sandbox?, configSchema? }\`); the real path comes back in the result. No delete.
- \`/toolsets/<id>.json\` — create via \`write /toolsets/new.json\` (\`{ templateId, ... }\`; builtin template ids work), update via \`write\`. Create/update only — disable with \`{"enabled": false}\` instead of deleting.
`;
