/**
 * PromptStages — the named, ordered stage list executed by PromptBuilder.
 *
 * The ~14 fixed steps of the legacy `PromptBuilder.build()` are DATA here:
 * each stage is a small object whose `run` wraps the corresponding
 * (behavior-critical, well-tested) PromptBuilder method in today's order.
 * The sequence is replaceable — construct `new PromptBuilder(worldInfo,
 * customStages)` with a splice of `createDefaultStages` to insert, reorder,
 * or drop stages. No registration framework; per-card/preset stages are
 * later work (docs/design/generation-runner.md, migration step 4).
 *
 * The shared mutable PromptContext mirrors exactly what build() threaded
 * through locals — no new state lifetimes. Stage-produced fields use
 * definite-assignment declarations: every stage may rely on its predecessors
 * in the DEFAULT order; custom stages must declare their own assumptions.
 */

import type { Message } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { Prompt } from '../backends/BackendAdapter.js';
import type { BuildOptions, WorldInfoScanResult, AuthorsNoteSpliceResult, AuthorsNoteConfig } from './PromptBuilder.js';
import { PromptManager } from './PromptManager.js';
import type { PromptCollection, RenderOptions } from './renderers/Renderer.js';
import type { MacroContext } from './MacroResolver.js';
import type { MacroResolver } from './MacroResolver.js';
import { TokenCounter, type ITokenCounter } from '../tokenizers/TokenCounter.js';
import type { ExampleMessage, ExampleBuilder } from './ExampleBuilder.js';
import type { ChatCompletionRenderer } from './renderers/ChatCompletionRenderer.js';
import { TextCompletionRenderer } from './renderers/TextCompletionRenderer.js';
import { getInstructTemplate } from './renderers/InstructTemplate.js';
import type { WorldInfoEntry, RegexRule, MemorySummary } from '@tamari/types';

/** The subset of PromptBuilder the stage closures call (all `@internal`). */
export interface PromptBuilderStageHost {
  readonly macroResolver: MacroResolver;
  readonly chatRenderer: ChatCompletionRenderer;
  readonly exampleBuilder: ExampleBuilder;
  scanWorldInfo(opts: BuildOptions, history: Message[], macroCtx: MacroContext, tokenCounter: ITokenCounter): WorldInfoScanResult;
  applyPromptRegexRules(history: Message[], rules: RegexRule[] | undefined): Promise<Message[]>;
  spliceAuthorsNote(
    history: Message[],
    authorsNote: AuthorsNoteConfig | null | undefined,
    visibleHistory: Message[],
    macroCtx: MacroContext,
  ): AuthorsNoteSpliceResult;
  spliceAtDepthWorldInfo(history: Message[], entries: WorldInfoEntry[], macroCtx: MacroContext): Message[];
  prependMemorySummary(history: Message[], memorySummary: MemorySummary | null | undefined): Message[];
  computeCacheDepth(opts: BuildOptions, promptManager: PromptManager, authorsNoteInChat: boolean): number | undefined;
}

/**
 * Shared mutable context threaded through the stage list — mirrors exactly
 * what the legacy build() threaded through locals. Stage-produced fields use
 * definite-assignment declarations: every stage may rely on its predecessors
 * in the DEFAULT order; custom stages must declare their own assumptions.
 */
export class PromptContext {
  readonly opts: BuildOptions;
  /** hiddenMessageFilter output: history minus hidden messages. */
  visibleHistory: Message[] = [];
  /** History as it evolves through the splice stages. */
  chatHistory: Message[] = [];
  macroCtx!: MacroContext;
  tokenCounter!: TokenCounter;
  wi!: WorldInfoScanResult;
  promptManager!: PromptManager;
  /** authorsNoteSplice output (content is empty when inactive this turn). */
  authorsNote: { content: string; inChat: boolean } = { content: '', inChat: false };
  dialogueExamples: ExampleMessage[] = [];
  collection!: PromptCollection;
  cacheDepth?: number;
  /** Set by the render stage (the only stage that must never be dropped). */
  result?: Prompt;

  constructor(opts: BuildOptions) {
    this.opts = opts;
  }
}

export interface PromptStage {
  readonly id: string;
  run(ctx: PromptContext): Promise<void> | void;
}

/**
 * The default stage sequence — today's build() order, verbatim. The history
 * splice ordering (historyRegex → authorsNoteSplice → worldInfoAtDepth →
 * memorySummary) is load-bearing: each stage receives the history produced
 * by the previous one, and insertion depths are computed against it.
 */
