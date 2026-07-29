/**
 * Prompt pipeline orchestrator.
 *
 * Assembles the final prompt sent to backend adapters.
 * Uses PromptManager + a PromptRenderer to build prompts for either
 * chat-completion or text-completion backends.
 */

import { getMessageText } from '@tamari/types';
import type { Message, Character, WorldInfoEntry, MemorySummary } from '@tamari/types';
import type { Prompt } from '../backends/BackendAdapter.js';
import type { WorldInfoInjector } from './WorldInfoInjector.js';
import { MacroResolver, type MacroContext } from './MacroResolver.js';
import { applyRules, filterRulesByRole } from '../services/RegexEngine.js';
import { PromptManager, type PromptDef, type PromptOrderEntry } from './PromptManager.js';
import { ChatCompletionRenderer } from './renderers/ChatCompletionRenderer.js';
import { TextCompletionRenderer } from './renderers/TextCompletionRenderer.js';
import { getInstructTemplate, type InstructTemplate } from './renderers/InstructTemplate.js';
import { PROMPT_SEPARATOR, type RenderOptions, type PromptCollection } from './renderers/Renderer.js';
import type { RegexRule } from '@tamari/types';
import { TokenCounter, type ITokenCounter } from '../tokenizers/TokenCounter.js';
import type { BackendToolDefinition } from '../services/ToolRegistry.js';
import { ExampleBuilder } from './ExampleBuilder.js';

/** Fraction of the total context window reserved for World Info injections. */
const WI_CONTEXT_BUDGET_FRACTION = 0.25;

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
  /** Backend mode: 'chat' or 'text' */
  mode?: 'chat' | 'text';
  /** Instruct template name for text-completion mode */
  instructTemplate?: string;
  /** User-defined instruct templates (keyed by template ID) */
  customInstructTemplates?: Record<string, InstructTemplate>;
  /** Impersonation system prompt (injected when generating as the user) */
  impersonatePrompt?: string;
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
    /** Runtime prompt injections (from /inject or Lua st.inject). Spliced as
     * synthetic system messages at depth 0 (near the end of context). */
    injections?: string[];
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
    lastGenerationType?: string;
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
  };
}

/** Result of the World Info scan stage. */
interface WorldInfoScanResult {
  before: string;
  after: string;
  atDepthEntries: WorldInfoEntry[];
  activatedEntryIds: string[] | undefined;
}

/** Result of the Author's Note in-chat splice stage. */
interface AuthorsNoteSpliceResult {
  chatHistory: Message[];
  /** Resolved AN content (empty when inactive this generation). */
  content: string;
  /** True when the AN was spliced into chat history (in_chat position). */
  inChat: boolean;
}

export class PromptBuilder {
  private macroResolver: MacroResolver;
  private chatRenderer: ChatCompletionRenderer;
  private exampleBuilder: ExampleBuilder;

  constructor(private worldInfo?: WorldInfoInjector) {
    this.macroResolver = MacroResolver.createPromptResolver();
    this.chatRenderer = new ChatCompletionRenderer();
    this.exampleBuilder = new ExampleBuilder();
  }

