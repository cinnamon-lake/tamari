/** Reference doc for the `prompt_lists` topic, served by the Docs tool. */
export const PROMPT_LISTS_DOC = `# Prompt Lists (presets)

A prompt list is an ordered set of prompt slots — the system-prompt stack. The **active** list is a global setting (\`activePromptListId\`); every generation builds from it.

## Prompt fields

| Field | Meaning |
|---|---|
| \`identifier\` | Stable id used in the order list (\`main\`, \`chatHistory\`, custom slugs). |
| \`name\` | Display name. |
| \`content\` | Prompt text (macro-resolved at build time). |
| \`role\` | \`system\` / \`user\` / \`assistant\`. |
| \`enabled\` | Toggle without deleting. |
| \`systemPrompt\` | Marks the prompt as a "system prompt" type. |
| \`marker\` | This is a placeholder filled at build time (no editable content). |
| \`injectionPosition/Depth/Order\` | Custom prompts can inject at a relative depth in chat history instead of the top-level stack. |
| \`forbidOverrides\` | Blocks character cards from overriding this prompt. |

## Built-in prompts

**Content prompts:** \`main\` (base system prompt), \`nsfw\`, \`jailbreak\` (post-history instructions), \`enhanceDefinitions\`.

**Markers** (filled automatically at build time): \`chatHistory\`, \`dialogueExamples\`, \`worldInfoBefore\`, \`worldInfoAfter\`, \`charDescription\`, \`charPersonality\`, \`scenario\`, \`personaDescription\`.

## Semantics

- \`main\` is never dropped, even when disabled.
- A character's \`systemPrompt\` / \`postHistoryInstructions\` override \`main\` / \`jailbreak\` content unless the prompt sets \`forbidOverrides\`.
- Order is the stacking order of the system block; markers determine where card fields, world info, examples, and history land.
- World Info fills its markers within a 25%-of-context budget (see topic \`lorebooks\`).
- Non-deterministic macros (\`{{random}}\`, \`{{time}}\`, …) anywhere in prompts or card content disable prompt caching for the generation.
- Deleting the active list falls back to defaults; the last list can't be deleted.

## Note for tools

There is currently no prompt-list workbench — prompt lists are user-managed in the UI. To influence the prompt stack from tools, use per-generation mechanisms instead: custom backends (full prompt ownership), request scripts, Author's Note (\`st.set_author_note\`), or lorebook entries.
`;
