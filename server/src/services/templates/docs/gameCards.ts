/** Reference doc for the `game_cards` topic, served by the Docs tool. */
export const GAME_CARDS_DOC = `# Game Cards (complex card architecture)

Cards that run a real game — RPG, sim, mystery, raising — instead of just chatting. This is one shape that works; copy what works and grow from there. The mechanisms compose pieces documented elsewhere: the script contract and delegation (topic \`custom_backends\`), display/prompt regex (topic \`regexes\`).

## Why script

A model can track a stat block and run arithmetic through a calculator tool on its own. That is not the point, and it barely needs scripting.

The point is authentic game-like experiences where the player can simply *lose*. A model could, for five hundred turns, use tools to pretend to be an RPG — but it would be ruinously expensive and it would feel rigged, because it would be. Scripting puts real rules and real state behind the fiction so the loss is real and the win is earned.

And the other half: don't pre-script everything. Rolling stats, raising numbers, putting it all on red — that's fun. But so is "I blow the door off its hinges instead of looking for a key," or the princess finally snapping because you've *made her study* 24/7 for two weeks straight. The intended experience is both — the scripted game and the open conversation, integrated.

## The programming model

The script sits in front of the delegate model and owns the turn. It decides when to call the model, how to call it, and what to do with the answer. "Middleware" undersells it: this is not "edit the prompt a bit, call once, edit the output a bit." Beyond a simple card, the script owns state and the loop outright. If the user issues an \`attack\` command mid-combat, the script may resolve it without calling the model. If the script tries to spawn an enemy and its taunt fails validation, the script loops back with the error and the model fixes it. When a fight ends, the script may commission a two-line summary of how it went. If the user types something the script can't parse, it falls through to a chat turn.

**Build the delegate's prompt; don't filter the system's.** The prompt the model receives is something you *compose* — from \`state\` and from the chat history you parse yourself — not the engine's assembled prompt with bits whitelisted or blacklisted out. The simplest cards can get away with the strip-and-forward habit (emit a \`[sys]\` block, then gsub it back out of the delegated prompt); the moment a card does anything stateful you outgrow that and compose the delegate's \`messages\` yourself, at which point there is nothing to strip. Build-don't-filter is the line you cross, and most of the rest follows from it.

And the same on the way out: the delegate's text is raw material, not the reply. Commission a floor design and the model files the rooms through tools, then signs off with "Done — let me know if you need anything else"; that prose goes in the bin, the rooms are filed, and what the user sees next is whatever the script builds. The model's prose becomes the user-facing reply only when the script forwards it — a narrator turn, a chat scene. You build the output from what you want the user to see, the same way you build the prompt from what you want the model to see.

## State

The script declares what state the game has — the fields on \`state\`, the registries, the ledger — and \`state\` is the only thing that persists between turns. It is branch-aware: restored per branch before \`generate()\` and captured after a successful turn, so swipes and regenerations see the right world. Failed turns never overwrite the last good snapshot.

The model changes state only through tools, and Lua validates every mutation on entry — clamping to the budget, filtering tags against the closed list the engine implements, assigning an id, handing back the canonical record of what was filed.

## The tool loop

Every model call is the same shape. The script builds a prompt — a system briefing, the turns it wants the model to see, a toolset — calls the delegate, and runs the loop: the model writes prose and calls tools, Lua executes each tool and feeds the result back, and the model continues until it's done. Narrating a turn, fixing a validation error, summarizing a fight, judging whether a persuasion landed — same loop, different prompt and toolset. Tools are the channel for everything: the model files what it authors and queries what it needs.

For a novel action — something the deterministic state machine has no rule for — the delegate is the game master. The player blows up the door with a bomb, and the delegate decides that works and performs it through tool calls: \`remove_item("bomb")\`, \`add_exit("north", via = "destroyed door")\`, maybe \`make_noise(3)\` to rouse the floor. Lua runs those calls and holds the invariants: you can't spend a bomb you don't have, HP doesn't go below zero. That is all Lua does with a mutation. It does not decide what the action costs — it can't; there is no rule table that knows what "I blow up the door with a bomb" means, and writing one means enumerating every action a player could invent.

So you trust the delegate to game-master the novel slice, and there is no safety net. The invariant checks keep the numbers possible; they do not catch a delegate that blows every door for free. Trying to build that catch — Lua pricing each action, or gating tools behind game state ("no damage outside combat") — is the same trap either way: enumerate every case, write a trillion lines, and foreclose the emergent play (the princess snapping, the bar fight, tripping at the guild hall) that is the entire reason to script. Trust the delegate, keep the invariants, stop there. If the model writes prose where it should have called a tool — the spawn failed, the taunt didn't validate — the next loop round carries the error and tells it to try again.

## The state machine, and chat for the parts that aren't

Most of any game-shaped script is a state machine — combat, shop, navigation, idle, menu. Each is a place where the script serves deterministic responses to known input: buttons post bare commands, Lua answers, no model involved — until the player does something unscripted, which escalates to a delegate.

Chat is the state for the parts that aren't mechanics: actual conversation. The entry is the script failing to parse the input as a command, so it builds a prompt — some context (probably the summary of the last delve), the recent turns, the user's text as a plain \`{"role":"user"}\` — and forwards the model's reply. Within a chat scene the prompt is append-only — turn N is a strict prefix of turn N+1 — so the delegate's prefix cache hits and a per-turn call stays cheap (the frozen-system-block mechanics live in the event-engine section below). When the conversation is done, the model ends it itself, with a tool call.

Tool calls are the glue between the state the script owns and the prose the model writes. A princess mentions a new donut shop in conversation, files it mid-chat with the shop tool, and next time the player opens the shop menu it's there — because the model was given the shop tools and chose to use them. An ex-party-member turned enemy reads the character registry, then stabs you and drops your HP by 10. The script doesn't predict these moments; it hands the model the tools and lets them happen.

## Summaries do two jobs

Summaries keep the context clean — the mechanical turns collapse into one line, so history outgrows the window gracefully.

But the second job is the interesting one: a summary is a surface for the model to *react* to the mechanics. The fifth goblin flees in round one — maybe the rogue says "they're running because you stink." The model reads the fight transcript and notices, on its own, that the player ate fifteen cheese wheels while getting bullied by the boss. You could hand-code a hook for each such moment; you'll never think of all of them. A summary over the right span gives the model a chance to notice what it was never explicitly told.

---

The rest of this doc is these principles applied to specific shapes of game: the narrator-vs-factory ratio (how often you call the model), the content factory (factory-ratio crawls), the event engine (chat scenes over a cast, with dossiers), the ledger (compaction-proof commitments), compaction mechanics, and the vendored game lib. They are derivations of the above, not additional principles.

## The two ratios: narrator vs content factory

Decide the delegate's cadence before anything else — it shapes everything downstream.

- **Narrator ratio** (the turn-flow skeleton below is this mode): every turn costs a delegate call — the model writes prose, Lua does math. Right for dialogue-first games (dating, raising, mystery) where the model's voice IS the product. Wrong default for videogame-shaped cards: it feels like chatting with a model that owns a dice roller, and it pays for a generation on every "I open the box."
- **Factory ratio**: the model is invoked at content BOUNDARIES and writes in bulk; Lua serves the generated cache for the next N turns. Right for dungeon crawls, survival, exploration — "dynamically generated videogame," not "dungeon master." Cheaper, more coherent, and it makes the rare live turns feel like magic.
- If what you want is an actual dungeon master, build NEITHER: a plain chat plus a display-regex HUD (topic \`regexes\`), \`run_lua\`/dice tools, and the memory features covers it. This machinery is for games that run themselves between model calls.

## The content factory (model as author, not narrator)

Factory for the anticipated, DM on escalation — ONE tool economy drives both.

**Bulk generation at boundaries.** When the player enters a room/floor/area (or when it's generated), run ONE planning-mode sub-gen where the model builds the whole content pack through tool calls: \`create_room\`, \`add_interactable("box", { responses = {...} })\`, \`spawn_encounter({...})\`, \`add_ambient_lines({...})\`. (Yes, a dedicated planning gen — mid-narration invention is a tool call in the same turn that produces the prose, no planning mode; boundary generation is its own call by design. A write is a write, whenever it happens.) Tools, not one json_schema blob: a blob is one-shot, but tool calls let the model think in increments — revise and extend in-fiction ("the stairs are open, so \`spawn_enemy(trog, location = "upper")\` — they're climbing up"). Every mutation tool takes a \`reason\` field; reasons flow into the briefing, so "why are there trogs on floor 2?" has a canonical answer forever. Lua validates on entry (budgets, closed lists — the \`register_enemy\` clamps) and stores the pack keyed by area id. Size the boundary generously: a pack should hold a whole explorable AREA — a graph of rooms with branches and dead ends, its random-encounter roster, its interactables — not a single room. One-room packs degenerate into room → fight → room: the narrator ratio with extra steps. Pre-write the flavor packs too: boss banter, shopkeeper patter, death quips, deflections — ~10 lines each, cycled deterministically.

**Serve deterministically.** Input matches against the room's interaction table (keyword/verb sets — parser-game style); canned lines come back with ZERO model involvement; ambient lines rotate by turn counter. Cached turns are a pure function of \`state\`, so regenerate and swipes are stable by construction — the whole regenerate question doesn't arise on a cache hit.

**Escalation is the product, not the failure mode.** Cached content exists to make the 10% magical — "wait, I can just blow the door up?" only lands because the last 30 doors didn't blow up. Novel input escalates to the delegate with the FULL mutation toolset: the model interprets the attempt and resolves it through tools (\`remove_item("bomb")\`, \`add_exit("north", via = "destroyed door")\`), then narrates the result. Keep a miss counter: a high escalation rate means the packs are thin, not that the player is brilliant.

**Storage: pack blobs in the store, pointers in \`state\`.** Content packs run 2-5KB each and \`state\` snapshots persist per message — a dozen packs in \`state\` and every assistant message carries 50KB of duplicated JSON. So the blob goes in the \`store\` global (topic \`custom_backends\`): \`store.put("pack:" .. fid, json):await()\` returns an id, and the branch-aware pointer (\`state.packIds[fid]\`) is all \`state\` carries. Swipe correctness falls out of the pointer living in \`state\`: a mutation is a NEW put plus moving the pointer, so old branches keep their version, and a swiped-away branch's blobs are simply unreferenced (engine-side GC is a later problem). The player sees a plain memoir line where the pack was generated ("Designed The Upper Halls: …") — no tags, nothing to regex. Pull the full pack back with \`store.get\` when the player walks in.

A complete, tested card — this factory-ratio half and the event engine below together — lives in topic \`game_cards_example\` (The Guildhall): floor-graph planning, roster-based random encounters, serving, escalation, and pack versioning, all proven through the real adapter.

## The event engine (social play as modes)

The factory card's escalate path generalizes into a third shape: the EVENT. The player idles at a deterministic menu (delve, shop, smith — serve-land buttons); free text escalates to a DM; and when the action opens a scene, the card switches modes — a conversation with a cast, run by a delegate, until it closes. The machinery ships as \`lib/events\` (The game lib): the card declares its character fields and keeps only its menus, prompts, and economy. The merged card (topic \`game_cards_example\`, The Guildhall) exercises the event engine end-to-end; this is the theory.

**Events are modes.** Like combat in the factory card: while \`state.event\` lives, the menu is gated ("finish your business here first"), free text goes to the scene-runner, and the button row matches. ONE open event at a time — no nesting, no suspension; a second \`open_event\` is rejected (the DM toolset has no close), so cards route a still-open event's turns through the scene-runner, never back to the DM. The Guildhall enforces this with \`ev.isOpen()\` before the mode turn. Mode lives in \`state\`, never in the log — the engine emits no markup; a greeting's defaults are \`ensureState\` DEFAULTS, not something to parse back.

**Two delegates, not one.** Split the boundary turn's work by prompt SHAPE. The DM (idle escalation) adjudicates the attempt and FRAMES the event: \`open_event({ kind, context })\` — who the player is and what they're after, NO character list; casting is not the DM's job, and its toolset shouldn't even have \`register_character\`. Summarize the situation that opened the scene INTO that context before the mode flips — what just happened AND the relationship state (first meeting or known) — because the frozen-prefix rule (below) means nothing can be spliced into the scene-runner's briefing later. The open context is its picture of how we got here; the public record (STORY SO FAR in its frozen block, \`inspect_summary\` in its toolset) and the dossiers are how it checks that picture. The scene-runner takes over in the SAME turn and owns the event until it closes. It writes EVERY participant at once (per-character sub-gens are a cost trap), so it always sees the entire current chat — never filter the live scene per character. It casts from the registry: \`list_characters\` before inventing anyone, \`get_character\` for a file, \`register_character\` to file someone new, \`add_to_chat\` to bring them on stage.

**Script-opened events compose their context from \`state\`.** A card may open an event without a DM (the Guildhall's onboarding) — but then nobody frames the scene, so the context must be BUILT from state: who the player is, what just happened, whether the cast has met them. A hardcoded context is safe only when there is no history to contradict (virgin state, a first turn); once the game has a past, a canned context — or a scripted opener that presumes one ("welcome back, how was the dungeon?") — asserts it blindly, and the scene-runner will believe the script's premise over the record. The Guildhall script-opens exactly one event for exactly that reason.

**The frozen-prefix rule (this is why the split pays).** A chat event is narrator-ratio — a delegate call every turn — so make those calls CHEAP: the scene-runner's prompt is append-only within an event, and the delegate's prefix cache does the rest. The span is MECHANICAL, not parsed: \`state.event.spanId\` heads a persistent linked list in the store (topic \`custom_backends\`, the \`store.append\`/\`store.readArray\` primitives), one node per turn. The tail is FULL-FIDELITY — the user inputs, the assistant text, AND the tool_use/tool_result rounds — because replayed tool results are what stops the model re-issuing the same reads every turn (extra rounds AND a cache miss over the volatile part). The system block (instructions + event context + the STORY SO FAR briefing) is byte-frozen for the event's lifetime — the story briefing is safe there because the story channel changes only at an event close (which ends the event) or a boundary gist, never mid-scene. Volatile state rides in the newest message, never the prefix; anything that would otherwise mutate the prefix — character defs, dossiers — arrives as READ-tool results in the tail instead. Branch correctness comes free (an old branch's \`spanId\` still points at its own head), and history budgets are irrelevant — the span never touches the log. The Guildhall's test asserts the strict prefix AND that turn 2's tail carries turn 1's tool blocks.

**Dossiers: memory keyed by WHO was there.** An event closes into two channels. The gist is NEUTRAL — one line for the record (the story entry and the memoir line consume it). Each participant gets a TAKE — what THAT character carries away, facts plus impression — filed in \`state.dossiers[charId]\` by \`close_event({ gist, takes })\`. Knowledge asymmetry becomes structural: no take filed, no knowledge — the eavesdropper's take differs from the host's, and the absent have none. And an EMPTY dossier must read as never-met, not as missing data — say so outright in the scene-runner prompt, because a gap in the record loses to a strong prior: the model fills silence with assumption, and canon-heavy casts come with the loudest assumptions. Validate take keys against the participant list and drop strangers canonically. When a character reappears, \`get_character\` serves their dossier as a read-tool result — recent few in full, and when the backlog outgrows the window, one cheap sub-gen FOLDS the oldest takes into a running digest. Dossiers are \`lib/rolling\` channels (\`state.dossiers[charId]\` is an id array, takes are gist-only entries): the fold entry's content is the descriptor list of what it compressed, so the zoom chain works here too (on read, so one-off NPCs never cost a token; a delegate error fails the turn loudly — ids move only once the fold entry is filed, so a swipe retries with memory intact). The fold's sub-gen needs the turn's prompt: the card calls \`ev.bindPrompt(prompt)\` once per generate — unbound, folds stay dormant and takes just accumulate. {{user}} gets no take; the player remembers their own business.

**The exit is a button; the close is one gen.** \`/leave\` is a serve-land button — the player is never trapped in a chatty delegate's scene. But closing needs a gist and takes, which only the model can write, so the exit runs ONE cheap finalize gen over the chat for \`close_event\`. A delegate ERROR fails the turn loudly — state rolls back, the event stays open, and a swipe retries the exit. If the model just spends its rounds without closing (a content outcome, not an error), the event still closes with a script-composed fallback gist.

**No structural tags; cast is state.** The event engine emits NO markup — the close's memoir is a plain line of prose, and who is on stage is not a tag either: it rides the newest user message as a parenthetical cast note, built from \`state.event.participants\` (\`ev.castLine()\`) — volatile state in the newest message, never the frozen prefix. The model never types a bracket; \`ev.strip\` removes freelanced tags from delegate text as pure defense.

## Turn-flow skeleton

The narrator-ratio spine — a factory card runs the same shape, with a cache lookup where the delegate call would be and escalation on a miss:

\`\`\`lua
function generate(prompt, ctx)
  ensureState()                       -- idempotent defaults; state arrives restored for this branch
  local input = lastUserText(prompt)  -- scan prompt.messages backwards for role == "user"

  local cmd = parseCommand(input)     -- typed or button-posted; see below
  if cmd then return handleCommand(cmd) end

  local outcome = resolveRules(input) -- pure Lua: dice, costs, cooldowns — NO model involved
  local sub = buildDelegatePrompt(prompt, outcome)  -- filtered history + state briefing + sub.tools
  local res = backends.generate(sub):await()
  res = runToolLoop(sub, res)         -- file writes, answer reads, re-call
  return finalize(res.text, outcome)  -- apply deltas, append HUD tag, return
end
\`\`\`

Guard \`ctx.generationType\`, and get the asymmetry right: on \`regenerate\`, \`state\` rolls back to BEFORE the turn, so re-resolving the command is safe whenever every side effect lives in \`state\` — and re-rolling keeps swipes interesting. On \`continue\`, \`state\` is post-turn, so NEVER re-resolve — narrate onward only. Don't try to cache the outcome in \`state\` for regenerate stability: the rollback undoes your cache along with everything else, and you'd re-narrate the PREVIOUS turn. (The exception that still needs a hard guard on both: one-shot side effects that escape \`state\`, like a submitted form firing a real action.)

## The hard case: model-designed enemies

The one place model creativity has stat-shaped consequences. The model is great at CONCEPTS ("a glass knight that reflects spells") and terrible at balance — so **Lua owns the power budget, the model owns the concept**. State the current tier/budget in the briefing or the tool description; the model calls \`register_enemy\` with its concept and allocation; Lua clamps. Calibration: strict budgets for bosses, free-form-with-clamps for grunts. And the key trick: **ability tags come from a closed list the combat engine implements** — \`reflect_magic\` has real mechanics; the free-text flavor around it is free. Bosses are the same shape one level up: the model designs phase BEATS ("at 50% he shatters the floor"), Lua owns the trigger logic, the transition narration is a flavor sub-gen.

## Judgment as data: \`response_format\`

The minority case where structured output beats tool calls: you need the model's EVALUATION, not invention — did the persuasion land? how bad is that wound? Run a dedicated sub-generation whose whole answer IS the data: \`response_format = { type = "json_schema", schema = ... }\`, consume with \`json.parse_result\`, pattern-match \`.error\`, keep a sane default. Cheap models are fine for evaluation; save the good model for prose.

## The ledger: long-term planning

The model will make commitments about the future — a rule it just invented ("Mira's affection caps at 40 until the festival"), or work it explicitly defers ("the brother's design — I'll finalize it when I lay out floor X"). PROSE CANNOT CARRY THESE: rolling summaries paraphrase foreshadowing away ("cap 40 until the festival" survives one compaction pass as "she was distant"). The ledger is the compaction-proof channel — same shape as any registry (filed through a tool, validated, canonical), but what's registered is INTENT, not entities.

- **One tool: \`promise({ id, what, due })\`** (plus \`resolve_promise\`). Filed mid-narration like any registry call. The critical validation: \`due\` must be a CONCRETE anchor — floor 12, week 20, an event id, a stat threshold. Reject "later" at registration; a vague due date is a promise that never comes due. (The lib clamps a filed \`due\` to now+1 … now+50 — never this turn, never past the horizon.)
- **Two enforcement tiers.** The lib ships the narrative tier — \`promise\`/\`resolve_promise\` file intent and \`briefing\` reminds. The executable tier (a tiny vocabulary Lua reads directly, like \`cap = { who = "mira", max = 40, until = "mira_festival" }\` enforced by your own clamp, mechanically true the same turn) is card-side: a few lines against the filed records, not a lib DSL — keep it tiny, three primitives cover almost everything. Everything else is narrative-only — you can't enforce "design the brother well," but you can remind.
- **The briefing is the memory.** The pending ledger rides in every briefing; Lua computes due-ness (it knows floors, dates, stats) and escalates — \`DUE NOW: the brother — design him this turn\`. Escalation is what makes "I'll finalize later" reliable instead of a prayer.
- **Lifecycle includes failure.** pending → kept / failed. Failure is canon: miss the festival and her route closes — now a mechanical fact Lua enforces from then on.
- **Swipes come free.** A promise filed in a swiped-away turn vanishes with the branch — different swipe, different future. Once persisted, the ledger is canon; tell the narrator so ("never contradict the ledger").
- Optionally auto-file a stub when a due promise is ignored (a placeholder brother design) so a due floor never ships empty. Insist-in-prose first; add stubs when a card proves it needs them.

This is what turns the delegate from a turn-writer into a SHOWRUNNER: it plants in act 1 and trusts the payoff in act 3, because the reminding is structural, not contextual. The Guildhall (topic \`game_cards_example\`) carries a turn-anchored version in both its planning and DM toolsets.

## Compaction: the memoir and the zoom chain

History is what outgrows the context window first, and the answer has two halves that never meet. For the PLAYER, the boundary turn serves the gist as a PLAIN LINE of prose — "Cleared the flooded library; Mira lost her locket." — a memoir line like any other narration. No tags, no display rules: nothing is emitted just to be regexed away. For the MODEL, memory is the rolling story channel (The game lib): the same gist, filed mechanically with the span it covers as zoomable content, briefed as \`STORY SO FAR\`, inspectable by id. No delegate ever reads raw history, so there is nothing left to collapse FOR one. (Functional chrome is the exception to "no tags": the \`[HUD|…]\` and \`[MAP|…]\` tags are compact DATA a display rule renders as a panel or map — a real feature, topic \`regexes\`.)

**Who writes the summary:** the model, on the closing turn — \`lib/summarize\`'s gist sub-gen over the span the card tracked mechanically (the fight log in \`state\`). The script owns the discipline (one line, no double quotes), the model owns the content. A nil means there was nothing to summarize (no span, empty answer) — the card serves its fallback line; a delegate ERROR fails the turn and a swipe retries.

- **Gist vs exact.** A summary is a paraphrase. Gist lives in story entries and memoir lines, mechanics in \`state\`, commitments in the ledger — a fact that must stay exact may never travel ONLY in a summary.

**The zoom chain is the antidote.** Once the delegate's view is compressed, give it a way back to the record — recursively, not with a text search. The fight log and the event span are filed as rolling entry CONTENT (mechanical, branch-aware — never re-parsed), and \`inspect_summary({ id })\` (lib/rolling) opens any summary by id: a fold entry lists the summaries inside it, each with its own id, down to the raw blows and scene replies. The model tool-calls its way from the digest to the exact exchange it half-remembers. One honest bound: summaries and spans are text, not truth — how the goblin encounter WENT is in the story, the goblin's HP is in \`state\`. Exact facts still belong to registry/ledger. (The \`chat\` global's full-branch \`chat.find\` remains as a raw escape hatch, topic \`custom_backends\` — the zoom chain is the structured answer.)

Four channels, four fidelity levels: \`state\` for mechanics, the ledger for commitments, story entries for gist, the store for verbatim-on-demand (rolling content, spans, packs — ids in \`state\`, blobs in the heap).

## The game lib (vendored modules)

The reusable 90% of this architecture — the parts every game card re-derives, some of them genuinely tricky (the persistent-list span, the js_null footgun) — ships as eleven small Lua modules. Get them into a card with one call — \`run {"verb":"add_game_lib","args":{"characterId":"…"}}\` vendors all eleven as \`backend_logic/lib/*.lua\` (overwriting \`lib/\` keys only; topic \`workbench\`) — then \`require("lib/<name>")\`. The full sources are at the end of topic \`game_cards_example\`; the Guildhall is the single worked example — the factory-ratio dungeon crawl and the event engine together. Vendored, not engine-provided: the card owns its copies, so exports work on any install and behavior is pinned per card.

**The contract** — every tool-providing module composes the same way (plain dot calls; the rest — \`loop\`, \`sanitize\`, \`chrome\`, \`summarize\`, \`maptag\` — are plain utilities):

\`\`\`lua
M.tools()          -> array           -- tool schemas (may be {})
M.exec(name, args) -> string | nil    -- nil = "not mine", try the next module
\`\`\`

**The modules.** \`loop\` — the delegate tool loop: \`loop.run(sub, res, exec, maxRounds?)\`, default cap 16 (a todo-planning delegate eats rounds on top of its real calls); hitting the cap with calls still pending THROWS — a wedged delegate fails the turn loudly, it never silently drops pending tool work. \`sanitize\` — \`sanitize.data(t)\`, strips js_null and non-data from \`json.decode\` output. \`chrome\` — \`chrome.btn(cmd, label)\` (bare command payload), \`chrome.unwrap(text)\` (a posted command → bare verb), \`chrome.clean(text)\` (the deterministic strip for anything that reaches a delegate: legacy \`[sys]\`, buttons, HUD, trim — applied to user input on span append, and by \`inspect\` rendering), \`chrome.oneline(text, max)\` (one tag-safe line: quotes, whitespace, cap). \`ledger\` — the plot ledger as a module: \`ledger.bind(fn)\` once per turn (\`function() return state.turn end\`), then \`tools()\`/\`exec()\`/\`briefing()\`. \`todo\` — delegate self-planning: \`set_todo\` REPLACES the checklist, \`todo_done\` marks items, every result echoes the remaining list so the plan rides the tool loop; \`todo.briefing()\` for the prompt. \`summarize\` — the gist engine: \`summarize.gist(prompt, opts?)\` runs the gist sub-gen over \`opts.span\` (the card's mechanically tracked span — the fight log; mechanical turn-log in, "how it WENT" line out — costs, close calls, items spent; nil only when there's nothing to summarize — a delegate error fails the turn and a swipe retries it). The gist goes two places, both tagless: a plain memoir line in the reply and a rolling story entry. \`maptag\` — \`maptag.tag(rooms, { cur, entrance, stairs, seen? })\` builds a compact \`[MAP|…]\` tag from a room graph, fog-of-war included (pass a \`seen\` set: visited rooms get names, the frontier shows as "?", the stairs marker waits for the stairs to be seen); a companion display rule renders it (source in \`game_cards_example\`). \`toolset\` — composition (below). \`registry\` — the write shape from a declaration (below). \`events\` — the event engine from The event engine above: the card creates the character registry itself (\`registry.new\` with ITS fields) and injects it — \`events.new({ roster })\` (or declare \`{ fields, key? }\` and the engine creates the roster) — so the cast stays SHARED, never opaque (another toolset gets the same instance; \`roster.get(id)\` returns the live record for ad-hoc mutations like \`rec.dead = true\`). The engine owns event state (\`isOpen\`/\`kind\`/\`eventLine\`/\`clear\`), the cast tools (\`register_character\`/\`list_characters\`/\`get_character\`/\`add_to_chat\`), dossiers with fold-on-read digestion — armed by \`ev.bindPrompt(prompt)\` once per generate, dormant without it — no structural tags — \`ev.strip\` removes freelanced brackets as pure defense — and the cast note (\`castLine\` — who is on stage, from \`state.event.participants\`, riding the newest message), the mechanical append-only span (\`spanStart\`/\`spanAppend\`/\`span\`/\`hasSpan\` — a persistent list in the store, full tool-round fidelity), and \`finalize(prompt)\` for the deterministic \`/leave\`. Two contract views: \`ts:use(ev)\` for the scene-runner, \`ts:use(ev.dm())\` for the DM's \`open_event\`-only slice. \`rolling\` — recursive rolling summaries: a channel is a plain id array the card owns in \`state\` (\`state.story\`, a dossier), each entry a store blob whose id IS its address, so the store doubles as the archive. \`rolling.bind(prompt)\` once per generate arms folds; \`rolling.push(ids, { label, gist, content? })\` files an entry (content = the actual array it covers — a message list, a battle log); \`rolling.briefing(ids)\` serves id-bearing lines, folding the oldest entries into a digest entry when the list outgrows 3+3 — the fold entry's content is the descriptor array of what it compressed, so the model can \`inspect_summary\` its way from digest to sub-summaries to the raw log; \`rolling.inspect(id)\` is the zoom, also exposed as the \`inspect_summary\` tool via \`ts:use(rolling)\`; \`rolling.parts(ids)\` is the dossier serve shape. The Guildhall (topic \`game_cards_example\`) is the worked example.

\`\`\`lua
local ts = toolset.new()
ts:use(ledger)          -- any module with tools()/exec()
ts:use(enemies)         -- a registry instance (same contract)
ts:handle("attempt", function(args) ... end, ATTEMPT_SCHEMA)  -- ad-hoc tools
sub.tools = ts:schemas()
res = loop.run(sub, res, ts:exec())   -- first non-nil answer wins; ends "unknown tool: X"
\`\`\`

**\`registry\` — the write shape as data.** Declare "a registry of something" and the lib owns validation, clamping, closed lists, id assignment, the canonical tool result, and swipe-stability:

\`\`\`lua
local enemies = registry.new({
  tool = "register_enemy",       -- the mutation tool the model calls
  key = "enemies",               -- stored at state.enemies (a plain array)
  id_from = "name",              -- slugified id; re-registering returns the EXISTING record
  query_tool = "get_enemy",      -- optional read-shape tool
  cap = 8,                       -- optional budget
  fields = {                     -- ARRAY; order is preserved in the schema
    { name = "name", type = "string", required = true, max = 40 },
    { name = "hp",   type = "integer", min = 1, max = 20, default = 6 },
    -- min/max may be zero-arg functions (depth-scaled budgets)
    { name = "tags", type = "array", closed = { "flying", "reflect_magic" } },
  },
  store = { get = function() return draft.roster end },  -- optional: draft mode (planning)
  on_register = function(rec) rec.maxHp = rec.hp end,    -- optional reshape/side effects
})
\`\`\`

The tool result is a JSON echo of what was ACTUALLY filed (clamps, dropped tags, assigned id); missing required fields reject with names; \`get_enemy\` answers canonically from the filed records. Re-registering an existing id returns \`{ already_registered, record }\` — never an overwrite, so a regenerated turn converges to the same record (swipe-stable). Power budgets stay the card's — declared as numbers or functions — the lib just enforces them.

## The supporting patterns

**Chrome: bare commands, visible acks.** Buttons post bare \`/command\` payloads — never wrap a payload in a tag a display rule hides: display regexes are structure-blind and would eat the attribute, killing the button. Acks are plain VISIBLE text — the model sees the same results the player does, and a capable model needs nothing hidden from it, so game cards have no hidden-chrome tag. Don't reach for a \`[sys]\`-style hide channel: it just rewrangles the delegate's prompt for no gain, and anything the delegate should analyze or summarize ("the player BARELY beat the goblin") must ride a channel it can see anyway. Prompt-side, the script drops bare command messages; display-side, hiding whole-message commands is an optional \`userInput\` rule — honest text by default. The bare-command/button recipe is in \`custom_backends\` (Middleware example).

**Card fields: only \`firstMes\` is load-bearing.** A backend-logic card bypasses the engine's prompt assembly — personality, scenario, mesExample, prompt presets, and LOREBOOKS all land in the script's incoming prompt, and the script composes the delegate's \`messages\` by hand, so none of it ever reaches a delegate; it just taxes the script's own view. Leave personality/scenario empty; keep description/creatorNotes for the library UI. A lorebook attached to a game card is the classic dead-weight mistake. The lorebook EQUIVALENT, when you need one: facts the model writes are registries (locations, characters, items — filed and queried through tools, budgeted by you); sprawling GENERATED material is store blobs with ids in state; and big STATIC world prose is a read tool over a card-authored table — the docs-tool/\`set_memory\` pattern, except static lore needs no storage at all, it's code in the script: \`ts:handle("lore", …)\` keyword-matching a \`LORE\` table and returning the entry. Anything that must steer a delegate unconditionally goes in the briefing the script composes.

**Always end with the buttons — but only buttons the next turn can SERVE.** Every message a game card emits should end with its button row, so the player is never stranded reading prose with no affordance. The static \`firstMes\` is the one trap: the script doesn't run for greetings, so hardcode the opener's buttons into the greeting text — and make sure the first turn's state can answer them. If your card onboards (a registration scene, a character-sheet interview), the opener offers NO buttons, or only ones that route into the onboarding: the menu doesn't exist yet and a button that posts \`/delve\` into an unregistered game is a lie (the Guildhall's greeting offers none — the receptionist asked a question; type, don't click). If the first turn is the normal state machine, hardcode away — any button firing the first turn is fine.

**Multi-character presence.** With the event engine (topic \`game_cards_example\`), presence is already structural — the cast lives in \`state.event.participants\`, rides the newest message via \`ev.castLine()\`, and per-character dossiers are rolling channels. Without it, record who was present as message ids in \`state.presence\` and filter \`prompt.messages\` to the scenes a character attended (plain string matching, no NLP) when you write them — models do better seeing only what the character saw.

**Rolling summaries.** Three channels, three jobs: memoir lines (above) mark the boundaries for the PLAYER; \`lib/rolling\` runs the STORY — a running, recursive digest of everything that happened, with \`inspect_summary\` as the zoom into the raw material (a channel is an id array in \`state\`, entries are store blobs); and the event engine's dossiers ARE rolling channels keyed by character. The hand-rolled \`state.summary\` tail-summary is retired — \`rolling\` is strictly better (bounded, branch-correct, inspectable).

**HUD: values in the tag.** Append a compact state tag to your output (\`[HUD|hp=7|mp=3]\`); a character-scoped display regex renders the panel. Stored text stays compact, the model sees useful state, the user sees chrome. Topic \`regexes\` (HUD recipe).

## Design order

The mechanisms compose; here is the order to assemble them, top to bottom.

1. **Systems first.** Pick the central game systems — combat, equipment, navigation, menuing, raising — and the state machine that holds them, one state per system. \`state\` is all that persists, so its fields are the game's memory; declare them here.
2. **Registries next.** For each system, declare what backs it — locations, enemies, stats, items — as \`registry.new\` declarations. The lib owns validation, clamping, closed lists, ids; the model writes, the handlers read.
3. **Handlers and their outputs.** Wire the per-state command handlers — \`attack\` in combat to the resolver, \`buy\` in the shop to the ledger, \`go north\` in navigation to the map. Each state owns its output shape too: the battle menu, the shop list, the navigation view — the button row the player acts on. Buttons post bare commands (topic \`custom_backends\`); every message ends with its row.
4. **The tools that write the registries.** Declare the mutation tools the model authors through — \`register_enemy\`, \`create_room\`, \`promise\` — with the budgets and closed lists Lua enforces. The model files what it invents; Lua validates and hands back the canonical record.
5. **The model-call hooks.** Place the points where the script must call the delegate — "entering the dungeon but it has zero floors" (commission a floor), "the input matched no command" (escalate or fall through to chat), "the fight ended" (summarize). Each is a sub-gen with its own prompt and toolset, built by hand from \`state\` and the turns — not by filtering the engine's assembled prompt.
6. **The interrupt hooks.** Place the points where the script seizes the turn back from the model — "that last \`adjust_hp\` killed the player," "a due promise hit its anchor this turn." Script-side, deterministic; they fire after the tool loop and override the reply.
7. **The chat overlay.** Wire the event engine for the parts that aren't mechanics — scenes with a cast, run by a delegate until they close. The script owns the tags and the mode; the model never types a bracket.
8. **Regexes last.** Add the display rules for the functional chrome — the HUD panel and the MAP render — plus optionally hiding bare command messages. Last, because those rules depend on tags the script already emits (and nothing else needs any).

Get the spine (1–4) standing first: a player can move through the whole deterministic game with no model in the loop. Then add the delegate (5–7) everywhere the spine can't reach, then dress it (8).

## Hygiene

- Delegate by default (\`backends.generate(prompt)\`) so exported cards work on any install; explicit config ids are local-only.
- Sub-generations don't need the caller's tool schemas or full history: copy the prompt table, replace \`messages\`, set \`tools = nil\` (or your own schemas).
- Keep EVERYTHING the game knows in \`state\` — other globals reset every turn; only \`state\` persists, and only it is branch-aware.
- Failed turns never overwrite the last good state snapshot, so throwing mid-turn is safe; returning garbage successfully is not. Validate before you mutate.
- Dry-run every command path before enabling (\`run {"verb":"test_backend_logic",...}\`, topic \`workbench\`) — the recording delegate rehearses attacks, refusals, and tool loops without a live backend.
- Briefing size discipline: a full state dump is fine at ~6 values. At 15+, send a what-changed-this-turn digest plus only the relevant subsystem in detail — full dumps eat context and dilute the model's attention.
- Dice are Lua's. Rolls happen in \`resolve()\`; their RESULTS are facts issued in the narration request. The narrator must never fudge, invent, or re-roll outcomes in prose — say so in the narrator prompt.
- The player's own inventions count too ("I name my sword Elbereth") — file them through the same tools, or compaction forgets them like any other prose.
- Group chats wrap per speaking character: each script has its own \`state\` and ledger, blind to the others'. Shared game state across characters needs one owning card (or chat-scoped vars read via \`{{getvar}}\`).
- Terminal floors have no stairs down. The deepest floor — where the goal lives — must not offer descent; the win (or death) ends the run, not a stair into nothing. Strip any stairs there (the Guildhall's \`validateGraph\` does, gated on \`isTerminalFloor\`), or the player descends into a floor that doesn't exist and the card soft-locks.
`;
