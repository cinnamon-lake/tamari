# Guildhall card audit

Audit of the unpacked card at `data-v2/unpacked-cards/guildhall` (`backend_logic/main.lua`, the 12 vendored libs under `backend_logic/lib/`, and the regex rules under `regex/`). Method: full read of the card source, diff of the vendored libs against the upstream `docs/design/examples/game-lib`, plus two live sessions through the MCP endpoint (`POST /api/mcp`, see `MCP.md`): registration → delve → explore → fight → mid-combat parley event → `/leave`.

Findings are ordered roughly by severity.

---

## 1. Info leaks to the player

### 1a. The planning sub-gen's entire internal design is served as the delve reply — systematic

`planFloor` returns the planner's raw final text as the player-visible reply (`main.lua:692-695`), on the assumption that "the reply is just the entrance narration". Nothing enforces that. Reproduced in both live runs:

- Run 1: the reply dumped the full design doc — every section theme, every room, the complete monster roster, and all interactables *with their rewards and locations*: "r6 The Deeper Tally — a scribe's stolen best: **Greenblade + 20g**", under the heading "best hoards in the dead ends".
- Run 2: "**3 interactables** at the dead ends (r2 scroll, r5 socket, r6 urn) + 6 ambient lines. **A plot debt filed**" — even the ledger machinery leaked.

This guts the fog-of-war design the card is built around (maptag carefully hides unvisited rooms, then the delve reply spoils them). Fix direction: make the planner end with a tool call (`finish_floor(intro)`) and serve that field, or serve `draft.description` and discard `res.text`. As a bonus, the leaked numbers were *wrong* anyway — the helmet's "8g" had been clamped to 5 by the depth budget, so the dump leaks mechanics that don't even match what's filed.

### 1b. Dice internals leak through the DM

`attempt()` returns `{ outcome, roll, total, difficulty }`, and the DM narrated "Roll: 20 — critical success" — quoting raw mechanics and inventing a crit rule that doesn't exist. The result note ("narrate THIS result") invites it. Return only `{ outcome }` (or add "never quote the numbers") if the dice are meant to stay backstage.

### 1c. Registration stats leak

`register_player`'s result ("Returns their starting stats… welcome them by name") produced "Piotr the rat-catcher is processed — 23 HP, 5 attack, 32 gold". hp/atk are otherwise hidden until the delve HUD. Minor, but the tool result's `note` field actively encourages reading stats back.

## 2. Real bug, reproduced live: `/leave` bricks the branch

`lib/events.lua:285-309` — `E.finalize` runs `loop.run(sub, res, ts:exec(), 4)`. In the live session the finalizer called `close_event` **successfully** (gist filed, takes filed, `state.event.closed` set), then kept re-calling it; `closeEvent` answered "already closing: e2", the model retried, the loop hit the 4-round cap, `loop.run` threw, and the card's pcall bricked the branch — *after all the work had already succeeded*. Every subsequent input returned the bricked message. There is no swipe in an MCP session, but even in the UI this is a coin-flip on weaker models.

Two compounding design errors:

- No early exit: once `state.event.closed` is set, further rounds are pure downside. The loop should stop (an `endsTurn`-style terminal signal, or a post-round check in `finalize`).
- `closeEvent`'s "already closing" reply reads like a retryable error to the model instead of a terminal success.

The comment in `events.lua` only anticipates the opposite failure (model never calls `close_event` → script fallback gist). The over-eager model path — the one that actually happened — throws.

## 3. Interface design issues

