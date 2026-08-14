/**
 * Shared renderer interfaces for the unified prompt pipeline.
 *
 * One PromptCollection → one renderer → chat-completion messages.
 * Text-completion adapters flatten those messages into a prompt string
 * themselves (server/src/backends/formatTextPrompt.ts) — the pipeline is
 * wire-format-agnostic.
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

/**
 * A renderer turns one PromptCollection into a backend-ready message list.
 *
 * Nothing here is gated on a token budget: every preset prompt and the whole
 * chat history render in full. History length is bounded upstream by the
 * promptHistoryLimit message-count limit; token counts
 * are only REPORTED (tokenUsage), never enforced.
 */
export interface PromptRenderer {
  render(collection: PromptCollection, opts: RenderOptions): ChatRenderResult;
}
