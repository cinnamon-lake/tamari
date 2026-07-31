/** Reference doc for the `macros` topic, served by the Docs tool. */
export const MACROS_DOC = `# Macros

Macros are \`{{...}}\` placeholders resolved when text is processed. Arguments are separated by \`::\` and may contain nested macros: \`{{setvar::greeting::Hello {{user}}!}}\`.

## Resolution model (important)

- **Multi-pass, order-independent:** resolution loops until everything settles. \`{{setvar}}\` in one prompt can feed \`{{getvar}}\` in another within the same build.
- **Unknown macros pass through unchanged** as literal text. Unknown \`{% blocks %}\` vanish.
- **Non-deterministic macros** (\`{{random}}\`, \`{{pick}}\`, \`{{roll}}\`, all time/date macros) disable prompt caching for the whole generation.
- **Where resolved:** preset prompts, character card fields, persona, World Info at-depth content, Author's Note, stopping strings — all at prompt-build time. Chat messages are resolved once **at write time** and stored resolved (so \`{{random}}\` in a sent message is frozen; prompts re-roll per generation). When the append-only prompt layout setting is on, NO macro is resolved anywhere — everything renders literally.

## Reference

**Identity:** \`{{user}}\` (persona name), \`{{char}}\` / \`{{character}}\`, \`{{charIfNotGroup}}\`, \`{{group}}\`, \`{{groupNotMuted}}\`

**Character fields:** \`{{description}}\` / \`{{charDescription}}\`, \`{{personality}}\` / \`{{charPersonality}}\`, \`{{scenario}}\` / \`{{charScenario}}\`, \`{{persona}}\` (persona description)

**Model & tokens:** \`{{model}}\`, \`{{maxContext}}\`, \`{{maxResponse}}\`, \`{{maxPrompt}}\`

**Time (UTC, non-deterministic):** \`{{time}}\`, \`{{date}}\`, \`{{weekday}}\`, \`{{isotime}}\`, \`{{isodate}}\`, \`{{datetimeformat::YYYY-MM-DD HH:mm}}\` (tokens: \`YYYY MM DD HH mm ss\`)

**Chat inspection:** \`{{lastMessage}}\`, \`{{lastMessageId}}\`, \`{{lastUserMessage}}\`, \`{{lastCharMessage}}\`, \`{{firstIncludedMessageId}}\`, \`{{currentSwipeId}}\`

**State:** \`{{lastGenerationType}}\` (\`generate\` | \`continue\` | \`impersonate\` | \`regenerate\`), \`{{hasExtension::name}}\`

**Random (non-deterministic):** \`{{random}}\` (0–1 float), \`{{random::100}}\`, \`{{random::1::6}}\`, \`{{pick::A::B::C}}\`, \`{{roll}}\` (1d20), \`{{roll::2d6}}\`

**Variables:** \`{{setvar::key::value}}\`, \`{{getvar::key}}\` (local first, then global), \`{{.key}}\` (chat-local shorthand), \`{{$key}}\` (global shorthand). Each message stores a full variable snapshot — swipes/branches keep their own variables.

**Comparison:** \`{{equal::A::B}}\` → \`true\` or empty. \`{{? expr}}\` evaluates truthiness with \`&&\` / \`||\` splitting — falsy = empty string, \`false\`, \`0\`.

> **Caveat:** \`{{? ...}}\` does NOT implement comparison operators. \`{{? {{user}} == Alice }}\` does not compare anything — the whole non-empty string is just truthy. For real equality tests use \`{{? {{equal::{{user}}::Alice}} }}\`.

**Images (display-time only):** \`{{img::asset.png}}\` → character asset as a markdown image (sanitized-name fallback). \`{{attachment::id}}\` → inline media HTML for a chat attachment.

**Utility:** \`{{noop}}\`, \`{{newline}}\`, \`{{trim:: text }}\`. Card-compat no-ops: \`{{//}}\`, \`{{comment}}\`, \`{{hidden_key}}\`.

## Blocks

\`\`\`
{% if {{? {{equal::{{user}}::Alice}} }} %} Hi Alice!
{% elsif {{? {{equal::{{user}}::Bob}} }} %} Hi Bob!
{% else %} Who are you?
{% endif %}

{% unless COND %} ... {% endunless %}

{% for item::sword::shield::potion %}
  - You have a {{item}} (index {{forIndex}})
{% endfor %}
\`\`\`

\`{% elsif %}\` and \`{% elif %}\` both work. Inside \`for\`, the loop variable and \`{{forIndex}}\` (0-based) are available.

## Porting from RisuAI CBS

- \`{{getvar}}\` / \`{{setvar}}\` **exist and work the same way** (chat-local, branch-aware), plus the \`{{.var}}\` / \`{{$var}}\` shorthands. Lorebook content, card fields, and prompts can all read them.
- Risu \`{{#if}}…{{else}}…{{/if}}\` blocks in card fields are converted to \`{% if %}\` syntax automatically at import.
- No direct equivalents: \`{{chat_index}}\`, \`{{lastmessageid}}\`, \`{{greater_equal}}\` and other comparison helpers — use \`{{equal}}\` (the only comparison), or move the logic to \`replaceLua\` / a custom backend.

## Tips

- Randomized traits: \`{{setvar::trait::{{pick::cheerful::grumpy}}}}\` then \`{{getvar::trait}}\` anywhere later.
- Continue-aware text: \`{% if {{? {{equal::{{lastGenerationType}}::continue}} }} %}(Continuing...){% endif %}\`
- Want randomness AND prompt caching? Move the logic to a Quick Reply Lua script instead of \`{{random}}\` in prompts.
`;