  async build(opts: BuildOptions): Promise<Prompt> {
    // Hidden messages are display-only in the UI — they never reach the prompt
    // (macro context, WI scanning, or history). Snapshots still include them
    // so the client's show-hidden toggle keeps working.
    const visibleHistory = opts.chatHistory.filter((m) => !m.extra.hidden);

    const macroCtx: MacroContext = {
      userName: opts.userName,
      charName: opts.character?.name ?? 'Character',
      description: opts.character?.description,
      personality: opts.character?.personality,
      scenario: opts.character?.scenario,
      persona: opts.personaDescription,
      model: opts.model,
      maxContext: opts.maxContext,
      maxResponse: opts.maxResponseTokens,
      messages: visibleHistory.map((m) => ({ id: m.id, role: m.role, content: getMessageText(m.extra.parts) })),
      lastGenerationType: opts.macro?.lastGenerationType,
      extensions: opts.macro?.extensions,
      macroVars: opts.macro?.vars,
      globalVars: opts.macro?.globalVars,
      characterAssets: opts.macro?.characterAssets,
    };

    // Create a model-aware token counter for this generation
    const tokenCounter = new TokenCounter(opts.model);

    // Prepare world info strings and atDepth injections
    const wi = this.scanWorldInfo(opts, visibleHistory, macroCtx, tokenCounter);

    // Build prompt manager with defaults or preset overrides
    const promptManager = new PromptManager(opts.prompts?.presetPrompts, opts.prompts?.presetPromptOrder);

    // Apply character card overrides
    if (opts.prompts?.systemPromptOverride) {
      promptManager.applyOverride('main', opts.prompts.systemPromptOverride);
    }
    if (opts.prompts?.jailbreakOverride) {
      promptManager.applyOverride('jailbreak', opts.prompts.jailbreakOverride);
    }

    // Inject impersonation prompt if provided
    if (opts.impersonatePrompt) {
      promptManager.injectPrompt({
        identifier: 'impersonate',
        name: 'Impersonate',
        content: opts.impersonatePrompt,
        role: 'system',
        enabled: true,
        systemPrompt: true,
        marker: false,
      });
    }

    // History splice stages run in a fixed order: each stage receives the
    // history produced by the previous one, and insertion depths are computed
    // against that already-spliced history. The ordering is load-bearing.
    let chatHistory = await this.applyPromptRegexRules(visibleHistory, opts.regexRules);
    const an = this.spliceAuthorsNote(chatHistory, opts.prompts?.authorsNote, visibleHistory, macroCtx);
    chatHistory = an.chatHistory;
    chatHistory = this.spliceAtDepthWorldInfo(chatHistory, wi.atDepthEntries, macroCtx);
    chatHistory = this.appendRuntimeInjections(chatHistory, opts.prompts?.injections, macroCtx);
    chatHistory = this.prependMemorySummary(chatHistory, opts.memorySummary);

    // Inject Author's Note as a system prompt for before/after positions
    if (an.content && !an.inChat && opts.prompts?.authorsNote) {
      const authorsNote = opts.prompts.authorsNote;
      promptManager.injectPrompt({
        identifier: 'authorsNote',
        name: "Author's Note",
        content: authorsNote.content,
        role: authorsNote.role === 'assistant' ? 'assistant' : 'system',
        enabled: true,
        systemPrompt: true,
        marker: false,
      });
      if (authorsNote.position === 'before_prompt') {
        const entries = promptManager.getOrder().filter((e) => e.identifier !== 'authorsNote');
        entries.unshift({ identifier: 'authorsNote', enabled: true });
        promptManager.setOrder(entries);
      }
    }

    // Parse dialogue examples from character card
    const dialogueExamples = opts.prompts?.stripExamples
      ? []
      : opts.character?.mesExample
        ? this.exampleBuilder.build(opts.character.mesExample)
        : [];

    // Build the collection
    const collection: PromptCollection = {
      prompts: promptManager.getOrderedPrompts(),
      markers: {
        charDescription: opts.character?.description ?? '',
        charPersonality: opts.character?.personality ?? '',
        scenario: opts.character?.scenario ?? '',
        personaDescription: opts.personaDescription ?? '',
        worldInfoBefore: wi.before,
        worldInfoAfter: wi.after,
      },
      dialogueExamples,
    };

    // Compute cache depth and check for non-deterministic macros
    const cacheDepth = this.computeCacheDepth(opts, promptManager, an.inChat);

    const renderOpts: RenderOptions = {
      macroResolver: this.macroResolver,
      macroCtx,
      tokenCounter,
      chatHistory,
      maxContext: opts.maxContext,
      maxResponseTokens: opts.maxResponseTokens,
      model: opts.model,
      impersonateMode: !!opts.impersonatePrompt,
      reasoningAddToPrompts: opts.reasoningAddToPrompts,
      supportsImages: opts.media?.supportsImages ?? true,
      supportsAudio: opts.media?.supportsAudio ?? true,
      supportsVideo: opts.media?.supportsVideo ?? true,
      mediaVerboseMode: opts.media?.verboseMode,
    };

    const params: Record<string, unknown> = {};
    if (opts.stopStrings && opts.stopStrings.length > 0) {
      params.stop = opts.stopStrings;
    }

    // Pick renderer based on mode
    const mode = opts.mode ?? 'chat';

    const tools = opts.toolDefinitions && opts.toolDefinitions.length > 0
      ? opts.toolDefinitions
      : undefined;

    if (mode === 'text') {
      const template = getInstructTemplate(opts.instructTemplate, opts.customInstructTemplates);
      const renderer = new TextCompletionRenderer(template);
      const result = renderer.render(collection, renderOpts);
      return {
        messages: [], // text adapters use prompt.text
        text: result.text,
        tokenUsage: result.tokenUsage,
        params,
        cacheDepth,
        reasoning: template.reasoning,
        tools,
        wiActivations: wi.activatedEntryIds,
      };
    }

    const result = this.chatRenderer.render(collection, renderOpts);
    return {
      messages: result.messages,
      tokenUsage: result.tokenUsage,
      params,
      cacheDepth,
      tools,
      wiActivations: wi.activatedEntryIds,
    };
  }

