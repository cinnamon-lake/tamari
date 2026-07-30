# Generation Runner — Design Proposal

**Status:** steps 1–3 implemented on branch `agentic-expansion` (Target + Runner, sub-agent plumbing, backend registry). Step 4 (pipeline stages) remains a separate, later change.
**Motivation:** unify the generation core before building sub-agent tool-calling and custom-backend composition on top of it.

## Problem

The generation flow currently lives in `server/src/services/GenerationService.ts` (~2000 LOC) and has three structural defects:

1. **No unified entry.** Behavior is steered by positional parameters on `executeGeneration(chatId, character, parentId?, targetMessage?, lockHolder?, clientId?, autoContinueDepth, useBulkOnly, lastGenerationType)` (`GenerationService.ts:892`). You cannot point at one type and say "this is what a generation is."
2. **A parallel universe.** `handleImpersonate` (`:1181`) bypasses `executeGeneration` entirely and runs through `runQuietGeneration` (`:1739`) — a second, reduced copy of the `runGeneration` streaming loop (`:1378`) that silently drops tool calls and script state. Two streaming engines must be kept in sync; one of them is wrong by omission.
3. **Special cases that are really the general case.** `executePendingTools` (`:484`) handles "continue on a message that ends in un-executed tool calls" as a pre-step. But that state is indistinguishable from "the model just emitted tool calls this round" — it should be the same code path, entered the same way.

The sub-agent work makes defect 2 untenable: a sub-agent *is* a quiet generation that must call tools, so the transient path needs the full loop, not a copy of it.

## Design principles

- **Minimize moving parts.** Two concepts: target, runner. No intent struct, no transcript abstraction, no run-context bag, no external pipeline step.
- **The target is the message.** Every fact the runner needs — chatId, clientId, kind — is a fact about the target, known at construction by the dispatch handler.
- **Exactly two policies vary by kind: persistence and prompt assembly. Both live on the target.** Everything else — mutex, tool loop, streaming, backend resolution — is uniform and lives in the runner. The runner is kind-blind; it never branches on `target.kind`.
- **The target owns policy, not machinery.** Heavy machinery (PromptBuilder, renderers, WI, repos, backend factory) is constructor-injected and shared; the target orchestrates, it does not implement. Dependency direction is strictly runner → target: the runner hands the resolved backend down, the target never reaches out to resolve anything itself.
- **The target is the source of truth.** Control flow consults the target's persisted state (pending tool calls), never transient result fields. Abort/resume semantics fall out of this for free.
- **Locks are passed, not counted.** A nested generation receives the mutex its parent holds. Lua execution is linear and single-threaded; anything that can't get the lock fails fast. (Depth exists, but only for recursion bounding — see Sub-agents.)

## Concepts

### 1. `GenerationTarget` — the two kind-varying policies

```ts
interface GenerationTarget {
  /** Identity — set at construction, never resolved lazily */
  readonly chatId: string;
  readonly kind: 'send' | 'regenerate' | 'continue' | 'impersonate' | 'quiet' | 'subagent';
  readonly persistent: boolean;
  readonly messageId: number | null;   // null for ephemeral targets; null until
                                       // prepare() for fresh messages (the target
                                       // is the message's *slot* until then)

  /** POLICY 1: prompt assembly. The backend is handed down (model-aware
      token budgeting, chat-vs-text render mode); the target resolves
      nothing itself. */
  prompt(backend: BackendAdapter, settings: BackendSettings): Promise<Prompt>;

  /** The target's accumulated content. For chat targets, ALWAYS appended
      after branch history when the prompt is built. */
  read(): ContentPart[];

  /** tool_use parts with no matching tool_result — the loop's only condition */
  pendingToolCalls(): ToolCall[];

  /** POLICY 2: persistence & broadcasting */
  prepare(): Promise<void>;                                // create/resolve message, broadcast appends
  write(item: BackendStreamItem): Promise<void>;           // throttled flush is the impl's business
  writeToolOutcome(call: ToolCall, outcome: ToolOutcome): Promise<void>;
  finalize(result: GenerationResult): Promise<void>;       // persist, generation record, final broadcast
  abort(partial: GenerationResult): Promise<void>;
}
```

