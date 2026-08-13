/** Reference doc for the `lorebooks` topic, served by the Docs tool. */
export const LOREBOOKS_DOC = `# Lorebooks (World Info)

A lorebook is a set of keyword-triggered entries injected into the prompt. Books are linked **1:1 to a character** (\`character.worldInfoId\`) — there are no chat-level, global, or persona books. The Workbench fs manages the linked book under \`/characters/<id>/lorebook/\` (auto-created on the first \`write\` to \`new.json\` — topic \`workbench\`).

## Entry fields

| Field | Default | Meaning |
|---|---|---|
| \`keys\` | \`[]\` | Trigger keywords. Case-insensitive substring match against chat history. |
| \`content\` | \`""\` | Injected text. May contain macros and \`@@\` decorators. |
| \`comment\` | \`""\` | Author note; never injected. |
| \`order\` | \`0\` | Sort order for budget competition (lower wins). Card imports default to 100. |
| \`position\` | \`before_char\` | \`before_char\`, \`after_char\`, \`top\`, \`bottom\`, \`atDepth\` — see Placement. |
| \`depth\` | — | For \`atDepth\`: messages from the end of history. |
| \`role\` | — | For \`atDepth\`: \`system\` / \`user\` / \`assistant\` role of the injected message. |
| \`probability\` | \`100\` | 0–100; rolled per scan. (Constant entries skip the roll.) |
| \`constant\` | \`false\` | Always active, no trigger needed. |
| \`selective\` + \`secondaryKeys\` | \`false\` | Require a primary hit AND a secondary hit (AND-logic only). |
| \`disable\` | \`false\` | Entry off. |
| \`regex\` | \`false\` | Treat ALL keys (primary and secondary) as JS regex patterns. Invalid patterns are skipped. |
| \`recursive\` | \`false\` | This entry's content becomes the next round's scan text (see Recursion). |
| \`retrievalMode\` | \`keyword\` | \`keyword\` \\| \`semantic\` (vector search via RAG) \\| \`constant\`. |
| \`sticky\` / \`cooldown\` / \`delay\` | — | Keep active N messages after last trigger / wait N messages between activations / ignore until N messages old. Branch-aware (tracked per message). |

## \`@@\` decorators (V3 card syntax)

Parsed only when content **starts with** \`@@\`; parsing stops at the first unknown decorator. Common ones:

- \`@@activate\` → constant · \`@@dont_activate\` → disabled
- \`@@depth 4\` → position \`atDepth\`, depth 4 · \`@@role user\` → injected role
- \`@@keep_activate_after_match\` → very large sticky · \`@@activate_only_after N\` → delay · \`@@activate_only_every N\` → cooldown
- \`@@additional_keys a, b\` / \`@@exclude_keys c\` — modify trigger key lists

## Activation pipeline (per generation)

1. Decorator pre-pass on every entry.
2. Sticky pre-evaluation: entries within their sticky window force-activate (sticky does NOT self-renew — it expires N messages after the last genuine trigger).
3. Up to **3 recursive rounds**. Per round: constants activate; others roll probability and check triggers against the scan text. Round results sort by \`order\`.
4. **Recursion:** content of activated \`recursive: true\` entries REPLACES the scan text for the next round (so entry content can trigger further entries). An empty round ends early.
5. **No token budget:** activation is bounded only by the deterministic knobs above (scan depth, recursion rounds, sticky/cooldown/delay, probability) — entry content is never dropped because of its size.

## Placement

- \`before_char\` + \`top\` → \`worldInfoBefore\` prompt marker; \`after_char\` + \`bottom\` → \`worldInfoAfter\` marker. (\`top\`/\`bottom\` piggyback on before/after — not independently placeable.)
- \`atDepth\` → spliced into chat history as a synthetic message at \`history.length - depth\`, AFTER Author's Note. Content is macro-resolved here; entries that resolve empty are dropped.
- Static-position (non-atDepth) entries that aren't constant disable prompt caching for that generation.

## Gotchas

- Entry content supports the full macro system, including \`{{getvar}}\` — dynamic "live state" entries work when something sets the variables: \`{{setvar}}\` in message text (resolved at write time), \`st.setvar\` from quick replies, or a custom backend emitting \`{{setvar}}\` in its output.

- Matching is always case-insensitive, non-whole-word (whole-word/case-sensitive options exist in the engine but are not wired to generation).
- Scan text is the FULL chat history (macro-resolved copy) — no scan-depth limit.
- Entry content is not macro-resolved at scan time (tokens counted raw); only at-depth content is resolved at injection.
- Whole-book updates regenerate entry ids, which resets sticky/cooldown history — prefer per-entry updates.
`;
