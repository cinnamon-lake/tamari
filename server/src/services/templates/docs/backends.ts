/** Reference doc for the `backends` topic, served by the Docs tool. */
export const BACKENDS_DOC = `# Backend Configs

A backend config is a named connection + generation preset. The **active** config is a global setting (\`activeBackendConfigId\`) shared by all chats — there is no per-chat backend binding (per-character behavior comes from contextual backends instead).

## Fields

| Field | Notes |
|---|---|
| \`name\` | Display name. |
| \`backendProvider\` | \`openai\`, \`openrouter\`, \`claude\`, \`gemini\`, \`moonshot\`, \`llamacpp\`, \`tabbyapi\`, \`koboldcpp\`, or \`custom\` (Lua backend). |
| \`generationMode\` | \`chat\` (message list) or \`text\` (flat prompt string). \`text\` forces the text-completion adapter regardless of provider; the adapter flattens the message list with its instruct template. |
| \`model\` | Model id. Never validated — anything goes. |
| \`apiUrl\` | Empty = canonical provider URL. Point at any OpenAI-compatible endpoint / reverse proxy. |
| \`apiKey\` | Raw key **or** a vault reference \`secret:<key>\`. Never validated; never exposed to tools/Lua. Local providers (\`llamacpp\`, \`tabbyapi\`, \`koboldcpp\`) need no key. |
| Samplers | \`temperature\`, \`topP\`, \`topK\`, \`minP\`, \`topA\`, \`frequencyPenalty\`, \`presencePenalty\`, \`repetitionPenalty\` — all nullable (null = don't send). |
| \`maxTokens\` | Response cap. |
| \`contextLength\` | Declared context size (reporting/metadata only — prompt content is never truncated on a token budget; history length is bounded by \`promptHistoryLimit\`/\`chatTruncation\` message counts). |
| \`stopStrings\` | Custom stop sequences (macro-resolved when \`customStoppingStringsMacro\` is set). |
| \`instructTemplate\` | For text mode: how the adapter wraps messages into the flat prompt (system/instruction wrappers, BOS/EOS, reasoning prefix/suffix). |
| \`providerParams\` | Advanced bag — see below. |
| \`logitBias\` | \`token: bias\` map, sent to OpenAI-family and textgen params. |
| \`openrouterProvider\` | OpenRouter provider routing (\`order\`, \`allow_fallbacks\`). |
| \`supportsImages/Audio/Video\` | Capability flags (default true). Media a provider can't consume is dropped, or replaced with \`[Attached image]\`-style placeholders when \`mediaVerboseMode\` is on. |

## \`providerParams\` — closed contract

Only declared keys survive; anything else is **silently dropped** on write. Declared keys include:

- **Structural:** \`requestScript\` (Lua request transformer — topic \`request_scripts\`), \`samplerDisabled\` (sparse per-knob kill switch: keeps the value on the config but omits it from the wire), \`customBackendId\` + \`delegateConfigId\` (for provider \`custom\` — topic \`custom_backends\`).
- **Adapter escape hatches:** \`cacheTTL\`, \`strictTools\`.
- **Advanced samplers** under their wire names (mirostat, DRY, XTC, dynatemp, …).

## Secrets

Prefer \`secret:<key>\` vault refs over raw keys (the \`api_key\` column is plaintext otherwise). The vault is AES-256-GCM keyed by \`TAMARI_SECRET\`; refs resolve just before adapter construction and never reach Lua or logs. An unresolvable ref is sent verbatim (the provider's 401 is the signal).

## How settings reach the wire

Config → \`buildBackendSettings\` → typed samplers + declared \`providerParams\` merged into the provider's params blob (moonshot/openrouter share \`openai.params\`; text mode → \`textgen.params\`) → adapter converts camelCase to snake_case → params merge is "first key wins": adapter-set fields (\`model\`, \`messages\`, \`max_tokens\`) can't be clobbered by the blob.
`;
