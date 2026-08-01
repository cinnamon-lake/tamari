/** Reference doc for the `game_cards` topic, served by the Docs tool. */
export const GAME_CARDS_DOC = `# Game Cards (complex card architecture)

A draft architecture for cards that run a real game (RPG, sim, mystery) instead of just chatting. This is a shape that works — copy what works and expand based on what you need. Everything here composes mechanisms documented elsewhere: the script contract, delegation, and the tool-loop recipe (topic \`custom_backends\`), display/prompt regex (topic \`regexes\`).

## The one-paragraph stack

Lua owns state and rules; the delegate model owns words — live narration in a narrator-ratio card, bulk content packs in a factory card (see The two ratios). The \`state\` global is the single source of truth: a branch-aware snapshot, restored per branch before \`generate()\` and persisted after successful turns. Chat text is a RENDERING of the game, never a database — once something is on the screen, you don't read it back later to learn what happened. That does NOT mean the model can't author game content. It means one rule: model-authored content becomes real ONLY by passing through a structured channel (usually a tool call) at the moment of creation — Lua validates it, stores it in \`state\`, and everything references it by id from then on. The prose is flavor; the registration is fact.

## The four lanes

Every piece of model output falls into one of four lanes. Classify with ONE question: **if this came out different on a swipe, would anything break?**

### 1. Flavor — read once, never referenced

Mid-battle banter, room descriptions, death quips, bonfire conversation. Goes in the log; nobody needs it as data. Different on a swipe? *That's the point* — swipes exist to re-roll flavor. No registration, no structure, cheapest lane. (The content factory below pre-writes flavor in bulk and stores it in packs — that doesn't contradict this lane: batch flavor is WRITTEN like registry content and SERVED like flavor. The lane rule is that nobody parses it BACK for truth, not that it may never be stored.)

### 2. Registry — the model invents, Lua files

Floor themes, enemy designs, bosses, named NPCs: model-authored, but they must stay CONSISTENT — floor 12 is a flooded library across swipes, branches, and revisits. The channel is **tool calls, not structured formats**: the model invents mid-narration, and a tool call is an aside in the same generation that produces the prose — no separate planning-mode sub-gen. \`register_enemy({...})\` while describing the ambush; \`set_floor_theme({...})\` on first arrival; \`start_encounter({ tier = 3 })\` to interrupt the bonfire scene — even "the player keeps bringing up ghosts, let me add them as an enemy" is just a tool call.

Lua validates on entry: clamp numbers to the power budget, filter ability tags against the closed list the engine implements, assign an id, store in \`state\`. **The tool result is the canonical record** — echo back what was ACTUALLY filed (including corrections), so the model's continuing narration matches fact. On regenerate, check \`state\` first and only generate if absent: swipe-stable by construction.

### 3. Proposal — the model asks, the player (or rules) dispose

"Hey, can you buy more potions? I really think we'll need those." A party member *requesting* something mechanical is neither flavor nor authoring — it's advice with a voice. The model emits a tool call (\`suggest({ action = "buy", item = "potion", n = 3 })\`); Lua turns it into UI — a \`data-post-response\` button (\`[Buy 3 potions — 150g]\`) — and the PLAYER decides. The suggestion may re-roll on swipes; the decision is \`state\`. Variant: a scoped wallet the party AI genuinely spends from — same shape, Lua enforces the cap. (Persistent goals — the healer who has asked three floors running and is getting anxious — are proposal state with memory; add it when a card needs it, not before.) In a simple card the script's own buttons ARE the whole decision UI; the proposal lane appears the moment an NPC has desires of its own.

### 4. Query — the model asks Lua for truth mid-writing

The converse direction: \`roll_dice\`, \`get_enemy\`, \`party_status\` — the model asks, Lua answers deterministically, nothing touches the chat log. This is what grounds banter: the tank jokes about the ACTUAL last boss, the healer cites the ACTUAL potion count. Full recipe in \`custom_backends\` (Giving the delegate tools).

## The two ratios: narrator vs content factory

Decide the delegate's cadence before anything else — it shapes everything downstream.

- **Narrator ratio** (the turn-flow skeleton below is this mode): every turn costs a delegate call — the model writes prose, Lua does math. Right for dialogue-first games (dating, raising, mystery) where the model's voice IS the product. Wrong default for videogame-shaped cards: it feels like chatting with a model that owns a dice roller, and it pays for a generation on every "I open the box."
- **Factory ratio**: the model is invoked at content BOUNDARIES and writes in bulk; Lua serves the generated cache for the next N turns. Right for dungeon crawls, survival, exploration — "dynamically generated videogame," not "dungeon master." Cheaper, more coherent, and it makes the rare live turns feel like magic.
- If what you want is an actual dungeon master, build NEITHER: a plain chat plus a display-regex HUD (topic \`regexes\`), \`run_lua\`/dice tools, and the memory features covers it. This machinery is for games that run themselves between model calls.

## The content factory (model as author, not narrator)

Factory for the anticipated, DM on escalation — ONE tool economy drives both.

**Bulk generation at boundaries.** When the player enters a room/floor/area (or when it's generated), run ONE planning-mode sub-gen where the model builds the whole content pack through tool calls: \`create_room\`, \`add_interactable("box", { responses = {...} })\`, \`spawn_encounter({...})\`, \`add_ambient_lines({...})\`. (Yes, a dedicated planning gen — the registry lane's no-planning-mode rule covers MID-NARRATION invention; boundary generation is its own call by design.) Tools, not one json_schema blob: a blob is one-shot, but tool calls let the model think in increments — revise and extend in-fiction ("the stairs are open, so \`spawn_enemy(trog, location = "upper")\` — they're climbing up"). Every mutation tool takes a \`reason\` field; reasons flow into the briefing, so "why are there trogs on floor 2?" has a canonical answer forever. Lua validates on entry (budgets, closed lists — the \`register_enemy\` clamps) and stores the pack keyed by area id. Size the boundary generously: a pack should hold a whole explorable AREA — a graph of rooms with branches and dead ends, its random-encounter roster, its interactables — not a single room. One-room packs degenerate into room → fight → room: the narrator ratio with extra steps. Pre-write the flavor packs too: boss banter, shopkeeper patter, death quips, deflections — ~10 lines each, cycled deterministically.

**Serve deterministically.** Input matches against the room's interaction table (keyword/verb sets — parser-game style); canned lines come back with ZERO model involvement; ambient lines rotate by turn counter. Cached turns are a pure function of \`state\`, so regenerate and swipes are stable by construction — the whole regenerate question doesn't arise on a cache hit.

**Escalation is the product, not the failure mode.** Cached content exists to make the 10% magical — "wait, I can just blow the door up?" only lands because the last 30 doors didn't blow up. Novel input escalates to the delegate with the FULL mutation toolset: the model interprets the attempt and resolves it through tools (\`remove_item("bomb")\`, \`add_exit("north", via = "destroyed door")\`), then narrates the result. Keep a miss counter: a high escalation rate means the packs are thin, not that the player is brilliant.

**The anti-cheat cost structure.** Escalation without an economy is a genie, and cheating every time is ass. Three load-bearing rules:

- The model chooses the APPROACH, Lua chooses the OUTCOME: \`attempt({ action, approach })\` → Lua assigns difficulty, rolls, returns success/failure PLUS costs. The tool result is the canonical record ("exit added; bomb consumed; the noise echoes") — the model narrates the dice, never decides them.
- Costs are deducted by Lua, never suggested by the model: if \`add_exit\` doesn't consume the bomb, there is no economy.
- Consequences cascade in Lua, not in fiction: blowing the door increments \`state.noise\`; the spawn check is a rule, not a vibe.

**The tool set IS the game design document.** \`add_exit\` exists, \`win_game\` doesn't; \`spawn_enemy\` has a budget; \`revive_npc\` doesn't exist until the necromancer arc adds it. What the model can call is what's possible; everything else it may only narrate failing at.

**Storage: packs in the log, hot state in \`state\`.** Content packs run 2-5KB each and \`state\` snapshots persist per message — a dozen packs and every assistant message carries 50KB of duplicated JSON. Write each pack as a tagged blob in the message where it was generated (branch-aware by construction; give it a summary tag like "designed the flooded library" and \`collapseBlocks\` zooms it for free), keep only ids and hot state in \`state\`, and pull the full pack back with \`chat.find\` when the player walks in. Mutations are append-only: a changed pack is a NEW blob in a later message; newest-first retrieval makes the latest version win.

A complete, tested factory-ratio card lives in topic \`game_cards_factory\` (The Sunken Crypt) — floor-graph planning, roster-based random encounters, serving, escalation, and pack versioning, all proven through the real adapter.

## Turn-flow skeleton

The narrator-ratio spine — a factory card runs the same shape, with a cache lookup where the delegate call would be and escalation on a miss:

\`\`\`lua
function generate(prompt, ctx)
  ensureState()                       -- idempotent defaults; state arrives restored for this branch
  local input = lastUserText(prompt)  -- scan prompt.messages backwards for role == "user"

  local cmd = parseCommand(input)     -- [sys]-wrapped or typed; see below
  if cmd then return handleCommand(cmd) end

  local outcome = resolveRules(input) -- pure Lua: dice, costs, cooldowns — NO model involved
  local sub = buildDelegatePrompt(prompt, outcome)  -- filtered history + state briefing + sub.tools
  local res = backends.generate(sub):await()
  res = runToolLoop(sub, res)         -- lanes 2-4: validate, register, answer, re-call
  return finalize(res.text, outcome)  -- apply deltas, append HUD tag, return
end
\`\`\`

Guard \`ctx.generationType\`, and get the asymmetry right: on \`regenerate\`, \`state\` rolls back to BEFORE the turn, so re-resolving the command is safe whenever every side effect lives in \`state\` — and re-rolling keeps swipes interesting. On \`continue\`, \`state\` is post-turn, so NEVER re-resolve — narrate onward only. Don't try to cache the outcome in \`state\` for regenerate stability: the rollback undoes your cache along with everything else, and you'd re-narrate the PREVIOUS turn. (The exception that still needs a hard guard on both: one-shot side effects that escape \`state\`, like a submitted form firing a real action.)

## The hard case: model-designed enemies

The one place model creativity has stat-shaped consequences. The model is great at CONCEPTS ("a glass knight that reflects spells") and terrible at balance — so **Lua owns the power budget, the model owns the concept**. State the current tier/budget in the briefing or the tool description; the model calls \`register_enemy\` with its concept and allocation; Lua clamps. Calibration: strict budgets for bosses, free-form-with-clamps for grunts. And the key trick: **ability tags come from a closed list the combat engine implements** — \`reflect_magic\` has real mechanics; the free-text flavor around it is free. Bosses are the same shape one level up: the model designs phase BEATS ("at 50% he shatters the floor"), Lua owns the trigger logic, the transition narration is a flavor sub-gen.

## Judgment as data: \`response_format\`

The minority case where structured output beats tool calls: you need the model's EVALUATION, not invention — did the persuasion land? how bad is that wound? Run a dedicated sub-generation whose whole answer IS the data: \`response_format = { type = "json_schema", schema = ... }\`, consume with \`json.parse_result\`, pattern-match \`.error\`, keep a sane default. Cheap models are fine for evaluation; save the good model for prose.

## The ledger: long-term planning

The model will make commitments about the future — a rule it just invented ("Mira's affection caps at 40 until the festival"), or work it explicitly defers ("the brother's design — I'll finalize it when I lay out floor X"). PROSE CANNOT CARRY THESE: rolling summaries paraphrase foreshadowing away ("cap 40 until the festival" survives one compaction pass as "she was distant"). The ledger is the compaction-proof channel — a registry-lane specialization where what's registered is INTENT, not entities.

- **One tool: \`promise({ id, what, due })\`** (plus \`resolve_promise\`). Filed mid-narration like any registry call. The critical validation: \`due\` must be a CONCRETE anchor — floor 12, week 20, an event id, a stat threshold. Reject "later" at registration; a vague due date is a promise that never comes due.
- **Two enforcement tiers.** A tiny vocabulary Lua can EXECUTE — caps, locks, flags (\`cap = { who = "mira", max = 40, until = "mira_festival" }\` read directly by Lua's clamp, mechanically true the same turn). Keep it tiny: three primitives cover almost everything; a bigger one is a DSL gravity well. Everything else is narrative-only — you can't enforce "design the brother well," but you can remind.
- **The briefing is the memory.** The pending ledger rides in every briefing; Lua computes due-ness (it knows floors, dates, stats) and escalates — \`DUE NOW: the brother — design him this turn\`. Escalation is what makes "I'll finalize later" reliable instead of a prayer.
- **Lifecycle includes failure.** pending → kept / failed. Failure is canon: miss the festival and her route closes — now a mechanical fact Lua enforces from then on.
- **Swipes come free.** A promise filed in a swiped-away turn vanishes with the branch — different swipe, different future. Once persisted, the ledger is canon; tell the narrator so ("never contradict the ledger").
- Optionally auto-file a stub when a due promise is ignored (a placeholder brother design) so a due floor never ships empty. Insist-in-prose first; add stubs when a card proves it needs them.

This is what turns the delegate from a turn-writer into a SHOWRUNNER: it plants in act 1 and trusts the payoff in act 3, because the reminding is structural, not contextual. The Sunken Crypt (topic \`game_cards_factory\`) carries a turn-anchored version in both its planning and DM toolsets.

## Compaction: summary tags and recall

History is what outgrows the context window first. The pattern: tagged blocks whose CLOSING tag carries the gist. The summary can only ride the close tag (or \`state\`) — stored history is immutable, so it can never be spliced back into the opening message:

\`\`\`
[dungeon exploration 5]
...as many messages as the exploration takes...
[/dungeon exploration 5 summary="Cleared the flooded library; Mira lost her locket."]
\`\`\`

**The asymmetry that makes this safe.** Both history cuts (\`promptHistoryLimit\`, the token budget) remove from the OLD side — newest messages are always kept. An open tag can scroll out while its close stays visible; the reverse cannot happen. And a swipe back past the close removes the close (and its summary) from the branch. So every unbalanced case has exactly one right answer:

- **pair visible** → replace the span with the close tag's summary.
- **close visible, open scrolled out** → everything visible BEFORE the close is the block's tail: collapse window-start → close with the summary. Self-describing, no registry needed.
- **open visible, no close** → the block is still open ON THIS BRANCH (mid-block, or the close was swiped away). Leave the text alone.
- **block fully scrolled out** → it VANISHES from the delegate's view. If the delegate needs it, track closed-block summaries in \`state\` (branch-aware) and prepend a "previously:" digest to the briefing.

**Never ONE lazy regex over the window.** Interleaved blocks plus a window boundary make lazy spans mismatch (block 3 scrolled out, block 4's open visible, block 5's close visible — the regex eats block 4 alive). Collapse oldest-close-first: find the oldest visible close-with-summary; no open visible → collapse window-start→close; else collapse the pair; re-scan; repeat. ~40 lines of Lua, no ambiguity — the Sunken Crypt carries it as \`collapseBlocks\`, tested for all three cases.

**Who splices the summary:** the script, on the closing turn — a summarize sub-gen over the span (read from \`prompt.messages\` if visible, from the \`chat\` global when the open already scrolled out), spliced deterministically into the close tag the script appends. Script owns the format (no double quotes inside summaries), the model owns the content. A close tag arriving with NO summary means the model freelanced: \`chat.find\` the open and derive one, or strip the tag — never leak it.

- **Collapse SCRIPT-SIDE, not with a prompt rule.** Prompt rules run at assembly, before the backend sees the prompt — an engine rule would collapse blocks for EVERY consumer, including the script itself, whose incoming \`prompt.messages\` is already regex-processed. The script must stay omniscient (it is the summarizer and the recall source); only delegates get the compressed view.
- **Zoom levels.** Blocks nest (\`[room]\` inside \`[dungeon exploration]\`); ordered gsubs collapse inner blocks first, then the parent — recent history full-text, older history auto-zoomed out.
- **Gist vs exact.** A summary is a paraphrase. Gist lives in tags, mechanics in \`state\`, commitments in the ledger — a fact that must stay exact may never travel ONLY in a summary.

**Recall is the antidote.** Once the delegate's view is compressed, give it a way back to the record: \`recall({ query })\` served from the \`chat\` global (topic \`custom_backends\`) — \`chat.find(query)\` searches the FULL branch, unbounded by history-depth settings, and the script returns the matching block(s) verbatim, truncated with a pointer; \`inspect_state()\` returns the full state dump for when the digest briefing isn't enough. One honest bound: recall returns text, not truth — how the goblin encounter WENT is in the log, the goblin's HP is in \`state\`. Exact facts still belong to registry/ledger: recall is for "what was said," not "what is."

Four channels, four fidelity levels: \`state\` for mechanics, the ledger for commitments, tags for gist, recall for verbatim-on-demand.

## The supporting patterns

**Chrome: bare commands, \`[sys]\` acks.** Buttons post bare \`/command\` payloads — NEVER \`[sys]\` inside \`data-post-response\`: display regexes are structure-blind, so a \`[sys]\`-hiding rule eats the attribute too and kills the button. Acks go out \`[sys]...[/sys]\`-wrapped — that tag survives only in script-controlled text. Prompt-side, the script drops bare commands and strips acks; display-side, one rule hides acks (hiding whole-message commands is an optional \`userInput\` rule — honest text by default). Full recipe in \`custom_backends\` (Middleware example). Use it for every non-narrative interaction.

**Presence markers: \`[SCENE name]\`.** For multi-character cards: mark who was present — emit the tag in your own output, or record message ids in \`state.presence\`. When the delegate writes Lloyd's response, filter \`prompt.messages\` to the scenes Lloyd attended: plain string matching, no NLP. Models write better characters when they only see what the character saw.

**Rolling summaries.** See Compaction above — close-tag summary blocks are the recommended shape (branch-correct by construction, zoom levels). A plain \`state.summary\` tail-summary (summary + last-summarized message id, delegated prompts = system + summary + later messages) still works for simple cards and is branch-correct via the state snapshot.

**HUD: values in the tag.** Append a compact state tag to your output (\`[HUD|hp=7|mp=3]\`); a character-scoped display regex renders the panel. Stored text stays compact, the model sees useful state, the user sees chrome. Topic \`regexes\` (HUD recipe).

## Hygiene

- Delegate by default (\`backends.generate(prompt)\`) so exported cards work on any install; explicit config ids are local-only.
- Sub-generations don't need the caller's tool schemas or full history: copy the prompt table, replace \`messages\`, set \`tools = nil\` (or your own schemas).
- Keep EVERYTHING the game knows in \`state\` — other globals reset every turn; only \`state\` persists, and only it is branch-aware.
- Failed turns never overwrite the last good state snapshot, so throwing mid-turn is safe; returning garbage successfully is not. Validate before you mutate.
- Dry-run every command path before enabling (\`run {"verb":"test_backend_logic",...}\`, topic \`workbench\`) — the recording delegate rehearses attacks, refusals, and tool loops without a live backend.
- Briefing size discipline: a full state dump is fine at ~6 values. At 15+, send a what-changed-this-turn digest plus only the relevant subsystem in detail — full dumps eat context and dilute the model's attention.
- Dice are Lua's. Rolls happen in \`resolve()\`; their RESULTS are facts issued in the narration request. The narrator must never fudge, invent, or re-roll outcomes in prose — say so in the narrator prompt.
- The registry lane is for the PLAYER's inventions too ("I name my sword Elbereth") — file them through the same tools, or compaction forgets them like any other prose.
- Group chats wrap per speaking character: each script has its own \`state\` and ledger, blind to the others'. Shared game state across characters needs one owning card (or chat-scoped vars read via \`{{getvar}}\`).
`;
