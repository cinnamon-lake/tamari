/**
 * Prompt pipeline orchestrator.
 *
 * Assembles the final prompt sent to backend adapters: always a message
 * list — text-completion adapters flatten it themselves with their
 * configured instruct template.
 *
 * `build()` is a thin driver over an ordered, replaceable stage list
 * (PromptStages.ts): the stage SEQUENCE is data; the stage BODIES are the
 * `@internal` methods below (same code as the legacy fixed build()).
 */

import { getMessageText } from '@tamari/types';
import type { Message, Character, WorldInfoEntry, MemorySummary, MacroGenerationType } from '@tamari/types';
import type { Prompt } from '../backends/BackendAdapter.js';
import type { WorldInfoInjector } from './WorldInfoInjector.js';
import { MacroResolver, type MacroContext } from './MacroResolver.js';
import { applyRules, filterRulesByRole } from '../services/RegexEngine.js';
import { PromptManager, type PromptDef, type PromptOrderEntry } from './PromptManager.js';
import { ChatCompletionRenderer } from './renderers/ChatCompletionRenderer.js';
import { PROMPT_SEPARATOR } from './renderers/Renderer.js';
import type { RegexRule } from '@tamari/types';
import type { ITokenCounter } from '../tokenizers/TokenCounter.js';
import type { BackendToolDefinition } from '../services/ToolRegistry.js';
import { ExampleBuilder } from './ExampleBuilder.js';
import { createDefaultStages, PromptContext, type PromptStage } from './PromptStages.js';

/** Author's Note configuration. */
export interface AuthorsNoteConfig {
  content: string;
  position: 'before_prompt' | 'after_prompt' | 'in_chat';
  depth: number;
  role: 'system' | 'user' | 'assistant';
  interval: number;
}

export interface BuildOptions {
  // ---- Core generation inputs ----
  chatHistory: Message[];
  character?: Character | null;
  userName: string;
  maxContext: number;
  maxResponseTokens: number;
  model?: string;
  /** Optional persona description */
  personaDescription?: string;
  /** Custom stopping strings for this generation */
  stopStrings?: string[];
  /** Whether to include reasoning blocks in prompt context */
  reasoningAddToPrompts?: boolean;
  /** Regex rules for prompt transformation */
  regexRules?: RegexRule[];
  /** Optional rolling memory summary to inject before chat history. */
  memorySummary?: MemorySummary | null;
  /** Tool definitions registry lookup */
  toolDefinitions?: BackendToolDefinition[];

  /** World Info activation data for this generation. */
  worldInfo?: {
    entries?: WorldInfoEntry[];
    /** Entry IDs that matched via semantic retrieval. */
    semanticMatches?: Set<string>;
  };

  /** Prompt-structure config: preset lists, card overrides, splice-in content. */
  prompts?: {
    /** Optional system prompt override from character card */
    systemPromptOverride?: string;
    /** Optional jailbreak override from character card */
    jailbreakOverride?: string;
    /** Optional preset prompts to use instead of defaults */
    presetPrompts?: PromptDef[];
    presetPromptOrder?: PromptOrderEntry[];
    /** Author's Note configuration */
    authorsNote?: AuthorsNoteConfig | null;
    /** If true, don't include mesExample dialogue in the prompt */
    stripExamples?: boolean;
  };

  /** Macro plumbing: variable state and per-generation macro context. */
  macro?: {
    /** Local variables for .varname shorthand */
    vars?: Record<string, string>;
    /** Global variables for $varname shorthand */
    globalVars?: Record<string, string>;
    /** Character asset name → canonical URL for img macro */
    characterAssets?: Record<string, string>;
    /** Active extension names for hasExtension macro */
    extensions?: string[];
    /** Generation type for state macros */
    lastGenerationType?: MacroGenerationType;
  };

  /** Media types supported by the active backend. */
  media?: {
    supportsImages?: boolean;
    supportsAudio?: boolean;
    supportsVideo?: boolean;
    /** When true, replace media attachments with text placeholders */
    verboseMode?: boolean;
  };

  /** Prompt caching config. */
  caching?: {
    /** 'auto' computes depth from injections; 'manual' uses manualDepth; 'off' disables. */
    mode?: 'auto' | 'manual' | 'off';
    /** Manual cache depth (role-transition count) when mode is 'manual'. */
    manualDepth?: number;
    /** Append-only layout: suppress everything that rewrites/repositions
        already-sent bytes (docs/design/append-only-caching.md). */
    appendOnly?: boolean;
  };
}

