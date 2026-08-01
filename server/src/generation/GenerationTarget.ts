/**
 * GenerationTarget — the writable endpoint of a generation, and the ONLY
 * thing GenerationRunner talks to. See docs/design/generation-runner.md.
 *
 * Design rules:
 * - Exactly two policies vary by kind, and both live here: prompt assembly
 *   (`prompt`) and persistence/broadcasting (`prepare`/`write`/
 *   `writeToolOutcome`/`finalize`/`abort`).
 * - The target is the source of truth. The runner's loop consults
 *   `pendingToolCalls()` — never transient result fields.
 * - The target owns policy, not machinery. Repos, the prompt builder, and
 *   broadcast services are constructor-injected and shared; the target
 *   orchestrates but does not resolve backends or settings itself — the
 *   runner hands the resolved backend DOWN via `prompt(resolved)`.
 * - Identity fields (chatId, clientId, character, kind) are constructor data,
 *   known by whoever builds the target. Control flow NEVER branches on `kind`;
 *   it exists for macros (`lastGenerationType`), BackendCallContext, and
 *   generation records.
 */

import type { BackendAdapter, BackendStreamItem, ContentPart, GenerationResult, Prompt, ToolCall } from '../backends/BackendAdapter.js';
import type { Character, SettingsMap, BackendConfig, PromptList } from '@tamari/types';
import type { ToolResult } from '../services/ToolRegistry.js';
import type { ToolContextMessage } from '../services/ToolTemplate.js';

/** Effectively-uncapped branch read for full-history consumers (Lua backends,
    StApi) — mirrors StApi's FULL_BRANCH_MESSAGE_LIMIT. */
export const FULL_BRANCH_MESSAGE_LIMIT = 10000;

/** The runner's resolved backend bundle, handed down to `target.prompt()`. */
export interface ResolvedGenerationBackend {
  allSettings: SettingsMap;
  backendConfig: BackendConfig | null;
  promptList: PromptList | null;
  backendSettings: Record<string, unknown>;
  backend: BackendAdapter;
}

/** Conversation-context message handed to tool execution. */
export type { ToolContextMessage };

export interface GenerationTarget {
  /** Read-only metadata. NEVER branched on. */
  readonly kind: 'send' | 'regenerate' | 'continue' | 'impersonate' | 'quiet' | 'genraw' | 'subagent';
  readonly chatId: string;
  readonly clientId?: string;
  /** Constructor data: the character this generation speaks as (group-chat
      member, /ask override, or the chat's own character). Null for character-less
      flows. The runner uses it for contextual-backend resolution only. */
  readonly character: Character | null;
  /** Null for ephemeral targets; null until prepare() for fresh messages
      (the target is the message's *slot* until then). */
  readonly messageId: number | null;
  readonly persistent: boolean;
  /** Backend config id override (sub-agents). Undefined = active config. */
  readonly backendOverride?: string;
  /** Agent nesting depth (0 at top level). Constructor data, passed through
      to tool execution — the runner never branches on it. */
  readonly depth?: number;
  /** Generation record id of the parent run (sub-agents), written to the
      generation record for a traceable tree. */
  readonly parentGenerationId?: string;

  // ── Policy 1: prompt assembly ──────────────────────────────────────────

  /** Assemble the prompt for the next round. Chat targets: branch-up-to-anchor
      with read() appended last, through the full pipeline. Transcript targets:
      seed + accumulated content + tool definitions. */
  prompt(resolved: ResolvedGenerationBackend): Promise<Prompt>;

  // ── Loop state ─────────────────────────────────────────────────────────

  /** The target's accumulated content. For chat targets, ALWAYS appended
      after branch history when the prompt is built. */
  read(): ContentPart[];

  /** tool_use parts with no matching tool_result — the loop's only condition. */
  pendingToolCalls(): ToolCall[];

  /** Conversation context for tool execution (branch read for chat targets,
      accumulated messages for transcript targets). */
  toolContextMessages(): Promise<ToolContextMessage[]>;

  /** The FULL branch — unbounded by promptHistoryLimit / chatTruncation /
      token budget (FULL_BRANCH_MESSAGE_LIMIT applies). Powers Lua-backend
      history access (the `chat` global) and full-branch script-state scans.
      Chat targets: uncapped branch read; transcript targets: same span as
      toolContextMessages(); ephemeral targets: empty. */
  fullBranchMessages(): Promise<ToolContextMessage[]>;

  // ── Policy 2: persistence & broadcasting ───────────────────────────────

  /** Create/resolve the message, hydrate pending state, broadcast appends. */
  prepare(): Promise<void>;

  /** Called by the runner once, right after prepare(), with the run's
      generationId — targets need it for token/done broadcasts keyed on the
      generation (the id is the runner's, created per run). */
  bindGeneration?(generationId: string): void;

  /** Consume one stream item: accumulate, broadcast tokens, schedule flushes. */
  write(item: BackendStreamItem): void;

  /** Persist/broadcast a tool outcome for a pending call. */
  writeToolOutcome(call: ToolCall, outcome: ToolResult): Promise<void>;

  /** Persist the final state, complete the generation record, final broadcasts. */
  finalize(result: GenerationResult): Promise<void>;

  /** Terminalize after an abort/error: persist what should survive, broadcasts. */
  abort(result: GenerationResult): Promise<void>;

  /** Auto-continue policy: if this target warrants an automatic follow-up
      (short message, setting enabled), return the continue target for it.
      Absent/null = no follow-up. Only AssistantMessageTarget implements this. */
  autoContinueTarget?(): Promise<GenerationTarget | null>;
}