export function createDefaultStages(host: PromptBuilderStageHost): PromptStage[] {
  return [
    {
      id: 'hiddenMessageFilter',
      run(ctx) {
        // Hidden messages are display-only in the UI — they never reach the
        // prompt (macro context, WI scanning, or history). Snapshots still
        // include them so the client's show-hidden toggle keeps working.
        ctx.visibleHistory = ctx.opts.chatHistory.filter((m) => !m.extra.hidden);
      },
    },
    {
      id: 'macroContext',
      run(ctx) {
        const { opts } = ctx;
        ctx.macroCtx = {
          userName: opts.userName,
          charName: opts.character?.name ?? 'Character',
          description: opts.character?.description,
          personality: opts.character?.personality,
          scenario: opts.character?.scenario,
          persona: opts.personaDescription,
          model: opts.model,
          maxContext: opts.maxContext,
          maxResponse: opts.maxResponseTokens,
          messages: ctx.visibleHistory.map((m) => ({ id: m.id, role: m.role, content: getMessageText(m.extra.parts) })),
          lastGenerationType: opts.macro?.lastGenerationType,
          extensions: opts.macro?.extensions,
          macroVars: opts.macro?.vars,
          globalVars: opts.macro?.globalVars,
          characterAssets: opts.macro?.characterAssets,
        };
      },
    },
    {
      id: 'tokenCounter',
      run(ctx) {
        // Create a model-aware token counter for this generation
        ctx.tokenCounter = new TokenCounter(ctx.opts.model);
      },
    },
    {
      id: 'worldInfo',
      run(ctx) {
        // Prepare world info strings and atDepth injections
        ctx.wi = host.scanWorldInfo(ctx.opts, ctx.visibleHistory, ctx.macroCtx, ctx.tokenCounter);
      },
    },
    {
      id: 'promptSlots',
      run(ctx) {
        const { opts } = ctx;
        // Build prompt manager with defaults or preset overrides
        ctx.promptManager = new PromptManager(opts.prompts?.presetPrompts, opts.prompts?.presetPromptOrder);

        // Apply character card overrides
        if (opts.prompts?.systemPromptOverride) {
          ctx.promptManager.applyOverride('main', opts.prompts.systemPromptOverride);
        }
        if (opts.prompts?.jailbreakOverride) {
          ctx.promptManager.applyOverride('jailbreak', opts.prompts.jailbreakOverride);
        }

        // Inject impersonation prompt if provided
        if (opts.impersonatePrompt) {
          ctx.promptManager.injectPrompt({
            identifier: 'impersonate',
            name: 'Impersonate',
            content: opts.impersonatePrompt,
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          });
        }
      },
    },
    {
      id: 'historyRegex',
      async run(ctx) {
        ctx.chatHistory = await host.applyPromptRegexRules(ctx.visibleHistory, ctx.opts.regexRules);
      },
    },
    {
      id: 'authorsNoteSplice',
      run(ctx) {
        const an = host.spliceAuthorsNote(ctx.chatHistory, ctx.opts.prompts?.authorsNote, ctx.visibleHistory, ctx.macroCtx);
        ctx.chatHistory = an.chatHistory;
        ctx.authorsNote = { content: an.content, inChat: an.inChat };
      },
    },
    {
      id: 'worldInfoAtDepth',
      run(ctx) {
        ctx.chatHistory = host.spliceAtDepthWorldInfo(ctx.chatHistory, ctx.wi.atDepthEntries, ctx.macroCtx);
      },
    },
    {
      id: 'memorySummary',
      run(ctx) {
        ctx.chatHistory = host.prependMemorySummary(ctx.chatHistory, ctx.opts.memorySummary);
      },
    },
    {
      id: 'authorsNoteSlot',
      run(ctx) {
        const { opts } = ctx;
        // Inject Author's Note as a system prompt for before/after positions
        if (ctx.authorsNote.content && !ctx.authorsNote.inChat && opts.prompts?.authorsNote) {
          const authorsNote = opts.prompts.authorsNote;
          ctx.promptManager.injectPrompt({
            identifier: 'authorsNote',
            name: "Author's Note",
            content: authorsNote.content,
            role: authorsNote.role === 'assistant' ? 'assistant' : 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          });
          if (authorsNote.position === 'before_prompt') {
            const entries = ctx.promptManager.getOrder().filter((e) => e.identifier !== 'authorsNote');
            entries.unshift({ identifier: 'authorsNote', enabled: true });
            ctx.promptManager.setOrder(entries);
          }
        }
      },
    },
    {
      id: 'dialogueExamples',
      run(ctx) {
        const { opts } = ctx;
        // Parse dialogue examples from character card
        ctx.dialogueExamples = opts.prompts?.stripExamples
          ? []
          : opts.character?.mesExample
            ? host.exampleBuilder.build(opts.character.mesExample)
            : [];
      },
    },
    {
      id: 'collection',
      run(ctx) {
        const { opts } = ctx;
        // Build the collection
        ctx.collection = {
          prompts: ctx.promptManager.getOrderedPrompts(),
          markers: {
            charDescription: opts.character?.description ?? '',
            charPersonality: opts.character?.personality ?? '',
            scenario: opts.character?.scenario ?? '',
            personaDescription: opts.personaDescription ?? '',
            worldInfoBefore: ctx.wi.before,
            worldInfoAfter: ctx.wi.after,
          },
          dialogueExamples: ctx.dialogueExamples,
        };
      },
    },
    {
      id: 'cacheDepth',
      run(ctx) {
        // Compute cache depth and check for non-deterministic macros
        ctx.cacheDepth = host.computeCacheDepth(ctx.opts, ctx.promptManager, ctx.authorsNote.inChat);
      },
    },
    {
      id: 'render',
      run(ctx) {
        const { opts } = ctx;
        const renderOpts: RenderOptions = {
          macroResolver: host.macroResolver,
          macroCtx: ctx.macroCtx,
          tokenCounter: ctx.tokenCounter,
          chatHistory: ctx.chatHistory,
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
          const result = renderer.render(ctx.collection, renderOpts);
          ctx.result = {
            messages: [], // text adapters use prompt.text
            text: result.text,
            tokenUsage: result.tokenUsage,
            params,
            cacheDepth: ctx.cacheDepth,
            reasoning: template.reasoning,
            tools,
            wiActivations: ctx.wi.activatedEntryIds,
          };
          return;
        }

        const result = host.chatRenderer.render(ctx.collection, renderOpts);
        ctx.result = {
          messages: result.messages,
          tokenUsage: result.tokenUsage,
          params,
          cacheDepth: ctx.cacheDepth,
          tools,
          wiActivations: ctx.wi.activatedEntryIds,
        };
      },
    },
  ];
}
