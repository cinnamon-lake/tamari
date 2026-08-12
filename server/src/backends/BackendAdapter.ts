/**
 * Backend adapter interface for LLM APIs.
 *
 * Designed to accommodate OpenAI-compatible APIs, Claude, Gemini,
 * Cohere, text completions, and local backends (Kobold, Ollama, etc.).
 */

// ---------- Content parts / messages / prompt ----------
//
// These types are defined in @tamari/types (packages/types/src/pipeline.ts) so the
// WebSocket event protocol can reference them without a server → types
// dependency cycle. Re-exported here so adapters and pipeline code can keep
// importing them alongside the BackendAdapter interface.

import type { Prompt } from '@tamari/types';

export type {
  TextPart,
  ImagePart,
  AudioPart,
  VideoPart,
  ToolUsePart,
  ToolResultPart,
  ReasoningPart,
  BackendDebugPart,
  InlineContentPart,
  ContentPart,
  PipelineMessage,
  ToolDefinition,
  ResponseFormat,
  Prompt,
} from '@tamari/types';

// ---------- Streaming ----------

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ---------- Call context ----------

/** One message of the full (unbudgeted) branch history, for Lua backend scripts. */
export interface BranchHistoryMessage {
  id: string;
  role: string;
  content: string;
  characterId?: string;
  personaId?: string;
}

/**
 * Optional context about the generation call, passed to adapters that care
 * (currently only LuaBackendAdapter — custom backends expose it to the script
 * as `ctx`). Built-in adapters ignore it.
 */
export interface BackendCallContext {
  chatId?: string;
  characterId?: string;
  /** 'normal' | 'regenerate' | 'continue' | 'impersonate' | 'quiet' | … */
  generationType?: string;
  /**
   * Latest branch-aware script state snapshot (raw string, from
   * `message.extra._toolState[backend.id]`) for stateful custom backends.
   * Scanned by GenerationRunner over the full branch; consumed only by
   * LuaBackendAdapter.
   */
  scriptState?: string;
  /**
   * Lazy loader for the FULL branch history (unbounded by promptHistoryLimit /
   * chatTruncation / the token budget) — exposed to Lua scripts as the `chat`
   * global. Absent when there is no branch (dry-run without canned history,
   * non-chat targets). Supplied by GenerationRunner; consumed only by
   * LuaBackendAdapter; the loader runs at most once per call when scripts use it.
   */
  branchHistory?: () => Promise<BranchHistoryMessage[]>;
}

// ---------- Streaming ----------

export interface TextStreamItem {
  type: 'text';
  token: string;
}

export interface ReasoningStreamItem {
  type: 'reasoning';
  token: string;
}

export interface ReasoningSignatureStreamItem {
  type: 'reasoningSignature';
  signature: string;
}

export interface ToolCallStreamItem {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Captured `print(...)` output from a custom (Lua) backend, one chunk per
    drained line. Accumulates into a `backend_debug` part — never dialogue. */
export interface BackendDebugStreamItem {
  type: 'backendDebug';
  token: string;
}

export type BackendStreamItem =
  | TextStreamItem
  | ReasoningStreamItem
  | ReasoningSignatureStreamItem
  | ToolCallStreamItem
  | BackendDebugStreamItem;

/** Consume an async generator stream, collecting all yielded items and the final return value. */
export async function consumeStream<T, R>(gen: AsyncGenerator<T, R>): Promise<{ items: T[]; result: R }> {
  const items: T[] = [];
  let next = await gen.next();
  while (!next.done) {
    items.push(next.value);
    next = await gen.next();
  }
  return { items, result: next.value };
}

// ---------- Result ----------

export type { TraceError, TraceErrorCode } from '@tamari/types';
import type { TraceError } from '@tamari/types';

export interface GenerationResult {
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
  usage: { promptTokens: number; completionTokens: number };
  error?: string;
  /** Structured form of `error` for debug traces. Absent on success and from
      adapters that haven't adopted tracing (treated as UNKNOWN at backend.id). */
  traceError?: TraceError;
  /** Reasoning / thinking text extracted from models that emit it separately (Claude, DeepSeek, etc.). */
  reasoningText?: string;
  /** Provider-specific reasoning signature (e.g. Claude redacted-thinking signature). */
  reasoningSignature?: string;
  /** Tool calls extracted from the model's response. */
  toolCalls?: ToolCall[];
  /**
   * New script-state snapshot from a stateful custom backend, to be persisted
   * at `message.extra._toolState[backend.id]` by the caller. Absent on errors
   * (a failed turn must not corrupt the last good state).
   */
  scriptState?: string;
}

// ---------- Model listing ----------

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  description?: string;
}

// ---------- Adapter ----------

export interface BackendAdapter {
  readonly id: string;
  readonly supportsStreaming: boolean;
  readonly supportsTools: boolean;

  stream(prompt: Prompt, signal: AbortSignal, ctx?: BackendCallContext): AsyncGenerator<BackendStreamItem, GenerationResult>;

  /**
   * Build the HTTP request this adapter would send for a prompt, without
   * sending it (and without applying the request script). Used by tooling
   * that dry-runs request scripts. Optional — adapters without a single
   * request-building step may omit it.
   */
  buildRequest?(prompt: Prompt): { url: string; init: RequestInit };

  /**
   * List available models from the provider.
   *
   * Semantics are adapter-specific by design:
   * - Providers with a listing endpoint fetch it live and **throw** on
   *   HTTP/parse failure, so the API layer can surface a 502 (OpenAI, Claude,
   *   OpenRouter).
   * - Adapters with a curated static fallback return it when the live fetch
   *   fails, keeping the UI usable with an invalid key or offline proxy
   *   (Gemini, Moonshot).
   * - Local servers frequently expose no `/models` route, so their adapters
   *   swallow failures and return [] (TextCompletion, LlamaCpp).
   * - Providers with no listing capability at all return [] (KoboldCpp).
   */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}