/** Result of the World Info scan stage. */
export interface WorldInfoScanResult {
  before: string;
  after: string;
  atDepthEntries: WorldInfoEntry[];
  activatedEntryIds: string[] | undefined;
  /** Append-only mode: at least one non-constant entry was excluded (trace). */
  excludedNonConstant?: boolean;
}

/** Result of the Author's Note in-chat splice stage. */
export interface AuthorsNoteSpliceResult {
  chatHistory: Message[];
  /** Resolved AN content (empty when inactive this generation). */
  content: string;
  /** True when the AN was spliced into chat history (in_chat position). */
  inChat: boolean;
  /** Append-only mode: raw (macro-unresolved) note text to hoist to the
      pinned block instead of splicing (in_chat position only). */
  hoistedText?: string;
}

export class PromptBuilder {
  /** @internal — stage closures read these via PromptBuilderStageHost. */
  readonly macroResolver: MacroResolver;
  /** @internal */
  readonly chatRenderer: ChatCompletionRenderer;
  /** @internal */
  readonly exampleBuilder: ExampleBuilder;
  private readonly stages: PromptStage[];

  constructor(private worldInfo?: WorldInfoInjector, stages?: PromptStage[]) {
    this.macroResolver = MacroResolver.createPromptResolver();
    this.chatRenderer = new ChatCompletionRenderer();
    this.exampleBuilder = new ExampleBuilder();
    this.stages = stages ?? createDefaultStages(this);
  }

  async build(opts: BuildOptions): Promise<Prompt> {
    const ctx = new PromptContext(opts);
    for (const stage of this.stages) {
      await stage.run(ctx);
    }
    if (!ctx.result) {
      throw new Error('PromptBuilder: the stage list produced no prompt — the render stage is required');
    }
    return ctx.result;
  }

  // -------------------------------------------------------------------------
  // Stage bodies (@internal — called by the PromptStages.ts closures, not by
  // build() directly; same code as the legacy fixed build() sequence)
  // -------------------------------------------------------------------------

  /**
   * Stage: scan World Info entries against the macro-resolved history.
   * Returns the before/after prompt strings, atDepth entries, and the IDs of
   * entries that activated this turn.
   * @internal
   */
  scanWorldInfo(
    opts: BuildOptions,
    visibleHistory: Message[],
    macroCtx: MacroContext,
    tokenCounter: ITokenCounter,
  ): WorldInfoScanResult {
    const result: WorldInfoScanResult = {
      before: '',
      after: '',
      atDepthEntries: [],
      activatedEntryIds: undefined,
    };
    const entries = opts.worldInfo?.entries;
    if (!this.worldInfo || !entries || entries.length === 0) {
      return result;
    }

    // WI activation is bounded by its own deterministic caps (scan depth,
    // recursion depth) — no token budget is applied here.
    // Resolve macros on a COPY of chat history so WI keyword matching works
    // against expanded names ({{char}} → Seraphina) without mutating originals
    const resolvedHistoryForWI = visibleHistory.map((msg) => ({
      ...msg,
      content: this.macroResolver.resolve(getMessageText(msg.extra.parts), macroCtx),
    }));
    const wiResult = this.worldInfo.scan({
      entries,
      chatHistory: resolvedHistoryForWI,
      tokenCounter,
      semanticMatches: opts.worldInfo?.semanticMatches,
    });

    // Append-only: non-constant entries are not rendered at all — keyword-set
    // shifts would rewrite already-sent bytes. Constant entries keep their
    // static head positions; constant atDepth entries hoist (upstream stage).
    if (opts.caching?.appendOnly) {
      const constantOnly = (items: typeof wiResult.before) => items.filter((i) => i.entry.constant);
      const totalBefore =
        wiResult.before.length + wiResult.after.length + wiResult.top.length + wiResult.bottom.length + wiResult.atDepth.length;
      wiResult.before = constantOnly(wiResult.before);
      wiResult.after = constantOnly(wiResult.after);
      wiResult.top = constantOnly(wiResult.top);
      wiResult.bottom = constantOnly(wiResult.bottom);
      wiResult.atDepth = constantOnly(wiResult.atDepth);
      const totalAfter =
        wiResult.before.length + wiResult.after.length + wiResult.top.length + wiResult.bottom.length + wiResult.atDepth.length;
      if (totalAfter < totalBefore) result.excludedNonConstant = true;
      result.activatedEntryIds = wiResult.activatedEntryIds.filter((id) =>
        entries.some((e) => e.id === id && e.constant),
      );
    } else {
      result.activatedEntryIds = wiResult.activatedEntryIds;
    }
    result.before = wiResult.before.map((i) => i.entry.content).join(PROMPT_SEPARATOR);
    result.after = wiResult.after.map((i) => i.entry.content).join(PROMPT_SEPARATOR);
    // Include top/bottom entries alongside before/after (they were previously dropped).
    const topContent = wiResult.top.map((i) => i.entry.content).join(PROMPT_SEPARATOR);
    const bottomContent = wiResult.bottom.map((i) => i.entry.content).join(PROMPT_SEPARATOR);
    if (topContent) result.before = (result.before ? result.before + PROMPT_SEPARATOR : '') + topContent;
    if (bottomContent) result.after = (result.after ? result.after + PROMPT_SEPARATOR : '') + bottomContent;
    result.atDepthEntries = wiResult.atDepth.map((i) => i.entry);
    return result;
  }

