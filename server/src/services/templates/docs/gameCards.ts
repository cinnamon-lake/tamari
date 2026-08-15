/** Reference doc for the `game_cards` topic, served by the Docs tool. */
export const GAME_CARDS_DOC = `# Game Cards (complex card architecture)

Cards that run a real game — RPG, sim, mystery, raising — instead of just chatting. This is one shape that works; copy what works and grow from there.

The setting: cards are scripted in Lua (wasmoon), the script's entry point is \`generate(prompt, ctx)\`, and the script can call models of its own through \`backends.generate\` (topic \`custom_backends\`). The mechanisms here compose pieces documented elsewhere: the script contract and delegation (topic \`custom_backends\`), display/prompt regexes (topic \`regexes\`).

---

## What are you making?

Before any mechanism: a game card is not a chat card with stats glued on, and it is not a scripted card in the trigger-script sense (regexes on messages, prompt mutation). Here the **script owns the turn outright** — and that phrase has a precise meaning that everything else follows from:

**The script serves every turn it can finish on its own. The delegate is a subcontractor for the turns it can't.**

The model never owns a turn — even when it writes every word of one. In a chat scene the delegate may produce 100% of the prose, but it speaks *at the script's invitation*, inside a scene the script opened and will close, with the menu gated and \`/leave\` a button. There is no mode where "the model writes the responses" is the architecture — that's the absence of one.

What varies between games is only the granularity at which content can be commissioned ahead of the turn that serves it, and therefore how wide the subcontract is:

- **A dungeon crawl commissions at area granularity.** Rooms, encounters, loot, banter — none of it is an *answer* to anything the player might say, so the whole floor can be commissioned from the model in bulk when the player descends, then served deterministically. The delegate is called at content boundaries, for the novel action ("I blow the door off its hinges"), the summary, the occasional boss phase. Dozens of turns can pass with zero model involvement.
- **A social sim commissions at turn granularity.** The receptionist's reply is an answer to the exact words the player just typed — it cannot be commissioned at any boundary, because the input it responds to doesn't exist yet at any boundary. But the script still owns the turn: the menu is gated while a scene is open, \`/leave\` is a button, opening and closing scenes is scripted, who is on stage rides state.
- **A raising sim sits between.** The days, the schedule, the festival deadline, the route gates — commissionable in advance, scripted, deterministic. The princess's dialogue — subcontracted, scene by scene.

The subcontracted work always falls into the same four buckets, and this doc has a mechanism for each: **novel actions** (escalation to a DM with the mutation toolset), **scenes** (the event engine), **summaries** (the gist engine), **judgment** (\`response_format\` evaluations). If a turn doesn't need any of the four, the model is not called.

One consequence worth stating bluntly: a dialogue-first experience with no deterministic mechanics underneath is not a thin game card — it isn't a game card at all. If the model is writing every reply and the script has no floor under the turn, what you actually want is the *memory infrastructure* (per-character dossiers, rolling summaries, the commitment ledger), and that can be vendored onto a chat card without any of the rest.

### Games this architecture serves well

- **Crawls, survival, exploration** — the canonical case. Most content commissionable at area granularity; the magic is in the escalation ("wait, I can just blow the door up?" — which lands *because* the last 30 doors didn't blow up).
- **Economy / shop / crafting sims** — menus, prices, stock, and schedules are all serve-land; the shopkeeper's patter is subcontracted, her *memory of you stiffing her* is a dossier.
- **Mysteries** — the case state (clues found, accusations unlocked, alibis broken) is scripted and exact; interrogations are scenes; "did the persuasion land?" is a judgment sub-gen.
- **Raising sims** — the calendar is the game; the princess snapping because you've *made her study* 24/7 for two weeks straight is the emergent payoff the scripted calendar makes possible.

### What NOT to build with this machinery

- **An actual dungeon master.** A plain chat card plus a display-regex HUD (topic \`regexes\`), \`run_lua\`/dice tools, and the memory features covers it. This machinery is for games that run themselves *between* model calls.
- **A stat-tracker chat card, or a dialogue-first character card.** If the model can just carry the numbers and nobody can really lose, you don't need any of this — the doc's whole reason to exist is that "the model pretends" is both ruinously expensive and rigged. And per the previous section: no deterministic floor under the turn means what you want is dossiers/summaries/ledger, vendored standalone — not a state machine.
- **A lorebook card.** If what you want is world facts injected on keywords, that's a lorebook, not a game (see "Card fields" in Supporting patterns for the game-card equivalent).

### Vocabulary (used throughout)

| Term | Meaning |
|---|---|
| delegate | the model the script calls; the script is in front of it |
| sub-gen | one delegate call the script commissions: its own composed prompt + toolset, run inside a turn |
| serve-land | deterministic script territory: buttons post bare commands, Lua answers, no model |
| escalation | novel input the cache/state machine can't parse → delegate adjudicates |
| DM | the escalation delegate: adjudicates attempts, frames scenes |
| scene-runner | the delegate that runs an open event: writes every participant, every turn |
| boundary turn | a turn where the script commissions new content (a pack, an event opening) |
| pack | a bulk-generated area of content (rooms, encounters, flavor), stored as a blob |
| pack pointer | the id under which a pack blob is stored, held in \`state\` per area |
| event | an open chat scene with a cast; a mode, one at a time |
| span | an event's conversation record: a persistent array of prompt messages in the store |
| briefing | the state digest the script composes into a sub-gen's system block |
| gist / take | neutral one-line record of an event / what ONE character carries away |
| dossier | a character's takes, filed by id — memory keyed by who was there |
| ledger | compaction-proof commitments the model made about the future |
| memoir line | a plain-prose summary line in the visible reply, for the player |
| zoom chain | recursive inspect-by-id from digest to sub-summaries to raw log |
| kv / channel | a \`lib/rolling\` memory object: verbatim facts by key (kv) + a folding log (the compacting half) |
| HUD | the compact state tag (\`[HUD|hp=7|...]\`) a display regex renders as a panel |

### Routing: which sections do I need?

- Building a **crawl / survival / exploration** card → Core model, The content factory, The hard case (enemies), Compaction.
- Building a **mystery / raising / economy** card → Core model, The event engine, Judgment as data, The ledger.
- Building **anything with recurring characters** → The event engine (dossiers), regardless of genre.
- Wanting **memory infrastructure for a chat card** → The event engine (dossiers), Compaction, The ledger — skip the factory.
- **Just evaluating an idea** → this section, Why script, and the Design order at the end.

---

## Why script

A model can track a stat block and run arithmetic through a calculator tool on its own. That is not the point, and it barely needs scripting.

The point is authentic game-like experiences where the player can simply *lose*. A model could, for five hundred turns, use tools to pretend to be an RPG — but it would be ruinously expensive and it would feel rigged, because it would be. Scripting puts real rules and real state behind the fiction so the loss is real and the win is earned.

And the other half: don't pre-script everything. Rolling stats, raising numbers, putting it all on red — that's fun. But so is "I blow the door off its hinges instead of looking for a key," or the princess finally snapping because you've *made her study* 24/7 for two weeks straight. The intended experience is both — the scripted game and the open conversation, integrated.

---

## The core model

### The programming model

The script sits in front of the delegate model and owns the turn. It decides when to call the model, how to call it, and what to do with the answer. "Middleware" undersells it: this is not "edit the prompt a bit, call once, edit the output a bit." Beyond a simple card, the script owns state and the loop outright.

If the user issues an \`attack\` command mid-combat, the script may resolve it without calling the model. If the script tries to spawn an enemy and its taunt fails validation, the script loops back with the error and the model fixes it. When a fight ends, the script may commission a two-line summary of how it went. If the user types something the script can't parse, it falls through to a chat turn.

**Build the delegate's prompt; don't filter the system's.** The prompt the model receives is something you *compose* — from \`state\` and from the chat history you parse yourself — not the engine's assembled prompt with bits whitelisted or blacklisted out. The simplest cards can get away with the strip-and-forward habit (emit a \`[sys]\` block, then gsub it back out of the delegated prompt); the moment a card does anything stateful you outgrow that and compose the delegate's \`messages\` yourself, at which point there is nothing to strip. Build-don't-filter is the line you cross, and most of the rest follows from it.

What that looks like in practice — an escalation sub-gen, prompt composed from scratch:

\`\`\`lua
-- the player typed something the state machine can't parse
local sub = {
  system = table.concat({
    "You are the dungeon master of a run in The Sunken Guildhall.",
    "The player attempts an action the rules do not cover. Adjudicate it,",
    "perform the world changes through tools, then narrate the outcome in",
    "2-4 sentences. Lua enforces the invariants; you decide what the fiction allows.",
    "",
    "STATE BRIEFING:",
    "Floor 2 (The Flooded Library). Player HP 7/12, inventory: bomb, rope.",
    "Exits: south (stairs up). Interactables: iron door (locked, rusted).",
    "STORY SO FAR:",
    "#12 Cleared the flooded library; Mira lost her locket.",
    "#11 Bribed the ferryman with the last of the salt pork.",
  }, "\\n"),
  messages = {
    { role = "user",      text = "I poke the rusted door" },
    { role = "assistant", text = "It doesn't budge. The rust flakes, but the frame holds." },
    { role = "user",      text = "fine. I wedge the bomb into the hinge gap and run" },
  },
  tools = escalationTools:schemas(),  -- remove_item, add_exit, make_noise, adjust_hp, ...
}
local res = backends.generate(sub):await()
res = loop.run(sub, res, escalationTools:exec())
\`\`\`

Nothing in that prompt came from the engine. The history slice, the briefing, the toolset — all chosen by the card for this one job. A different sub-gen (gist, judgment, scene) gets a different composition. That is the whole meaning of build-don't-filter.

The same applies on the way out: the delegate's text is raw material, not the reply. Commission a floor design and the model files the rooms through tools, then signs off with "Done — let me know if you need anything else"; that prose goes in the bin, the rooms are filed, and what the user sees next is whatever the script builds. The model's prose becomes the user-facing reply only when the script forwards it — a narration the script commissioned, a chat scene it opened. You build the output from what you want the user to see, the same way you build the prompt from what you want the model to see.

### State

The script declares what state the game has — the fields on \`state\`, the registries, the ledger — and \`state\` is the only thing that persists between turns. It is branch-aware: restored per branch before \`generate()\` and captured after a successful turn, so swipes and regenerations see the right world. Failed turns never overwrite the last good snapshot.

The model changes state only through tools, and Lua validates every mutation on entry — clamping to the budget, filtering tags against the closed list the engine implements, assigning an id, handing back the canonical record of what was filed.

### The tool loop

Every model call is the same shape. The script builds a prompt — a system briefing, the turns it wants the model to see, a toolset — calls the delegate, and runs the loop: the model writes prose and calls tools, Lua executes each tool and feeds the result back, and the model continues until it's done. Narrating a turn, fixing a validation error, summarizing a fight, judging whether a persuasion landed — same loop, different prompt and toolset. Tools are the channel for everything: the model files what it authors and queries what it needs.

For a novel action — something the deterministic state machine has no rule for — the delegate is the game master. The player blows up the door with a bomb, and the delegate decides that works and performs it through tool calls: \`remove_item("bomb")\`, \`add_exit("north", via = "destroyed door")\`, maybe \`make_noise(3)\` to rouse the floor. Lua runs those calls and holds the invariants: you can't spend a bomb you don't have, HP doesn't go below zero. That is all Lua does with a mutation. It does not decide what the action costs — it can't; there is no rule table that knows what "I blow up the door with a bomb" means, and writing one means enumerating every action a player could invent.

So you trust the delegate to game-master the novel slice, and there is no *adjudication* safety net. The invariant checks keep the numbers possible; they do not catch a delegate that blows every door for free, and nothing does. Trying to build that catch — Lua pricing each action, or gating tools behind game state ("no damage outside combat") — is the same trap either way: enumerate every case, write a trillion lines, and foreclose the emergent play (the princess snapping, the bar fight, tripping at the guild hall) that is the entire reason to script. Trust the delegate's judgment, keep the invariants, stop there. If the model writes prose where it should have called a tool — the spawn failed, the taunt didn't validate — the next loop round carries the error and tells it to try again.

### The state machine, and chat for the parts that aren't

Most of any game-shaped script is a state machine — combat, shop, navigation, idle, menu. Each is a place where the script serves deterministic responses to known input: buttons post bare commands, Lua answers, no model involved — until the player does something unscripted, which escalates to a delegate.

Chat is the state for the parts that aren't mechanics: actual conversation. The entry is the script failing to parse the input as a command, so it builds a prompt — some context (probably the summary of the last delve), the recent turns, the user's text as a plain \`{"role":"user"}\` — and forwards the model's reply. Within a chat scene the prompt is append-only — turn N is a strict prefix of turn N+1 — so the delegate's prefix cache hits and a per-turn call stays cheap (the span mechanics live in the event-engine section below).

A scene closes in one of two ways, and both run through the model, because closing needs a gist and takes that only the model can write: the scene-runner can end the scene itself with a \`close_event\` tool call when the conversation reaches its natural end, or the player hits \`/leave\` — a serve-land button that never depends on the delegate's mood — and the script runs one cheap finalize gen over the chat to produce the close. The full mechanics are in the event-engine section.

Tool calls are the glue between the state the script owns and the prose the model writes. A princess mentions a new donut shop in conversation, files it mid-chat with the shop tool, and next time the player opens the shop menu it's there — because the model was given the shop tools and chose to use them. An ex-party-member turned enemy reads the character registry, then stabs you and drops your HP by 10. The script doesn't predict these moments; it hands the model the tools and lets them happen.

### Turn-flow skeleton

Every game card runs this spine. Cards with commissionable content put a cache lookup where the delegate call would be, and escalate on a miss; cards without it reach the delegate call more often. The shape is the same (illustrative pseudocode — the names are yours to pick):

\`\`\`lua
function generate(prompt, ctx)
  ensureState()               -- idempotent defaults; state arrives restored for this branch
  local input = lastUserText(prompt)   -- scan prompt.messages backwards for role == "user"

  local cmd = parseCommand(input)      -- typed or button-posted; see below
  if cmd then return handleCommand(cmd) end

  local outcome = resolveRules(input)  -- pure Lua: dice, costs, cooldowns — NO model involved
  local sub = buildDelegatePrompt(prompt, outcome) -- composed history slice + state briefing + sub.tools
  local res = backends.generate(sub):await()
  res = runToolLoop(sub, res)          -- file writes, answer reads, re-call
  return finalize(res.text, outcome)   -- apply deltas, append HUD tag, return
end
\`\`\`

**Generation types: only two stances.** Regenerates and swipes need NO special handling — run them exactly like a first gen. The backend restores \`state\` to before the turn, so as long as every side effect lives in \`state\`, re-running the whole pipeline (dice included — re-rolling keeps swipes interesting) is correct by construction. Don't cache outcomes for "regenerate stability"; the rollback would undo your cache anyway.

Continues and impersonates: **throw**. Throw before even calling \`ensureState\` — it's fine. A continue asks the script to resume mid-output, but the script emits each turn whole (there's no token streaming to resume), and the few cases where a continue could almost make sense don't justify the machinery. An impersonate asks the script to speak as the player, and making that coherent with card state takes per-card machinery far out of proportion to its value. One early guard covers both:

\`\`\`lua
if ctx.generationType ~= "send" and ctx.generationType ~= "regenerate" then
  error("This card does not support " .. tostring(ctx.generationType) .. ".")
end
\`\`\`

**Failure UX: fail loudly, then brick the branch.** When a delegate errors mid-turn (a wedge, a validation deadlock, a transport failure), the card catches it — a \`pcall\` around the real generate body — marks the branch bricked, and RETURNS the failure text as the turn's reply: the player sees the real error, and nothing half-applied persists. One mechanical subtlety dictates the shape: the brick flag must survive the turn, so the card cannot simply throw — a thrown turn rolls \`state\` back, brick flag included. Catching the error and returning it as a mechanically successful turn is what lets the flag persist (a flag the card sets and checks at entry): subsequent turns on that branch refuse with a clear message instead of limping on — a card that just retries invites the player to force the chat forward around a failure, compounding it. The supported recovery is swiping to a sibling branch or rewinding past the failed turn — the same mechanics the player already uses, which is why the regenerate path above must be exactly the normal path.

(The one thing that still needs a hard guard on every path: one-shot side effects that escape \`state\`, like a submitted form firing a real action. Those aren't regenerate-safe no matter what — guard them explicitly.)

---

## Where the script/delegate boundary sits

The one design question that shapes everything downstream: **at what granularity can content be commissioned ahead of the turn that serves it?**

Not "how often should the model speak" — that's a consequence, not a choice. And not "how much can be pre-authored" — packs aren't written in advance, they're generated *during* play, at boundaries. The real axis is dependency on the player's next input. A floor's rooms, encounters, and patter are not answers to anything the player will say, so the whole floor can be commissioned the moment the player descends and served turn by turn, valid no matter what they do next. The receptionist's reply *is* an answer — it depends on the exact words just typed, so it can't be commissioned until the turn itself. A crawl commissions at area granularity, a raising sim at scene granularity, a social sim at turn granularity — same architecture, different boundary positions: the script serves what it can and subcontracts the rest.

This also explains the pack-sizing advice before it's given: commission at the coarsest granularity whose content doesn't depend on future input.

The two sections below are the two big subcontracting patterns. Most real cards want both: pre-authored packs for the world, live scenes for the people in it.

### The content factory (model as author, not narrator)

Factory for the anticipated, DM on escalation — ONE tool economy drives both.

**Bulk generation at boundaries.** When the player enters a room/floor/area (or when it's generated), run ONE planning-mode sub-gen where the model builds the whole content pack through tool calls: \`create_room\`, \`add_interactable("box", { responses = {...} })\`, \`spawn_encounter({...})\`, \`add_ambient_lines({...})\`. (Yes, a dedicated planning gen — mid-narration invention is a tool call in the same turn that produces the prose, no planning mode; boundary generation is its own call by design. A write is a write, whenever it happens.)

Tools, not one json_schema blob: a blob is one-shot, but tool calls let the model think in increments — revise and extend in-fiction ("the stairs are open, so \`spawn_enemy(trog, location = "upper")\` — they're climbing up"). Every mutation tool takes a \`reason\` field; reasons flow into the briefing, so "why are there trogs on floor 2?" has a canonical answer forever.

Lua validates on entry (budgets, closed lists — the \`register_enemy\` clamps) and stores the pack keyed by area id. Size the boundary generously: a pack should hold a whole explorable AREA — a graph of rooms with branches and dead ends, its random-encounter roster, its interactables — not a single room. One-room packs degenerate into room → fight → room: per-room model calls with extra steps. Pre-write the flavor packs too: boss banter, shopkeeper patter, death quips, deflections — ~10 lines each, cycled deterministically.

**Serve deterministically.** Input matches against the room's interaction table (keyword/verb sets — parser-game style); canned lines come back with ZERO model involvement; ambient lines rotate by turn counter. Cached turns are a pure function of \`state\` and never touch the delegate, so there's nothing to re-roll and nothing to destabilize.

**Escalation is the product, not the failure mode.** Cached content exists to make the 10% magical — "wait, I can just blow the door up?" only lands because the last 30 doors didn't blow up. Novel input escalates to the delegate with the FULL mutation toolset: the model interprets the attempt and resolves it through tools (\`remove_item("bomb")\`, \`add_exit("north", via = "destroyed door")\`), then narrates the result. Keep a miss counter: a high escalation rate means the packs are thin, not that the player is brilliant.

**Storage: registries are pack-aware; the card never touches blobs.** A pack is ONE store blob holding the content of an area — entries and mutations for ALL the card's registries together — and \`state\` carries only the branch-aware pointer table (\`state.packIds\` maps each area id to its pack blob). The registry layer does the rest transparently (see \`lib/registry\`): each registry declares how a record maps to its partition (\`partition_by\`), READS lazy-load the relevant packs through the pointer table and resolve base-plus-mutations, and WRITES update the in-memory view and queue a mutation record against the derived partition. The card calls \`registry.flush()\` once at the end of \`generate()\`: flush applies the queued mutations, one new \`store.put\` per touched pack, and moves each touched pointer. Reads resolve through the queue either way, so a forgotten flush is a state-size issue, never a correctness one.

This solves the blob-vs-pointer problem by construction: packs run 2-5KB and \`state\` snapshots persist per message, so a dozen packs inline in \`state\` would duplicate 50KB of JSON into every assistant message; with pointers-only in \`state\`, a mutation is a NEW put plus a pointer move, so old branches keep their version, swipe correctness falls out for free, and a swiped-away branch's blobs are simply unreferenced. (Garbage collection is a later problem; the shape of the solution is marking each blob with the message that generated it. Note that deleting messages mid-run in a scripted chat breaks far more than blobs — it's out of scope by design.)

Escalation writes ride the same path — when the delegate blows the door off its hinges, that \`add_exit\` lands in the area's pack as a queued mutation, so the destroyed door persists, branch-correctly, for the rest of the run.

The boundary gen itself is invisible to the player. Don't announce it — no "Designed The Upper Halls: …" memoir line, no behind-the-scenes narration. The player was never supposed to know when the model was called; a pack that materialized between turns should feel like a floor that was always there. If the boundary gen happens on the same turn the player enters the area, the turn's reply is simply the entrance narration; the planning work stays backstage.

A complete, tested card — this factory half and the event engine below together — lives in topic \`game_cards_example\` (The Guildhall): floor-graph planning, roster-based random encounters, serving, escalation, and pack versioning, all proven through the real adapter.

### The event engine (social play as modes)

The factory card's escalate path generalizes into a second shape of subcontract: the EVENT. The player idles at a deterministic menu (delve, shop, smith — serve-land buttons); free text escalates to a DM; and when the action opens a scene, the card switches modes — a conversation with a cast, run by a delegate, until it closes. Inside the scene the delegate writes every reply, but the script's floor never disappears: the menu is gated, \`/leave\` is a button, the open and close are scripted. The machinery ships as \`lib/events\` (The game lib): the card declares its character fields and keeps only its menus, prompts, and economy. The merged card (topic \`game_cards_example\`, The Guildhall) exercises the event engine end-to-end; this is the theory.

**Events are modes.** Like combat in the factory card: while \`state.event\` lives, the menu is gated ("finish your business here first"), free text goes to the scene-runner, and the button row matches. ONE open event at a time — no nesting, no suspension; a second \`open_event\` while one is open fails as a nonsense call (see below), so cards route a still-open event's turns through the scene-runner, never back to the DM. The Guildhall enforces this with \`ev.isOpen()\` before the mode turn. Mode lives in \`state\`, never in the log — the engine emits no markup; a greeting's defaults are \`ensureState\` DEFAULTS, not something to parse back.

**Two delegate roles, one toolset.** Split the boundary turn's work by prompt SHAPE, not by tool access. The DM (idle escalation) adjudicates the attempt and FRAMES the event: \`open_event({ kind, context })\` — who the player is and what they're after, NO character list; casting is not the DM's job. Both roles get the same full toolset; tools that make no sense in the current mode (\`close_event\` in the DM's hands, a second \`open_event\` mid-scene) simply fail with an error result, and the tool loop carries the error back like any other. Uniform toolsets keep the code honest — mode enforcement is a runtime concern, not a schema-shaping one.

Summarize the situation that opened the scene INTO that context before the mode flips — what just happened AND the relationship state (first meeting or known) — because the scene-runner's briefing is set when the event opens and nothing can be spliced into it later. The open context is its picture of how we got here; the public record (STORY SO FAR in its briefing, \`inspect_summary\` in its toolset) and the dossiers are how it checks that picture.

**The same-turn handoff is a dispatch loop, not a goto.** The DM framing and the scene-runner's first reply happen in one player turn, and the mechanism is mundane: \`generate()\` doesn't have to call the delegate at most once. Loop over phases, and let a tool call enqueue the next phase:

\`\`\`lua
while phase do
  if phase == "dm" then
    local res = loop.run(dmSub, backends.generate(dmSub):await(), tools:exec())
    phase = ev.isOpen() and "scene" or nil   -- open_event fired: continue as scene
    reply = res.text                          -- DM framing, kept as fallback
  elseif phase == "scene" then
    if not ev.hasSpan() then  -- the span starts THIS turn; node zero IS the briefing
      ev.spanStart({ { role = "system", content = sceneBriefing } })
    end
    ev.spanAppend({ { role = "user", content = input } })
    local res = loop.run(sceneSub, backends.generate(sceneSub):await(), tools:exec())
    reply = res.text                          -- the scene's opening line wins
    phase = nil
  end
end
\`\`\`

Three invariants make this coherent:

1. **\`open_event\` returns immediately.** The DM frames, files, and stops talking. Its prose is discarded unless the scene gen errors (then it's the fallback reply).
2. **The scene-runner is called fresh**, with its own composed prompt whose event context is exactly what \`open_event\` filed. From its perspective the scene simply *is* open; it never knows the DM existed.
3. **The boundary turn pays double.** Two delegate calls in one turn is the price of the split — budget for it. The append-only span (below) is what makes turns 2..N cheap; turn 1 is the expensive one.

The scene-runner owns the event until it closes. It writes EVERY participant at once (per-character sub-gens are a cost trap), so it always sees the entire current chat — never filter the live scene per character. It casts from the registry: \`list_characters\` before inventing anyone, \`get_character\` for a file, \`register_character\` to file someone new, \`add_to_chat\` to bring them on stage.

**Script-opened events compose their context from \`state\`.** A card may open an event without a DM (the Guildhall's onboarding) — but then nobody frames the scene, so the context must be BUILT from state: who the player is, what just happened, whether the cast has met them. A hardcoded context is safe only when there is no history to contradict (virgin state, a first turn); once the game has a past, a canned context — or a scripted opener that presumes one ("welcome back, how was the dungeon?") — asserts it blindly, and the scene-runner will believe the script's premise over the record. The Guildhall script-opens exactly one event for exactly that reason.

**The span: the event's prompt IS the record.** A chat event delegates every turn, so make those calls CHEAP — and don't trust anything to stay immutable to do it. The event's span is a persistent array in the store (topic \`custom_backends\`, the \`store.append\`/\`store.readArray\` primitives), \`state.event.spanId\` pointing at its head, holding the event's ENTIRE prompt: the system briefing (instructions + event context + STORY SO FAR) as node zero, then one node per turn. Each generate rebuilds the scene-runner's prompt by reading the span and appending — there is no separately-maintained "frozen block" to fall out of sync with reality.

Two consequences. First, the tail is FULL-FIDELITY — the user inputs, the assistant text, AND the tool_use/tool_result rounds — because replayed tool results are what stops the model re-issuing the same reads every turn (extra rounds AND a cache miss over the volatile part). Second, mid-scene changes stop being correctness hazards: if the briefing must change (a story entry files mid-event, a character definition updates), the next node simply carries the new text, and the prefix cache degrades from a full hit to a partial one — slower, never wrong. Append-only within the event remains the norm, so the cache hits almost always; the point is that the design no longer *depends* on the briefing never changing.

Volatile state still rides in the newest message, never deep in the span; anything that would otherwise mutate early nodes — character defs, dossiers — arrives as READ-tool results in the tail instead. Branch correctness comes free (an old branch's \`spanId\` still points at its own head), and history budgets are irrelevant — the span never touches the log. The Guildhall's test asserts the strict prefix across turns AND that turn 2's tail carries turn 1's tool blocks.

**Dossiers: memory keyed by WHO was there.** An event closes into two channels. The gist is NEUTRAL — one line for the record (the story entry and the memoir line consume it). Each participant gets a TAKE — what THAT character carries away, facts plus impression — filed in \`state.dossiers[charId]\` by \`close_event({ gist, takes })\`. Knowledge asymmetry becomes structural: no take filed, no knowledge — the eavesdropper's take differs from the host's, and the absent have none.

An EMPTY dossier must read as never-met, not as missing data — say so outright in the scene-runner prompt, because a gap in the record loses to a strong prior: the model fills silence with assumption, and canon-heavy casts come with the loudest assumptions. Validate take keys against the participant list and drop strangers canonically. \`{{user}}\` gets no take; the player remembers their own business.

When a character reappears, \`get_character\` serves their dossier as a read-tool result — recent few in full, and when the backlog outgrows the window, one cheap sub-gen FOLDS the oldest takes into a running digest. Dossiers are \`lib/rolling\` channels (\`state.dossiers[charId]\` — takes are gist-only entries pushed to the log half; the character's kv facts live in their registry record, not here): the fold entry's content is the descriptor list of what it compressed, so the zoom chain works here too. The fold runs on READ, so one-off NPCs never cost a token; a delegate error fails the turn loudly (see Failure UX — recovery is a swipe, and ids move only once the fold entry is filed, so the retry sees memory intact).

The fold's sub-gen needs the turn's prompt: the card calls \`ev.bindPrompt(prompt)\` once per generate to arm it. If a fold is due but the current turn never binds, it simply fires on the next bound generate instead — takes accumulate in the meantime. But a card that NEVER binds has a silent unbounded-growth bug, and "dormant" behavior will hide it; bind on every generate, no exceptions.

**The exit is a button; the close is one gen.** \`/leave\` is a serve-land button — the player is never trapped in a chatty delegate's scene. Closing needs a gist and takes, which only the model can write, so the exit runs ONE cheap finalize gen over the chat for \`close_event\`. (The scene-runner may also close the event itself mid-flow with the same tool when the scene reaches a natural end — same close path, no button.) A delegate ERROR on the close fails the turn per Failure UX: the branch bricks, the event stays open, and recovery is a swipe or rewind past the failure. If the model just spends its rounds without closing (a content outcome, not an error), the event still closes with a script-composed fallback gist.

**No structural tags; cast is state.** The event engine emits NO markup — the close's memoir is a plain line of prose, and who is on stage is not a tag either: it rides the newest user message as a parenthetical cast note, built from \`state.event.participants\` (\`ev.castLine()\`), so the model sees something like:

\`\`\`
{fighting intensifies}
(In the scene with you: Mira, the receptionist)
\`\`\`

Volatile state in the newest message, never deep in the span. The model never types a bracket; \`ev.strip\` — applied to delegate text before it's served — removes freelanced tags as pure defense.

---

## Shared mechanisms

The remaining machinery applies at any boundary position. These are derivations of the core model, not additional principles.

### The two memory kinds: compacting vs non-compacting

Every fact a card carries is one of two kinds, at one of two scopes — and the kind decides the tool shape.

**Compacting information** is the firehose: scene replies, fight logs, event takes, story beats. It is APPEND-ONLY and gets folded into digests as it outgrows the window. Old entries are never edited, only compressed, and the zoom chain recovers detail when the digest isn't enough. Tool shape: \`push\`.

**Non-compacting information** is what paraphrase would destroy: a character's appearance, their personality summary, the promises in the ledger, world-building facts. It is never summarized — it must survive verbatim — so instead of growing it gets OVERWRITTEN. Tool shape: \`set\`, keyed by id. The model updates a record by setting its fields, not by appending a newer statement; the latest value is canon. This matters more than it looks: with append semantics, "hair: black" and "hair: white" both live in the record and the model picks one at random per prompt — a set makes the update canonical and the contradiction impossible.

The four cells:

| | **Compacting (push, folds)** | **Non-compacting (set, overwrites)** |
|---|---|---|
| **Per character** | dossiers (takes, folded on read) | the character record: appearance, personality summary, status |
| **Global** | the story channel (STORY SO FAR) | the ledger (promises), world-building facts |

Mechanically, both kinds live in ONE structure: a \`lib/rolling\` channel is a single object in \`state\` carrying a kv map (the non-compacting half, overwritten verbatim) alongside the id array (the compacting half, folded into store blobs), and its briefing renders the kv facts verbatim first, then the folded gist lines. The story channel uses both halves (world facts in kv, story beats in the log); a dossier leans on the log while the character's registry record holds their kv. The ledger keeps its own module — due-ness machinery on top of what is conceptually a kv map. The kv half is exposed to the model freestyle — \`list_facts\` / \`get_fact\` / \`set_fact\`, keys invented as the fiction demands (see \`lib/rolling\`); registries remain the schema'd alternative when fields are known and worth validating. Sections below slot in: summaries and compaction are the log half; the kv half, registries-with-updates, and the ledger are the non-compacting half.

### Summaries do two jobs

Summaries keep the context clean — the mechanical turns collapse into one line, so history outgrows the window gracefully.

But the second job is the interesting one: a summary is a surface for the model to *react* to the mechanics. The fifth goblin flees in round one — maybe the rogue says "they're running because you stink." The model reads the fight transcript and notices, on its own, that the player ate fifteen cheese wheels while getting bullied by the boss. You could hand-code a hook for each such moment; you'll never think of all of them. A summary over the right span gives the model a chance to notice what it was never explicitly told.

### The hard case: model-designed enemies

The one place model creativity has stat-shaped consequences. The model is great at CONCEPTS ("a glass knight that reflects spells") and terrible at balance — so **Lua owns the power budget, the model owns the concept**.

State the current tier/budget in the briefing or the tool description; the model calls \`register_enemy\` with its concept and allocation; Lua clamps. Calibration: strict budgets for bosses, free-form-with-clamps for grunts. And the key trick: **ability tags come from a closed list the combat engine implements** — \`reflect_magic\` has real mechanics; the free-text flavor around it is free. Bosses are the same shape one level up: the model designs phase BEATS ("at 50% he shatters the floor"), Lua owns the trigger logic, the transition narration is a flavor sub-gen.

### Judgment as data: \`response_format\`

The minority case where structured output beats tool calls: you need the model's EVALUATION, not invention — did the persuasion land? how bad is that wound? Run a dedicated sub-generation whose whole answer IS the data: \`response_format = { type = "json_schema", schema = ... }\`, consume with \`json.parse_result\`, pattern-match \`.error\`, keep a sane default. Cheap models are fine for evaluation; save the good model for prose.

### The ledger: long-term planning

The model will make commitments about the future — a rule it just invented ("Mira's affection caps at 40 until the festival"), or work it explicitly defers ("the brother's design — I'll finalize it when I lay out floor X"). PROSE CANNOT CARRY THESE: rolling summaries paraphrase foreshadowing away ("cap 40 until the festival" survives one compaction pass as "she was distant"). The ledger is the global NON-COMPACTING channel for intent (see The two memory kinds): same shape as any registry — filed through a tool, validated, canonical — but what's registered is INTENT, not entities, and records are keyed by id with set semantics: \`promise({ id, ... })\` sets, \`resolve_promise\` overwrites the status.

- **One tool: \`promise({ id, what, due })\`** (plus \`resolve_promise\`). Filed mid-narration like any registry call. The critical validation: \`due\` must be a CONCRETE anchor — floor 12, week 20, an event id, a stat threshold. Reject "later" at registration; a vague due date is a promise that never comes due. (The lib clamps a filed \`due\` to now+1 … now+50 — measured in the card's own clock units: turns, floors, weeks, whatever \`ledger.bind\` reports as "now" — never this turn, never past the horizon.)
- **Two enforcement tiers.** The lib ships the narrative tier — \`promise\`/\`resolve_promise\` file intent and \`briefing\` reminds. The executable tier (a tiny vocabulary Lua reads directly, like \`cap = { who = "mira", max = 40, until = "mira_festival" }\` enforced by your own clamp, mechanically true the same turn) is card-side: a few lines against the filed records, not a lib DSL — keep it tiny, three primitives cover almost everything. Everything else is narrative-only — you can't enforce "design the brother well," but you can remind.
- **The briefing is the memory.** The pending ledger rides in every briefing; Lua computes due-ness (it knows floors, dates, stats) and escalates — \`DUE NOW: the brother — design him this turn\`. Escalation is what makes "I'll finalize later" reliable instead of a prayer.
- **Lifecycle includes failure.** pending → kept / failed. Failure is canon: miss the festival and her route closes — now a mechanical fact Lua enforces from then on.
- **Swipes come free.** A promise filed in a swiped-away turn vanishes with the branch — different swipe, different future. Once persisted, the ledger is canon; tell the narrator so ("never contradict the ledger").
- Optionally auto-file a stub when a due promise is ignored (a placeholder brother design) so a due floor never ships empty. Insist-in-prose first; add stubs when a card proves it needs them.

This is what turns the delegate from a turn-writer into a SHOWRUNNER: it plants in act 1 and trusts the payoff in act 3, because the reminding is structural, not contextual. The Guildhall (topic \`game_cards_example\`) carries a turn-anchored version in its planning and escalation sub-gens.

### Compaction: the memoir and the zoom chain

History is what outgrows the context window first, and the answer has two halves that never meet. For the PLAYER, the boundary turn serves the gist as a PLAIN LINE of prose — "Cleared the flooded library; Mira lost her locket." — a memoir line like any other narration. No tags, no display rules: nothing is emitted just to be regexed away. For the MODEL, memory is the rolling story channel (The game lib): the same gist, filed mechanically with the span it covers as zoomable content, briefed as \`STORY SO FAR\`, inspectable by id. No delegate ever reads raw history, so there is nothing left to collapse FOR one. (Functional chrome is the exception to "no tags": the \`[HUD|…]\` and \`[MAP|…]\` tags are compact DATA a display rule renders as a panel or map — a real feature, topic \`regexes\`.)

**Who writes the summary:** the model, on the closing turn — \`lib/summarize\`'s gist sub-gen over the span the card tracked mechanically (the fight log in \`state\`). The script owns the discipline (one line, no double quotes), the model owns the content. A nil means there was nothing to summarize (no span, empty answer) — the card serves its fallback line; a delegate ERROR follows Failure UX (branch bricks; a swipe or rewind retries).

- **Gist vs exact.** A summary is a paraphrase. Gist lives in story entries and memoir lines, mechanics in \`state\`, commitments in the ledger — a fact that must stay exact may never travel ONLY in a summary.

**The zoom chain is the antidote.** Once the delegate's view is compressed, give it a way back to the record — recursively, not with a text search. The fight log and the event span are filed as rolling entry CONTENT (mechanical, branch-aware — never re-parsed), and \`inspect_summary({ id })\` (lib/rolling) opens any summary by id: a fold entry lists the summaries inside it, each with its own id, down to the raw blows and scene replies. The model tool-calls its way from the digest to the exact exchange it half-remembers. One honest bound: summaries and spans are text, not truth — how the goblin encounter WENT is in the story, the goblin's HP is in \`state\`. Exact facts still belong to registry/ledger.

Four channels, four fidelity levels: \`state\` for mechanics, the ledger for commitments, story entries for gist, the store for verbatim-on-demand (rolling content, spans, packs — ids in \`state\`, blobs in the store).

---

## The game lib (vendored modules)

The reusable 90% of this architecture — the parts every game card re-derives, some of them genuinely tricky (the persistent-array span, the js_null footgun: \`json.decode\` returns a sentinel object for JSON null, not Lua nil, so naive field checks lie) — ships as eleven small Lua modules. Get them into a card with one call — \`run {"verb":"add_game_lib","args":{"characterId":"…"}}\` vendors all eleven as \`backend_logic/lib/*.lua\` (overwriting \`lib/\` keys only; topic \`workbench\`) — then \`require("lib/<name>")\`. The full sources are at the end of topic \`game_cards_example\`; the Guildhall is the single worked example. Vendored, not engine-provided: the card owns its copies, so exports work on any install and behavior is pinned per card.

(The memory subset — \`rolling\`, \`summarize\`, \`ledger\`, the dossier half of \`events\` — is also the answer for a chat card that wants per-character memory without the game machinery; see "What NOT to build.")

**The contract** — every tool-providing module composes the same way (plain dot calls; the rest — \`loop\`, \`sanitize\`, \`chrome\`, \`summarize\`, \`maptag\` — are plain utilities):

\`\`\`lua
M.tools() -> array            -- tool schemas (may be {})
M.exec(name, args) -> string | nil   -- nil = "not mine", try the next module
\`\`\`

\`\`\`lua
local ts = toolset.new()
ts:use(ledger)               -- any module with tools()/exec()
ts:use(enemies)              -- a registry instance (same contract)
ts:handle("attempt", function(args) ... end, ATTEMPT_SCHEMA) -- ad-hoc tools
sub.tools = ts:schemas()
res = loop.run(sub, res, ts:exec())  -- first non-nil answer wins; ends "unknown tool: X"
\`\`\`

### The two big modules: \`rolling\` and \`registry\`

Most modules are small utilities (index below). Two carry real theory and get their own treatment.

#### \`rolling\` — one channel, both memory kinds

A channel is a single object the card owns in \`state\` — \`rolling.channel()\` returns \`{ kv = {}, ids = {} }\` — and the same shape serves the story (\`state.story\`), a dossier (\`state.dossiers[charId]\`), or any scoped memory the card invents.

**The non-compacting half:** \`rolling.set(ch, key, value)\` overwrites a verbatim fact by key — latest value is canon, values filed at any length; \`rolling.get(ch, key)\` reads it.

**The compacting half:** \`rolling.push(ch, { label, gist, content? })\` files an entry (content = the actual array it covers — a message list, a battle log), each entry a store blob whose id IS its address, so the store doubles as the archive.

**The briefing renders both:** \`rolling.briefing(ch)\` emits the kv facts verbatim first, then id-bearing gist lines, folding the oldest entries into a digest entry when the log outgrows the window (recent 3 entries kept in full, everything older folds — "3+3"). The fold entry's content is the descriptor array of what it compressed, so the model can \`inspect_summary\` its way from digest to sub-summaries to the raw log. \`rolling.bind(prompt)\` once per generate arms folds; an unbound turn defers any due fold to the next bound one. \`rolling.inspect(id)\` is the zoom, also exposed as the \`inspect_summary\` tool via \`ts:use(rolling)\`; \`rolling.parts(ch)\` is the dossier serve shape.

**Model-facing, the kv half is freestyle:** \`ts:use(rolling.tools(ch))\` exposes three tools over one channel — \`list_facts()\` (the keys currently filed — the model checks what's there before writing), \`get_fact({ key })\`, and \`set_fact({ key, value })\` (overwrite, verbatim, latest canon). No schema, no closed key list: the model invents keys as the fiction demands ("grudge_against_guild", "current_disguise"), and \`list_facts\` keeps it from forking a near-duplicate key. Use this for freeform state of the world; use a registry's \`update_*\` tool instead when the fields are known and worth validating (appearance clamps, closed status lists) — the registry is the schema'd kv, the channel is the freestyle one.

The kv block never folds — that is the point, not a leak. It is exactly the information the model has judged must survive verbatim, and the same delegate you trust to game-master the novel action can be trusted to curate it, because the briefing shows it the whole map every turn.

#### \`registry\` — the write shape as data

Declare "a registry of something" and the lib owns validation, clamping, closed lists, id assignment, the canonical tool result, and swipe-stability:

\`\`\`lua
local enemies = registry.new({
  tool = "register_enemy",       -- the mutation tool the model calls
  key = "enemies",               -- stored at state.enemies (a plain array)
  id_from = "name",              -- slugified id; re-registering returns the EXISTING record
  query_tool = "get_enemy",      -- optional read-shape tool
  cap = 8,                       -- optional budget
  fields = {                     -- ARRAY; order is preserved in the schema
    { name = "name", type = "string", required = true },
    { name = "hp",   type = "integer", min = 1, max = 20, default = 6 },
    -- min/max may be zero-arg functions (depth-scaled budgets)
    { name = "tags", type = "array", closed = { "flying", "reflect_magic" } },
  },
  -- optional: draft mode. Records file into a throwaway table instead of state,
  -- for planning gens that speculate before committing (see partitioned registries).
  store = { get = function() return draft.roster end },
  on_register = function(rec) rec.maxHp = rec.hp end,   -- optional reshape/side effects
})
\`\`\`

The tool result is a JSON echo of what was ACTUALLY filed (numeric clamps, dropped tags, assigned id); text is filed verbatim at any length — truncating prose would fill the registry with cut-off natural language. Missing required fields reject with names; \`get_enemy\` answers canonically from the filed records. Re-registering an existing id returns \`{ already_registered, record }\` — never an overwrite, so a regenerated turn converges to the same record (swipe-stable). Power budgets stay the card's — declared as numbers or functions — the lib just enforces them.

**The card-side surface.** A registry instance is also the card's own query layer (plain dot calls): unpartitioned — \`list()\`, \`get(id)\`, \`create(fields)\`, \`update(id, fields)\`; partitioned — \`list(pk)\`, \`get(pk, id)\`, \`create(fields)\` (the partition is derived from the record), \`update(pk, id, fields)\`; plus \`all()\` (cross-partition) and \`briefing(pk?)\` (one line per record, for prompt sections). Unpartitioned records are LIVE — mutate in place and every consumer sees it; partitioned reads return resolved copies, so mutate those through \`update\`. Custom read shapes declare as \`queries = { { name, args, run } }\` — each becomes a tool (schema built from \`args\`) AND a card-side method of the same name, with \`run(records, args)\` receiving the full cross-partition record list. Registries that should share one pack per area share a \`packs_key\` (default \`"packIds"\`).

**Partitioned registries: packs as the persistence unit.** A partitioned registry's records stop living at \`state.enemies\` and start living in PACKS — one store blob per area, shared across all partitioned registries, with \`state\` holding only the pointer (\`state.packIds[areaId]\`). The partition is a property OF THE RECORD, derived by the card, never seen by the model: declare \`partition_by = function(rec) return rec.floor end\` and the registry routes each write itself — a monster's partition is the floor it spawns on, a floor layout's partition is that floor, an item's is \`global\` because it's needed everywhere.

The tool schemas carry no partition field — the model sees natural lookup arguments that HAPPEN to align with partitions (\`list_enemies({ floor = 2 })\` just requires a floor, because that's the sensible way to ask), but "partition" as a concept never appears in a schema. It's not hidden, it's simply not there: the interface speaks fiction (which floor, which room), the storage layer reads the same fields for routing. Exposing the loading mechanism as such would be one more thing for the delegate to fumble, and it already told you where the trog goes — \`location = "upper"\` IS the partition, the registry just reads it.

Writes update the in-memory view immediately and queue a mutation record keyed to the derived partition; the card calls \`registry.flush()\` once at the end of \`generate()\` — queued mutations applied per pack, one new \`store.put\` per touched pack, the pointers move. Reads (\`get_enemy\`, the handlers' internal lookups) lazy-load the relevant packs through the pointer table and resolve base-plus-mutations; cross-area reads just work, because loading is the script's problem, not the model's. Unpartitioned registries work exactly as before — they're the \`partition_by\` returning \`global\` case, conceptually — and the planning gen and the escalation delegate use the SAME mutation tools with no awareness of any of this: one tool economy, and the routing is derived from the fiction itself.

**Mutable fields get set semantics.** Registry records are non-compacting information (The two memory kinds): some fields are fixed at creation (a name, a concept), but others legitimately EVOLVE — a character's appearance, their personality summary, their status. Declare those as \`mutable = { "appearance", "personality" }\` and the lib emits an update tool (\`update_character({ id, appearance = ... })\`) that OVERWRITES the listed fields on the existing record — same validation, same clamps, id stable, latest value canon. (This is the set-vs-append rule from The two memory kinds, applied to records: the dossier is where history goes; the record is where the present lives.)

### Module index (the utilities)

- **\`loop\`** — the delegate tool loop: \`loop.run(sub, res, exec, maxRounds?)\`, default cap 16 (a todo-planning delegate eats rounds on top of its real calls); hitting the cap with calls still pending THROWS — a wedged delegate fails the turn loudly, it never silently drops pending tool work.
- **\`sanitize\`** — \`sanitize.data(t)\`, strips js_null and non-data from \`json.decode\` output.
- **\`chrome\`** — \`chrome.btn(cmd, label)\` (bare command payload), \`chrome.unwrap(text)\` (a posted command → bare verb), \`chrome.clean(text)\` (the deterministic strip for anything that reaches a delegate: legacy \`[sys]\`, buttons, HUD, trim — applied to user input on span append, and by \`inspect\` rendering), \`chrome.oneline(text, max?)\` (one tag-safe line: quotes, whitespace; the length cap is opt-in, for excerpts like the zoom chain's inspect rendering — filing channels never cap).
- **\`ledger\`** — the plot ledger as a module: \`ledger.bind(fn)\` once per turn (\`function() return state.turn end\` — the fn is what "now" means for due-ness clamps), then \`tools()\`/\`exec()\`/\`briefing()\`.
- **\`todo\`** — delegate self-planning, for sub-gens whose job spans many tool calls (pack planning, multi-step escalations): \`set_todo\` REPLACES the checklist, \`todo_done\` marks items, every result echoes the remaining list so the plan rides the tool loop; \`todo.briefing()\` for the prompt.
- **\`summarize\`** — the gist engine: \`summarize.gist(prompt, opts?)\` runs the gist sub-gen over \`opts.span\` (the card's mechanically tracked span — the fight log; mechanical turn-log in, "how it WENT" line out — costs, close calls, items spent; nil only when there's nothing to summarize — a delegate error follows Failure UX). The gist goes two places, both tagless: a plain memoir line in the reply and a rolling story entry.
- **\`maptag\`** — \`maptag.tag(rooms, { cur, entrance, stairs, seen? })\` builds a compact \`[MAP|…]\` tag from a room graph; a companion display rule renders it (source in \`game_cards_example\`).
- **\`toolset\`** — composition (see contract snippet above).
- **\`events\`** — the event engine from the section above. The card creates the character registry itself (\`registry.new\` with ITS fields) and injects it — \`events.new({ roster })\` (or declare \`{ fields, key? }\` and the engine creates the roster) — so the cast stays SHARED, never opaque (another toolset gets the same instance; \`roster.get(id)\` returns the live record for ad-hoc mutations like \`rec.dead = true\`). The engine owns event state (\`isOpen\`/\`kind\`/\`eventLine\`/\`clear\`), the cast tools (\`register_character\`/\`list_characters\`/\`get_character\`/\`add_to_chat\`), dossiers with fold-on-read digestion — armed by \`ev.bindPrompt(prompt)\` once per generate, deferred to the next bound generate otherwise — no structural tags (\`ev.strip\` as pure defense, applied to delegate text before serving), the cast note (\`castLine\`), the append-only span (\`spanStart\`/\`spanAppend\`/\`span\`/\`hasSpan\`), and \`finalize(prompt)\` for the deterministic \`/leave\`. One toolset, two views by mode: the DM escalates with the full toolset and the scene-runner runs with the same one — tools that don't fit the current mode (a second \`open_event\`, a DM-side \`close_event\`) fail as ordinary error results.

---

## The supporting patterns

**Chrome: bare commands, visible acks.** Buttons post bare \`/command\` payloads — never wrap a payload in a tag a display rule hides: display regexes are structure-blind and would eat the attribute, killing the button. Acks are plain VISIBLE text — the model sees the same results the player does, and a capable model needs nothing hidden from it, so game cards have no hidden-chrome tag. Don't reach for a \`[sys]\`-style hide channel: it just rewrangles the delegate's prompt for no gain, and anything the delegate should analyze or summarize ("the player BARELY beat the goblin") must ride a channel it can see anyway. Prompt-side, the script drops bare command messages; display-side, hiding whole-message commands is an optional \`userInput\` rule — honest text by default. The bare-command/button recipe is in \`custom_backends\` (Middleware example).

**Card fields: only \`firstMes\` is load-bearing.** A backend-logic card bypasses the engine's prompt assembly — personality, scenario, mesExample, prompt presets, and LOREBOOKS all land in the script's incoming prompt, and the script composes the delegate's \`messages\` by hand, so none of it ever reaches a delegate; it just taxes the script's own view. Leave personality/scenario empty; keep description/creatorNotes for the library UI. A lorebook attached to a game card is the classic dead-weight mistake. The lorebook EQUIVALENT, when you need one: facts the model writes are registries (locations, characters, items — filed and queried through tools, budgeted by you); sprawling GENERATED material is store blobs with ids in state; and big STATIC world prose is a read tool over a card-authored table — the docs-tool/\`set_memory\` pattern, except static lore needs no storage at all, it's code in the script: \`ts:handle("lore", …)\` keyword-matching a \`LORE\` table and returning the entry. Anything that must steer a delegate unconditionally goes in the briefing the script composes.

**Always end with the buttons — but only buttons the next turn can SERVE.** Every message a game card emits should end with its button row, so the player is never stranded reading prose with no affordance. The static \`firstMes\` is the one trap: the script doesn't run for greetings, so hardcode the opener's buttons into the greeting text — and make sure the first turn's state can answer them. If your card onboards (a registration scene, a character-sheet interview), the opener offers NO buttons, or only ones that route into the onboarding: the menu doesn't exist yet and a button that posts \`/delve\` into an unregistered game is a lie (the Guildhall's greeting offers none — the receptionist asked a question; type, don't click). If the first turn is the normal state machine, hardcode away — any button firing the first turn is fine.

**Multi-character presence.** With the event engine (topic \`game_cards_example\`), presence is already structural — the cast lives in \`state.event.participants\`, rides the newest message via \`ev.castLine()\`, and per-character dossiers are rolling channels. Without it, the poor man's version: when a character enters or leaves a scene, record the current message index in \`state.presence[charId]\` (a list of \`{from, to}\` ranges); when composing a sub-gen that writes that character, filter \`prompt.messages\` to just the ranges they attended (plain index slicing, no NLP) — models do better seeing only what the character saw.

**Rolling summaries.** See Compaction: memoir lines mark the boundaries for the PLAYER, \`lib/rolling\` runs the STORY for the model with \`inspect_summary\` as the zoom, and dossiers are rolling channels keyed by character. (The hand-rolled \`state.summary\` tail-summary is retired — \`rolling\` is strictly better: bounded, branch-correct, inspectable.)

**HUD: values in the tag.** Append a compact state tag to your output (\`[HUD|hp=7|mp=3]\`); a character-scoped display regex renders the panel. Stored text stays compact, the model sees useful state, the user sees chrome. Topic \`regexes\` (HUD recipe).

---

## Design order

The mechanisms compose; here is the order to assemble them, top to bottom.

1. **Systems first.** Pick the central game systems — combat, equipment, navigation, menuing, raising — and the state machine that holds them, one state per system. \`state\` is all that persists, so its fields are the game's memory; declare them here.
2. **Registries next.** For each system, declare what backs it — locations, enemies, stats, items — as \`registry.new\` declarations. The lib owns validation, clamping, closed lists, ids; the model writes, the handlers read.
3. **Handlers and their outputs.** Wire the per-state command handlers — \`attack\` in combat to the resolver, \`buy\` in the shop to the ledger, \`go north\` in navigation to the map. Each state owns its output shape too: the battle menu, the shop list, the navigation view — the button row the player acts on. Buttons post bare commands (topic \`custom_backends\`); every message ends with its row.
4. **The tools that write the registries.** Declare the mutation tools the model authors through — \`register_enemy\`, \`create_room\`, \`promise\` — with the budgets and closed lists Lua enforces. The model files what it invents; Lua validates and hands back the canonical record.
5. **The model-call hooks.** Place the points where the script must call the delegate — "entering the dungeon but it has zero floors" (commission a floor), "the input matched no command" (escalate or fall through to chat), "the fight ended" (summarize). Each is a sub-gen with its own prompt and toolset, built by hand from \`state\` and the turns — not by filtering the engine's assembled prompt.
6. **The interrupt hooks.** Place the points where the script seizes the turn back from the model — "that last \`adjust_hp\` killed the player," "a due promise hit its anchor this turn." Script-side, deterministic; they fire after the tool loop and override the reply.
7. **The chat overlay.** Wire the event engine for the parts that aren't mechanics — scenes with a cast, run by a delegate until they close. The script owns the mode and the exit; the model never types a bracket.
8. **Regexes last.** Add the display rules for the functional chrome — the HUD panel and the MAP render — plus optionally hiding bare command messages. Last, because those rules depend on tags the script already emits (and nothing else needs any).

Get the spine (1–4) standing first: a player can move through the whole deterministic game with no model in the loop. Then add the delegate (5–7) everywhere the spine can't reach, then dress it (8).

---

## Pre-flight checklist

Before enabling a card, verify each of these:

- [ ] **Delegate by default** (\`backends.generate(prompt)\`) so exported cards work on any install; explicit config ids are local-only.
- [ ] **Sub-generations don't inherit the caller's prompt**: copy the prompt table, replace \`messages\`, set \`tools = nil\` (or your own schemas).
- [ ] **Everything the game knows is in \`state\`** — other globals reset every turn; only \`state\` persists, and only it is branch-aware.
- [ ] **Validate before you mutate.** Failed turns never overwrite the last good state snapshot, so throwing mid-turn is safe; returning garbage successfully is not. A hard failure bricks the branch and shows the error — recovery is a swipe or rewind, never "keep typing."
- [ ] **\`registry.flush()\` runs once at the end of \`generate()\`** when any registry is partitioned — reads resolve through the queue regardless, but an unflushed queue bloats every state snapshot.
- [ ] **Continues and impersonates throw early** (before \`ensureState\`); regenerates run the normal pipeline with no special-casing — the backend restores \`state\`, and re-rolling keeps swipes interesting.
- [ ] **Every command path dry-run** (\`run {"verb":"test_backend_logic",...}\`, topic \`workbench\`) — the recording delegate rehearses attacks, refusals, and tool loops without a live backend.
- [ ] **Briefing size discipline**: a full state dump is fine at ~6 values. At 15+, send a what-changed-this-turn digest plus only the relevant subsystem in detail — full dumps eat context and dilute the model's attention.
- [ ] **Dice are Lua's.** Rolls happen in \`resolve()\`; their RESULTS are facts issued in the narration request. The narrator prompt says outright: never fudge, invent, or re-roll outcomes in prose.
- [ ] **The player's own inventions get filed** ("I name my sword Elbereth") through the same tools — or compaction forgets them like any other prose.
- [ ] **Group chats**: each script has its own \`state\` and ledger, blind to the others'. Shared game state across characters needs one owning card (or chat-scoped vars read via \`{{getvar}}\`).
`;
