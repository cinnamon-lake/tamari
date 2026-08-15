# Append-Only Prompt Layout — Design Proposal

**Status:** implemented (global setting `appendOnlyPromptLayout`, default off; Settings → Generation).
**Motivation:** coding-plan APIs with automatic prompt caching (discounted input tokens on cache hits) are becoming a primary backend for power users. Their caching is only profitable when the rendered request grows strictly by appends — and several Tamari prompt features violate that every single turn.

## Provider cache models

Two families exist in the wild; from the outside they are indistinguishable (same `cached_tokens` usage fields), so we design for the worse one.

**Lenient — block/radix prefix caches.** vLLM APC (16-token blocks, `hash(parent, tokens)` chaining), SGLang RadixAttention (radix tree, longest-prefix walk), DeepSeek disk cache (64-token units), OpenAI automatic caching (≥1024 tokens). Every computed block is indexed, so a request that diverges mid-history still gets credit for the prefix *above* the divergence. Floating injections cost only what's below their position (~1 exchange/turn for a depth-1 note). No write premium — misses are free.

**Antagonistic — snapshot caches.** Explicit-breakpoint systems (Anthropic `cache_control`: reads resolve only at markers, writes cost 1.25×) and per-request stores (hit = a stored full-context snapshot is a *verbatim prefix* of the request; the rational minimal implementation for append-only coding traffic). Here, content that moves position between turns poisons every snapshot it appears in: **a floating injection at any depth yields zero reads, every turn, while still paying write premiums where those exist.**

The purist append-only layout is optimal under both families, so it is the target.

## The governing principle

**Next turn's bytes for already-sent content must equal last turn's bytes, verbatim.** Anything that rewrites, re-resolves, repositions, or re-derives already-sent content between turns breaks the invariant — and in this mode, it dies. Append-only semantics are a **commitment**: the mode is deliberately destructive, and users opt into it for the discount.

## Config (decided: global)

One new global setting (Settings → Generation):

```
appendOnlyPromptLayout: boolean   // default off
```

(The Claude cache mode/depth/TTL controls it originally sat next to have since moved to the Backend Config modal as per-config `providerParams` — migration 017.)

Global, not per-backend (decided) — mixing providers with different cache leniency is accepted collateral; the user picks the mode for the strictest backend they care about. Orthogonal to the explicit-breakpoint caching controls (`providerParams.cacheMode`/`cacheDepth`/`cacheTTL`, per-backend config since migration 017 — they moved out of global settings because cache leniency is a provider property): layout shaping benefits explicit-breakpoint users too (breakpoints stop needing the floating-injection margin).

All overrides below are applied **at assembly time** — stored user settings are never rewritten. The Settings modal greys out the overridden controls with a "disabled by append-only layout" note while the mode is on, and every suppression is recorded in the generation's debug trace (`generations.meta`).

## The break list (what the mode disables)

1. **Depth injections of any kind.** No author's-note splice, no WI atDepth, no absolute-depth preset prompts mid-history. History renders verbatim.
2. **Non-constant lorebook entries vanish.** Keyword-triggered entries change the rendered bytes whenever the keyword set shifts — under snapshot semantics that is a full miss, so they are simply not rendered. `constant` entries keep their static head positions; constant atDepth entries hoist to the pinned block (rule 8).
3. **The macro system is off entirely.** History must be verbatim because model output can contain arbitrary macros — re-resolving `{{roll:d20}}` (or even `{{char}}` after a rename) in an old assistant message drifts already-sent bytes. Rather than adjudicate which positions are safe, resolution is disabled wholesale: `{{char}}` in a card field renders *literally*. This is the harshest break and it is intentional — cards that rely on macros are incompatible with the mode.
4. **Prompt-side regex rules are not applied** (global rules and character `extensions.regexScripts` with `prompt: true`). `aiOutput` rules are likewise not applied to persisted content — they would rewrite the provider's exact streamed bytes, and the next request would diverge from the provider-side snapshot. Display-only rules (`display: true`) are unaffected; they never reach the prompt.
5. **Response post-processing is forced off** — `trimSentences`, `removeXML`, `singleLine`, and `whitespaceMode` pinned to `'none'`: persisted assistant text must be the raw provider stream, byte for byte. The pin covers **both** whitespace passes — output at stream settle and *input* on user-message send (`GenerationService.handleSend`): rewriting outgoing user text would desync persisted text from already-sent prompt bytes.
6. **`reasoningAddToPrompts` is forced ON** — the provider's snapshot includes the reasoning it generated; stripping it from re-sent history diverges from that snapshot just as surely as editing the text would. Replay everything the provider produced, verbatim.
7. **Memory summaries are off.** A rolling summary prepended before history rewrites already-sent bytes on every update interval — the summary is neither used nor refreshed while the mode is on (`ChatPromptAssembly` skips `MemoryService.ensureSummaryUpdated` entirely).
8. **Non-deterministic macros** — moot given rule 3, but the existing `hasNondeterministicMacros` scan still runs and trace-notes findings (belt and suspenders for future sources).
9. **Volatile-but-wanted content hoists** to one pinned block at the top of history (after the system prompt, before message 1), deterministic order: author's note text → constant atDepth WI → absolute-position preset prompts. It changes only when its inputs change (note edit, constant-set change) — an occasional documented re-warm, not a per-turn bleed. Hoists are trace-noted, silent in the UI.