  /** Stage: apply prompt-only regex rules to chat history (per-message role filtering). @internal */
  async applyPromptRegexRules(chatHistory: Message[], regexRules: RegexRule[] | undefined): Promise<Message[]> {
    if (!regexRules || regexRules.length === 0) return chatHistory;
    return Promise.all(
      chatHistory.map(async (msg) => {
        const promptRules = filterRulesByRole(regexRules, 'prompt', msg.role);
        if (promptRules.length === 0) return msg;
        const parts = msg.extra.parts ?? [];
        let changed = false;
        const newParts = await Promise.all(parts.map(async (p) => {
          if (p.type !== 'text') return p;
          const processed = await applyRules(p.text, promptRules);
          if (processed !== p.text) changed = true;
          return { ...p, text: processed };
        }));
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- TS does not track mutation across async closures
        if (!changed) return msg;
        return { ...msg, extra: { ...msg.extra, parts: newParts } };
      }),
    );
  }

  /**
   * Stage: splice the Author's Note into chat history when its position is
   * 'in_chat' and it fires this generation (per the interval, counted over
   * the visible — pre-regex — history).
   * @internal
   */
  spliceAuthorsNote(
    chatHistory: Message[],
    authorsNote: AuthorsNoteConfig | null | undefined,
    visibleHistory: Message[],
    macroCtx: MacroContext,
    appendOnly = false,
  ): AuthorsNoteSpliceResult {
    const result: AuthorsNoteSpliceResult = { chatHistory, content: '', inChat: false };
    if (!authorsNote || !authorsNote.content || authorsNote.interval === 0) {
      return result;
    }

    const userMessageCount = visibleHistory.filter((m) => m.role === 'user').length;
    if (authorsNote.interval !== 1 && (userMessageCount === 0 || userMessageCount % authorsNote.interval !== 0)) {
      return result;
    }

    // Append-only: macros are off wholesale — the note's raw text renders literally.
    const resolved = appendOnly
      ? authorsNote.content.trim()
      : this.macroResolver.resolve(authorsNote.content, macroCtx).trim();
    if (!resolved) return result;

    if (appendOnly && authorsNote.position === 'in_chat') {
      // No mid-history splice: hoist to the pinned block (the caller emits it);
      // content stays empty so the authorsNoteSlot stage doesn't double-fire.
      result.hoistedText = resolved;
      return result;
    }

    result.content = resolved;
    if (authorsNote.position === 'in_chat') {
      result.inChat = true;
      result.chatHistory = this.insertAtDepth(
        chatHistory,
        this.makeSyntheticMessage(authorsNote.role, resolved),
        authorsNote.depth,
      );
    }
    return result;
  }

  /** Stage: inject atDepth World Info entries as synthetic messages. @internal */
  spliceAtDepthWorldInfo(
    chatHistory: Message[],
    atDepthEntries: WorldInfoEntry[],
    macroCtx: MacroContext,
  ): Message[] {
    for (const entry of atDepthEntries) {
      const resolved = this.macroResolver.resolve(entry.content, macroCtx).trim();
      if (!resolved) continue;
      chatHistory = this.insertAtDepth(
        chatHistory,
        this.makeSyntheticMessage(entry.role ?? 'system', resolved),
        entry.depth ?? 0,
      );
    }
    return chatHistory;
  }

  /** Stage: inject the rolling memory summary before chat history. @internal */
  prependMemorySummary(chatHistory: Message[], memorySummary: MemorySummary | null | undefined): Message[] {
    if (!memorySummary?.summaryText) return chatHistory;
    const memoryMsg: Message = {
      id: -2,
      role: 'system',
      extra: { parts: [{ type: 'text', text: memorySummary.summaryText }] },
      createdAt: 0,
      updatedAt: 0,
      parentId: null,
    };
    return [memoryMsg, ...chatHistory];
  }

