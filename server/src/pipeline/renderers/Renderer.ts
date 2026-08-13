/**
 * Shared renderer interfaces for the unified prompt pipeline.
 *
 * One PromptCollection → multiple renderers → chat-completion messages
 * or text-completion string.
 */

import type { Message } from '@tamari/types';
import type { PromptDef } from '../PromptManager.js';
import type { MacroContext, MacroResolver } from '../MacroResolver.js';
import type { PipelineMessage } from '../../backends/BackendAdapter.js';
import type { ITokenCounter } from '../../tokenizers/TokenCounter.js';

/** Separator used when joining adjacent prompt chunks. */
export const PROMPT_SEPARATOR = '\n\n';

export interface RenderOptions {
  macroResolver: MacroResolver;
  macroCtx: MacroContext;
  tokenCounter: ITokenCounter;
  chatHistory: Message[];
  maxContext: number;
  maxResponseTokens: number;
  model?: string;
  /** Whether to include past reasoning blocks in prompt context */
  reasoningAddToPrompts?: boolean;
  /** Media types supported by the active backend */
  supportsImages?: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  /** When true, replace media attachments with text placeholders */
  mediaVerboseMode?: boolean;
  /**
   * Append-only layout (docs/design/append-only-caching.md): history renders
   * verbatim, absolute-depth prompts hoist into the pinned volatile block
   * instead of splicing mid-history, and `volatileBlock` (author's note,
   * constant atDepth WI — raw text, deterministic order) is emitted as one
   * synthetic system message right after the prompt-list head.
   */
  appendOnly?: boolean;
  volatileBlock?: string[];
}

export interface ExampleMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PromptCollection {
  prompts: PromptDef[];
  /** Runtime data for marker prompts */
  markers: Record<string, string>;
  /** Parsed dialogue examples from character card mesExample */
  dialogueExamples?: ExampleMessage[];
}

export interface ChatRenderResult {
  type: 'chat';
  messages: PipelineMessage[];
  tokenUsage: { prompt: number; completion: number };
}

export interface TextRenderResult {
  type: 'text';
  text: string;
  tokenUsage: { prompt: number; completion: number };
}

export type RenderResult = ChatRenderResult | TextRenderResult;

/**
 * A renderer turns one PromptCollection into a backend-ready prompt.
 *
 * Intentional implementation difference: absolute-position (depth-injected)
 * prompts are only honored by ChatCompletionRenderer, which splices them into
 * the chat history at their depth. TextCompletionRenderer skips them — see
 * the comment at the skip site for the rationale.
 */
export interface PromptRenderer {
  render(collection: PromptCollection, opts: RenderOptions): RenderResult;
}

/**
 * Token-budget authority for the renderers. The budget exists to decide how
 * much CHAT HISTORY fits — nothing else is gated on it. Preset prompts
 * (system prompts, examples, depth injections) always render in full; World
 * Info activation is governed by its own deterministic caps (scan depth,
 * recursion depth), not a token budget.
 */

/** Per-message framing overhead (role tokens etc.) charged on top of content. */
export const MESSAGE_OVERHEAD_TOKENS = 4;
/** Fudge reserve for wrapper tokens the counter can't see (template frame). */
export const FRAME_RESERVE_TOKENS = 3;

/** Usable prompt budget: context window minus the reserved completion. */
export function promptBudgetTotal(maxContext: number, maxResponseTokens: number): number {
  return maxContext - maxResponseTokens;
}

/**
 * Shared token budget used by both renderers. `reserve`/`spend` subtract from
 * the remaining total; `canAfford` checks without spending.
 */
export class TokenBudget {
  private remaining: number;

  constructor(total: number) {
    this.remaining = total;
  }

  reserve(amount: number): boolean {
    if (this.remaining < amount) return false;
    this.remaining -= amount;
    return true;
  }

  canAfford(amount: number): boolean {
    return this.remaining >= amount;
  }

  spend(amount: number): void {
    this.remaining -= amount;
  }
}