- **Invalid directions cost a full paid DM turn.** `serve()` only handles exits that exist; "go east" into a wall falls through to the dungeon DM with the entire floor-pack JSON in the system prompt (verified live twice — the second one also hallucinated "the dented helmet you already stripped" before it was touched, because the DM isn't told which interactables are used). The card knows the four compass words; a deterministic "no passage that way" for `go <compass>` with no exit would keep escalations for genuinely novel actions, which is the stated point of the DM.
- **Case-sensitivity gap.** `cmd` is never lowercased before `isModeVerb` / `hallTurn` comparisons (`main.lua:1283` onward) — "Delve" or "Shop" with a capital silently becomes a paid DM turn.
- **The store and blacksmith are toothless.** The card description and hall menu advertise them, but they're canned one-liners (`main.lua:1172-1177`) and the hall DM has no economy tools (no gold spend, no item grant — `remove_item` exists only on the dungeon DM). "Buy rope" can only produce a hallucinated transaction that state can't back.
- **The relic can be placed on any floor.** `add_interactable` accepts `effect.item = "relic"` on f1, and `applyEffect` instantly wins the delve (`main.lua:473-479`). Only the f3 prompt hint keeps the win item on the bottom floor — a one-line validation (`item == WIN_ITEM` rejected when `not isTerminalFloor(fid)`) would make it structural.
- **Scene-close duplication.** `eventTurn` appends the close gist as an extra paragraph after the scene-runner's final prose (`main.lua:1214`), and the model's final prose usually already summarizes — the registration close read as the same summary twice.
- **"Climb up" teleports to the upper floor's entrance** (`main.lua:782` sets a bare floor id, which `dungeonTurn` snaps to `pack.entrance`) rather than the stairs you came up. Minor, but it quietly erases the "descent is earned" geometry.

## 4. Lib issues

- **`lib/events.lua`** — the `/leave` bug above is the headline. Also `RESERVED` field checks (`digest`/`dossier`/`older_takes`) only run when `def.fields` is declared, not when a roster is injected — the injected-roster path (which this card uses) skips the guard.
- **`lib/loop.lua`** — throwing on the round cap is right for planning, but it's the same hammer that bricked `/leave`. The cap semantics deserve a softer mode for "the work may already be done" loops. (Its interleaved `tool_result`-inside-assistant-message shape is unusual, but `ClaudeBackendAdapter.ts:330-358` and the OpenAI adapter both split it into proper turns, so it's fine in practice.)
- **`lib/registry.lua`** — every read re-fetches and re-parses the pack blob: one serve turn's `floorPack()` does 4+ `store.getJson` round-trips on the *same* pack, and `R.get` calls `resolvePartition` twice. Correctness is fine; it's pure waste on the "free" path, and a per-turn memo would kill it. Also `loadPackBlob`/`fetch`-style "missing blob is a bug" throws mean any store hiccup bricks the branch mid-serve — loud by design, but the blast radius is the whole save.
- **Vendoring drift.** `lib/maptag.lua` has already diverged from `docs/design/examples/game-lib` (grid support), and `lib/layout.lua` exists only in the card. Two copies of the same lib with no sync mechanism will keep drifting; the header comment "vendored as backend_logic/lib/*.lua" doesn't say which direction is canonical.
- **`lib/chrome.lua`** — `clean()` strips `[HUD…]` but not `[MAP…]`, despite the comment claiming it's "the deterministic cleaning every delegate view shares". Latent inconsistency; harmless in this card only because no delegate ever sees transcript text.
- **`lib/sanitize.lua`** — arrays are rebuilt, maps are mutated in place; the mixed aliasing semantics are undocumented and surprising.

## 5. Display rules (regex) — mostly good

- `hud-panel` and `floor-map` parse only what the script emits; `maptag.clean()` strips `<>&'"|` from room names, so the model-planned content can't inject HTML into the map. Good.
- Gap on the HUD side: `hud()` (`main.lua:347-359`) interpolates floor/room names into `[HUD|where=…]` **without** the cleaning maptag gets. A planner-written room name containing `|` or `]` (both legal per the 60-char field spec) breaks the HUD parse. Same hygiene should apply.
- `hide-command-messages` (`/^\s*\/\w+.*$/s`, display-only) is safe as documented.

## What held up well

The core architecture is sound and verified live: deterministic serve turns with correct fog-of-war map and frontier `?` rooms; encounter rolls, cooldown flags, flee/kill/death paths; the fight gist as an untagged memoir line; a mid-combat parley opening an event and combat state surviving it; dossier takes filed per participant; swipe-safe pack/pointer commits. The libs' validate-clamp-file pipeline caught the planner's over-budget rewards exactly as designed.

## Priority order

1. Fix the `/leave` brick (data-loss-adjacent).
2. Fix the `planFloor` design dump (spoils the game's central mechanic every delve).
3. Fix the invalid-direction escalation cost.
4. Close the shop/smith economy gap.

## Resolution (2026-08-19)

All findings above were fixed in the unpacked card and the fixes were backported to the canonical sources (`docs/design/examples/game-lib/*.lua` + `docs/design/examples/guildhall/main.lua`), the Docs-tool topics (`game_cards`, `game_cards_example`), and `server/scripts/add-guildhall.ts`. In priority order:

1. **`/leave` brick** — `lib/loop` grew `opts.done`/`opts.soft`; `lib/events` finalizes soft-capped with an early stop once the close lands; `close_event` after the close returns a terminal "already closed" success instead of a retryable-looking error.
2. **Design dump** — planning ends with `finish_floor({ intro })`; the delve reply is `draft.intro` and never `res.text`.
3. **Paid direction refusals** — a bare compass word into a wall is a deterministic "No passage" serve.
4. **Economy gap** — `buy_item` (hall DM), `grant`/`end_combat` (dungeon DM); DMs are told never to narrate unbacked gold/items.

Also landed: `attempt` returns only `outcome`/`player_died` (1b); registration stats stay backstage and `register_player` closes the event itself (1c); the relic is structural-terminal-floor-only (3); the close gist is no longer re-appended after the closing prose (3); climb-up lands on the upper floor's stairs, and climbing out from the top floor ends the delve by choice (3); the lib fixes of §4 (events injected-roster guards, registry pack memo + string-form `partition_by`, chrome `[MAP]` stripping, sanitize aliasing documented, plus second-pass hardening in registry/events/rolling/ledger/todo/summarize); `lib/layout` is new (Lua-owned topology, the model only themes) and `lib/maptag` renders its grids.

The vendoring drift is closed: `docs/design/examples/game-lib/` is canonical again, `npx tsx scripts/sync-game-cards-example.ts` (from `server/`) re-embeds the sources into the `game_cards_example` doc, and `DocsTemplate.test.ts` locks the embedded copies byte-identical so the doc can't silently lie about the code.