**Single source of truth:** the locked effective values live in `server/src/generation/appendOnlyLocks.ts` (`resolveEffectiveSettings`). Consumers read effective values from there; they never re-check the raw `appendOnlyPromptLayout` flag. New byte-mutating features must be added to that module, not gated ad-hoc.

## Existing machinery (do not duplicate)

- `providerParams.cacheMode`/`cacheDepth` on the backend config → `BuildOptions.caching` (read in `ChatPromptAssembly`) → `computeCacheDepth` (`PromptBuilder.ts:334`) → explicit `cache_control` breakpoints in the Claude/OpenRouter adapters. That machinery places breakpoints; it does not shape the request. With nothing floating, its `maxInjectionDepth + 2` margin is simply conservative — no change needed.
- Regex execution points: prompt rules run as the first splice stage; output rules run in the generation pipeline — both gain an early return when the mode is on.

## Accepted losses (documented, not fixed here)

- **Front truncation at the context cap** — the sliding window shifts the prefix and zeroes every snapshot, every turn, exactly when contexts are big. The largest remaining leak; *deliberately parked* — stable-cut/chunked truncation belongs to the summarization conversation.
- **Message edits / regenerates** — the user's own purchase; swipes keep the prefix up to the fork.
- **Continue** is safe: the partial message is a prefix of the prior snapshot (one caveat: whether a provider's snapshot end-token serialization matches a re-sent message is empirical per provider — docs note, not a blocker).
- **Group chats** — head content (active character card) changes per speaker; append-only is unattainable. Out of scope; the mode simply degrades there.

## Where it plugs in

- `PromptStages`: `historyRegex`, `authorsNoteSplice`, `worldInfoAtDepth` early-return or collect into `ctx.volatileBlock` when the flag is on; macro resolution in the renderer is skipped. Stage list unchanged — stages branch on the flag.
- The renderer (`ChatCompletionRenderer`) and the text-completion formatter (`backends/formatTextPrompt.ts`): emit `volatileBlock` at the pinned position, deterministic order; history messages pass through without macro/regex transforms.
- Generation pipeline: `trimSentences` / `removeXML` / `singleLine` / `whitespaceMode='none'` / output-regex forced off, `reasoningAddToPrompts` forced on, memory summaries skipped, input whitespace pinned — all resolved once per build via `appendOnlyLocks.ts` (`resolveEffectiveSettings`).
- `packages/types/src/schemas.ts`: the setting on its own (the neighbouring `claudeCache*` globals are gone — per-backend now); `SettingsModal.tsx`: checkbox + greyed overridden controls.
- `generations.meta`: suppressions and hoists recorded per generation.

## Testing

- **The property test:** append a message to the log, re-render, assert turn N's serialized request is a byte-prefix of turn N+1's (unchanged inputs). This *is* the feature; test it directly (`PromptBuilder.test.ts` + golden snapshots, mode on vs off).
- Unit: `{{char}}` in model output stays literal; non-constant WI absent while constant entries render; prompt/aiOutput regex not applied; `trimSentences` override; hoist ordering determinism.
- E2E (Playwright): setting persists across reload (settings-behavior pattern); a generation with an author's note at depth + a keyword WI entry renders the note in the top block and the WI entry nowhere (mock-LLM request capture, assert message order/content).

## Open questions

- Volatile block as one synthetic message vs. merged into the system prompt — renderer-level detail, decide at implementation.
- Should hoisted constant atDepth WI keep decorators? Default: content only.