`clientId` is constructor data for the implementations that need directed replies (`DraftTarget` broadcasts the impersonation draft to one client; error routing uses `sendTo`). Message patches broadcast to everyone as today, so `AssistantMessageTarget` only needs it for errors.

**The assembly rule.** For chat targets, prompt history is always branch-up-to-anchor with the target's content appended last — `read()` is unconditionally the tail of the prompt. This one rule covers every chat flow:

- **send / regenerate** — history is the branch up to the anchor (the user message / the swipe's parent); the fresh target's `read()` is empty-or-partial.
- **continue** — the existing message's accumulated parts (text, tool_use, tool_result) read as the trailing content; the model picks up exactly where the state says it is. This is why continue-with-pending-tools needs no special case.
- **impersonate** — `DraftTarget` is *seeded* with `{ type: 'text', text: impersonationPrompt }`: it exists in `read()` (appended last, as the start of the user's turn) but is never persisted — `finalize` broadcasts the draft and writes nothing to the DB. The impersonation prompt moves from a synthetic system slot in `PromptManager` to target seed content. **Behavioral delta to verify:** its position changes from system slot to trailing content; existing impersonate tests must pin the new position.

**Prompt assembly is reframed: the prompt list asks for the character definition.** The preset's prompt list declares slots and markers; the marker resolver walks chat → character/persona to fill `charDescription`, `scenario`, `personaDescription`, etc. Most of `buildGenerationPrompt`'s current opts object was always derivable from the chat — now it's derived instead of passed.

**Two assembly policies exist, chosen at construction:**

- **Chat-prompt assembly** (full machinery: prompt list, markers, character card, world info, regex, memory, renderers — today's `PromptBuilder`, injected as a collaborator). Used by `AssistantMessageTarget` *and* `DraftTarget` — impersonate builds the complete prompt today, it only differs in seed + persistence.
- **Seed assembly** (trivial: seed + accumulated content + tool definitions; no prompt list, no card, no world info). Used by `TranscriptTarget`. This is *correct* for a worker sub-agent — and a future card-aware sub-agent is just a `TranscriptTarget` constructed with the chat assembly instead. Construction choice, never a runner branch.

Three implementations cover all current flows:

| Implementation | Constructed by | Assembly | Covers |
|---|---|---|---|
| `AssistantMessageTarget` | `forNewMessage({ chatId, parentId?, characterId? })`, `continueFrom(messageId)`, `regenerateOf(messageId)` | chat | send, continue, regenerate, group-chat members |
| `DraftTarget` | `new DraftTarget({ chatId, clientId, impersonationPrompt? })` | chat | impersonate |
| `TranscriptTarget` | `new TranscriptTarget({ chatId, clientId?, seed, backend? })` | seed | quiet gen, genraw, sub-agents |

The optional `characterId` on `forNewMessage` is how group chats generate per-member: the handler constructs one target per activated character. Kind-specific data (impersonation prompt, backend choice, seed) is constructor input — it never passes through the runner.

### 2. `GenerationRunner` — the uniform remainder

```ts
class GenerationRunner {
  async run(target: GenerationTarget, lock?: ChatLock): Promise<GenerationOutcome>;
}
```

That is the entire input surface. The runner owns only what is genuinely uniform: backend resolution (active config, or the backend a `TranscriptTarget` was constructed with), mutex tenure, the tool-call loop, and the streaming engine.

**Mutex:** passed explicitly. `lock` present → nested generation under a held tenure (sub-agent inside a tool call): skip acquisition, skip lifecycle callbacks. `lock` absent → top-level: acquire the chat mutex (keyed on `target.chatId`), fire lifecycle callbacks. "Top-level" is defined by lock ownership, not by counting depth. Lua execution is linear and single-threaded, so a tenure is always held by exactly one logical strand.

The loop — control flow consults only the target:

```
run(target, lock?):
  backend = resolveBackend(target)            // target.backend ?? active config
  if lock absent: acquire mutex(target.chatId); fire lifecycle callbacks
  await target.prepare()

  loop while rounds < maxToolRounds:
    pending = target.pendingToolCalls()
    if pending.length > 0:
      for call in pending:
        outcome = await toolRegistry.execute(call, { chatId: target.chatId, clientId, lock, depth })
        target.writeToolOutcome(call, outcome)
        if outcome.endsTurn → return target.finalize(result)
    else if rounds > 0:
      break                                     // streamed, nothing pending → done

    prompt = await target.prompt(backend, settings)
    result = await streamRound(prompt, backend, target, signal)
    rounds++

  return target.finalize(result)
```

Case analysis:

- **Fresh generate** — empty target: `pending` empty, `rounds == 0` → stream. Next iteration breaks or executes tools.
- **Continue on aborted message** — the target's `read()` already returns tool_use parts without results: iteration 1 executes them, then streams. `executePendingTools` is deleted; the special case is iteration 1 of the general loop.
- **Tool loop** — identical to the continue case, which is the point.
- **Impersonate** — same loop; `DraftTarget` differs only in seed + persistence. Gains consistent `sendTo` error routing, token counting, and a generation record for free.

## Sub-agents

A sub-agent is a runner call from inside `ToolRegistry.execute`, handed the lock the parent holds (implemented as the `run_agent` builtin tool):

```ts
const outcome = await runner.run(
  new TranscriptTarget({
    chatId,                                   // must equal the parent's — see below
    clientId,
    seed: [{ type: 'text', text: systemPrompt + input }],
    backend: tool.config.backend,             // optional override
  }),
  lock,                                       // parent's tenure
);
return outcome.text;
```

- Sub-agents get tool-calling for free — there is only one loop, and `TranscriptTarget.pendingToolCalls()` works on the accumulated content exactly as `AssistantMessageTarget`'s works on message parts.
- **Recursion is bounded by depth**, carried in the *tool execution* context (not the runner): `toolRegistry.execute` receives `depth` (0 at top level), the spawn tool refuses to spawn beyond `maxAgentDepth`, and a spawned sub-agent's own tool executions receive `depth + 1`. The runner itself never sees depth — lock ownership already tells it everything it needs about nesting.
- **Quick replies triggered from inside a sub-agent throw.** A quick reply is an external, user-level thing that is merely *triggered* by the agent — the lock is not passed into it, its `tryLock` fails, the request dies loudly. Deliberate, not a bug: silently queueing external side effects inside a sub-agent tenure would be worse.
- Cross-chat sub-agents are forbidden: a sub-agent's `chatId` must equal its parent's, because the passed lock keys on it.

### Tool access and state sharing

- **Tool access is an explicit allowlist.** A toolset's tools are advertised to sub-agents only when the toolset is enabled AND its `agent_visible` flag is set (UI: the toolset's **Sub-agents** checkbox; default off). The main chat is unaffected — it keeps using every enabled toolset.
- **The spawn tool hides itself at the cap.** A sub-agent at the last allowed depth doesn't get `run_agent` in its definitions at all — filtered by the owning toolset's `templateId` (`agent`), not by tool name, so renamed (override) spawn tools are still caught. The `agent_spawn`/`run_agent` depth guard remains as the hard bound.
- **Reads inherit.** A sub-agent's tool executions see the parent's branch (plus their own transcript) as context — tool state snapshots, chat content, everything a main-chat tool would see.
- **Writes land on the parent branch once.** After the nested run, the spawn tool collects the newest `_toolState` snapshot per stateKey from the sub-agent's transcript and returns them as `extra._toolState` on its own tool result. The parent's message therefore carries the sub-agent's mutations — and swiping away the spawn message undoes them (branch-aware for free). The `agent` stateKey itself is never propagated.
- **Macro vars stay isolated.** A sub-agent's `{{setvar}}` never touches the parent's variables.

## Generation records

All target kinds write a generation record in `finalize` — including quiet and sub-agent runs. Sub-agent records carry `kind: 'subagent'` plus a parent-generation reference, giving a traceable tree for debugging instead of an invisible black box. One row per completed `run()`, not per tool round.

## Custom backends (follow-on, same branch of work)

- `backends/factory.ts`'s if-chain becomes a `Map<string, AdapterFactory>` registry: built-ins registered at startup, Lua/custom backends by name, unknown names error loudly instead of silently becoming OpenAI (`factory.ts:220`).
- The character-coupled contextual backend (`createContextualBackendAdapter`, `GenerationService.ts:676`) becomes a decorator applied at one point in backend resolution, not bolted on inside it.

## `/inject`: bricked

`/inject` (and `st.inject`) are removed. They currently ride `pendingInjections` — mutable cross-call state on the service with dedicated race-fix regression tests, which tells you what it's like. If a runtime-injection capability ever comes back, it returns as seed content on the target (same mechanism as the impersonation prompt), not as a side channel into prompt assembly. Migration: drop the WS message field, the `pendingInjections` map, and the client `/inject` command; note it in `docs/roadmap/breaking-changes.md`.

## What this deletes

- `runQuietGeneration` (`GenerationService.ts:1739-1821`) — entire second streaming engine.
- `executePendingTools` (`:484`) — becomes loop iteration 1.
- The always-`true` `suppressDone` parameter and its dead broadcast branch (`:1386`, `:1715`).
- Three copy-pasted character-resolution blocks (`:1158`, `:1198`, `:1274`).
- `handleGenRaw`'s inline backend resolution (`:1944`).
- `executeGeneration`'s nine positional parameters.
- The external `pipeline.build(...)` step in the generation flow — prompt assembly becomes `target.prompt(backend)`, with `PromptBuilder` living on as the chat-assembly collaborator.
- `pendingInjections` and its race-fix surface; `/inject` and `st.inject`.
- Impersonate's broadcast-to-everyone error routing bug (`:1211`) — subsumed by the unified path.

## Explicit non-goals (for this change)

- **Pipeline staging.** `PromptBuilder.build()`'s fixed stage sequence (`PromptBuilder.ts:205-213`) stays as-is inside the chat assembly — re-homing stages as a named, ordered list is a separate, later consolidation.
- **Renderer changes**, token-budget location, `chatHistory` marker-position semantics.
- **Client changes beyond removing `/inject`.** WS message types and broadcasts otherwise stay wire-compatible.

## Decisions taken

- **`pendingToolCalls()` hydration** — `AssistantMessageTarget.continueFrom` reads pending state from the DB once in `prepare()`, then tracks locally as it writes (it sees every tool_use/tool_result).
- **Mutex ownership** — passed explicitly, no depth counting for control flow. Quick replies inside a sub-agent tenure fail fast. Cross-chat sub-agents forbidden.
- **No `RunContext`** — `chatId`/`clientId`/anchor are target identity; backend override is target-construction data. The runner derives everything else from `target.chatId`.
- **Prompt assembly lives on the target** — the two kind-varying policies (persistence, prompt assembly) are target methods; machinery is injected and shared.
- **`endsTurn` moves to `ToolOutcome`** — a tool may decide to end the turn based on what happened during execution; the loop reads it from the outcome, not the definition.
- **Generation records for all kinds** — one record per `run()`, sub-agents included, with parent references.
- **Recursion bound via depth in the tool execution context** — spawn tool enforces `maxAgentDepth`; runner stays depth-free.
- **`/inject` and `st.inject` are bricked.**

## Migration order

1. **Target + Runner.** Migrate send/continue/regenerate, then impersonate/quiet/genraw; delete `runQuietGeneration`. Safety net: the six existing `GenerationService.*.test.ts` files; add golden-prompt tests per target kind *before* moving anything.
2. **Sub-agent plumbing** — lock + depth through the `ToolRegistry` context, tool allowlists, the spawn tool.
3. **Backend registry** replacing the if-chain.
4. (Later, separate change) **Pipeline stages.**

Step 1 is the only risky one; steps 2–3 are additive once it lands.