  // -------------------------------------------------------------------------
  // History splice stages (called from build() in the order declared below)
  // -------------------------------------------------------------------------

  /**
   * Stage: scan World Info entries against the macro-resolved history.
   * Returns the before/after prompt strings, atDepth entries, and the IDs of
   * entries that activated this turn.
   */
  private scanWorldInfo(
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

    const wiBudget = Math.round(opts.maxContext * WI_CONTEXT_BUDGET_FRACTION);
    // Resolve macros on a COPY of chat history so WI keyword matching works
    // against expanded names ({{char}} → Seraphina) without mutating originals
    const resolvedHistoryForWI = visibleHistory.map((msg) => ({
      ...msg,
      content: this.macroResolver.resolve(getMessageText(msg.extra.parts), macroCtx),
    }));
    const wiResult = this.worldInfo.scan({
      entries,
      chatHistory: resolvedHistoryForWI,
      budget: wiBudget,
      tokenCounter,
      semanticMatches: opts.worldInfo?.semanticMatches,
    });
    result.before = wiResult.before.map((i) => i.entry.content).join(PROMPT_SEPARATOR);
    result.after = wiResult.after.map((i) => i.entry.content).join(PROMPT_SEPARATOR);
    // Include top/bottom entries alongside before/after (they were previously dropped).
    const topContent = wiResult.top.map((i) => i.entry.content).join(PROMPT_SEPARATOR);
    const bottomContent = wiResult.bottom.map((i) => i.entry.content).join(PROMPT_SEPARATOR);
    if (topContent) result.before = (result.before ? result.before + PROMPT_SEPARATOR : '') + topContent;
    if (bottomContent) result.after = (result.after ? result.after + PROMPT_SEPARATOR : '') + bottomContent;
    result.atDepthEntries = wiResult.atDepth.map((i) => i.entry);
    result.activatedEntryIds = wiResult.activatedEntryIds;
    return result;
  }

  /** Stage: apply prompt-only regex rules to chat history (per-message role filtering). */
  private async applyPromptRegexRules(chatHistory: Message[], regexRules: RegexRule[] | undefined): Promise<Message[]> {
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
   */
  private spliceAuthorsNote(
    chatHistory: Message[],
    authorsNote: AuthorsNoteConfig | null | undefined,
    visibleHistory: Message[],
    macroCtx: MacroContext,
  ): AuthorsNoteSpliceResult {
    const result: AuthorsNoteSpliceResult = { chatHistory, content: '', inChat: false };
    if (!authorsNote || !authorsNote.content || authorsNote.interval === 0) {
      return result;
    }

    const userMessageCount = visibleHistory.filter((m) => m.role === 'user').length;
    if (authorsNote.interval !== 1 && (userMessageCount === 0 || userMessageCount % authorsNote.interval !== 0)) {
      return result;
    }

    const resolved = this.macroResolver.resolve(authorsNote.content, macroCtx).trim();
    if (!resolved) return result;

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

  /** Stage: inject atDepth World Info entries as synthetic messages. */
  private spliceAtDepthWorldInfo(
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

  /**
   * Stage: inject runtime injections (from /inject or Lua st.inject) as
   * synthetic system messages at the end of context (depth 0).
   */
  private appendRuntimeInjections(
    chatHistory: Message[],
    injections: string[] | undefined,
    macroCtx: MacroContext,
  ): Message[] {
    if (!injections) return chatHistory;
    for (const injection of injections) {
      const text = this.macroResolver.resolve(injection, macroCtx).trim();
      if (!text) continue;
      chatHistory = [...chatHistory, this.makeSyntheticMessage('system', text)];
    }
    return chatHistory;
  }

  /** Stage: inject the rolling memory summary before chat history. */
  private prependMemorySummary(chatHistory: Message[], memorySummary: MemorySummary | null | undefined): Message[] {
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
   */
  private computeCacheDepth(
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