  /** Create a synthetic message spliced into the prompt (never persisted). */
  private makeSyntheticMessage(role: Message['role'], text: string): Message {
    return {
      id: -1,
      role,
      extra: { parts: [{ type: 'text', text }] },
      createdAt: 0,
      updatedAt: 0,
      parentId: null,
    };
  }

  /** Insert a message at `depth` messages from the end of the history. */
  private insertAtDepth(chatHistory: Message[], msg: Message, depth: number): Message[] {
    const insertIndex = Math.max(0, chatHistory.length - Math.max(0, depth));
    return [...chatHistory.slice(0, insertIndex), msg, ...chatHistory.slice(insertIndex)];
  }

  /**
   * Compute the optimal cache depth for prompt caching.
   * Returns `undefined` when caching should be disabled (off mode,
   * non-deterministic macros detected, or dynamic WI entries present).
   * @internal
   */
  computeCacheDepth(
    opts: BuildOptions,
    promptManager: PromptManager,
    authorsNoteInChat: boolean,
  ): number | undefined {
    const mode = opts.caching?.mode ?? 'off';
    if (mode === 'off') return undefined;

    // Scan for non-deterministic macros that would make caching wasteful
    if (this.hasNondeterministicMacros(opts)) {
      return undefined;
    }

    // Disable caching if any non-constant WI entries are in static positions
    // (before_char/after_char/top/bottom). These inject into the system prompt
    // and change the cache prefix every turn. atDepth entries are fine — their
    // depth is factored into the calculation below.
    if (opts.worldInfo?.entries?.some((e) => e.position !== 'atDepth' && !e.constant)) {
      return undefined;
    }

    if (mode === 'manual') {
      const depth = opts.caching?.manualDepth;
      return typeof depth === 'number' && depth >= 0 ? depth : undefined;
    }

    // Auto mode: compute from max injection depth + safety margin
    let maxInjectionDepth = 0;

    // Author's Note in_chat depth
    const authorsNote = opts.prompts?.authorsNote;
    if (authorsNoteInChat && authorsNote && authorsNote.depth > 0) {
      maxInjectionDepth = Math.max(maxInjectionDepth, authorsNote.depth);
    }

    // World Info atDepth entries
    if (opts.worldInfo?.entries) {
      for (const entry of opts.worldInfo.entries) {
        if (entry.position === 'atDepth' && typeof entry.depth === 'number') {
          maxInjectionDepth = Math.max(maxInjectionDepth, entry.depth);
        }
      }
    }

    // Preset prompts with absolute depth
    for (const prompt of promptManager.getOrderedPrompts()) {
      if (prompt.enabled && prompt.injectionPosition === 'absolute' && typeof prompt.injectionDepth === 'number') {
        maxInjectionDepth = Math.max(maxInjectionDepth, prompt.injectionDepth);
      }
    }

    // Safety margin: +2 to clear recent injections + new user message + prefill
    const cacheDepth = maxInjectionDepth + 2;
    return cacheDepth;
  }

  /**
   * Scan character, persona, WI, preset prompts, and Author's Note for
   * non-deterministic macros. If any are found, prompt caching is disabled
   * for this generation to avoid paying write premiums with zero reads.
   */
  private hasNondeterministicMacros(opts: BuildOptions): boolean {
    const sources: string[] = [];

    // Character fields
    if (opts.character) {
      sources.push(
        opts.character.description,
        opts.character.personality,
        opts.character.scenario,
        opts.character.firstMes,
        opts.character.mesExample,
        opts.character.systemPrompt,
        opts.character.postHistoryInstructions,
        opts.character.creatorNotes,
      );
    }

    // Persona
    if (opts.personaDescription) {
      sources.push(opts.personaDescription);
    }

    // Author's Note
    if (opts.prompts?.authorsNote?.content) {
      sources.push(opts.prompts.authorsNote.content);
    }

    // World Info entries
    if (opts.worldInfo?.entries) {
      for (const entry of opts.worldInfo.entries) {
        sources.push(entry.content);
      }
    }

    // Preset prompts
    if (opts.prompts?.presetPrompts) {
      for (const prompt of opts.prompts.presetPrompts) {
        if (prompt.content) sources.push(prompt.content);
      }
    }

    for (const text of sources) {
      if (!text) continue;
      if (this.macroResolver.hasNondeterministicMacros(text)) {
        return true;
      }
    }

    return false;
  }
}
