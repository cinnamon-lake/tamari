/**
 * Pipeline / backend prompt types.
 *
 * These live in the types package so they can be referenced by the
 * WebSocket event protocol (e.g. prompt.announced) without creating
 * a server → types dependency cycle.
 */

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** Data URL (data:image/png;base64,...) or http URL */
  source: string;
  mimeType?: string;
  /** OpenAI image_url detail hint. */
  detail?: 'low' | 'high' | 'auto';
}

export interface AudioPart {
  type: 'audio';
  source: string;
  mimeType?: string;
}

export interface VideoPart {
  type: 'video';
  source: string;
  mimeType?: string;
}

export interface ToolUsePart {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolUseId: string;
  name?: string;
  content: string | InlineContentPart[];
  isError?: boolean;
  extra?: Record<string, unknown>;
}

export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  signature?: string;
}

/** Captured `print(...)` output from a custom (Lua) backend. Never part of the
    dialogue — getMessageText only surfaces text parts — but optionally shown
    on display as a collapsed debug block. */
export interface BackendDebugPart {
  type: 'backend_debug';
  text: string;
}

export type InlineContentPart = TextPart | ImagePart | AudioPart | VideoPart;

export type ContentPart =
  | TextPart
  | ImagePart
  | AudioPart
  | VideoPart
  | ToolUsePart
  | ToolResultPart
  | ReasoningPart
  | BackendDebugPart;

export interface PipelineMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  reasoningFormatted?: string;
}

/**
 * Structured error for debug traces (docs/design/debug-traces.md). Boundaries
 * WRAP, never flatten: each layer that catches an error it didn't produce adds
 * its own node with the inner one as `cause`. Lives in the types package so
 * `GenerationMeta` (db.ts) and server adapters share one definition.
 */
export type TraceErrorCode =
  | 'LUA_ERROR'
  | 'LUA_TIMEOUT'
  | 'DELEGATE_ERROR'
  | 'NO_BACKEND'
  | 'DEPTH_CAP'
  | 'ABORTED'
  | 'HTTP_ERROR'
  | 'UNKNOWN';

export interface TraceError {
  code: TraceErrorCode;
  /** The layer that produced this node: 'custom-backend(research)',
      'openai(gpt-4o)', 'run_agent', 'runner', … */
  layer: string;
  message: string;
  cause?: TraceError;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type ResponseFormat =
  { type: 'json_schema'; schema: Record<string, unknown> } | { type: 'json_object' } | { type: 'text' };

/**
 * The prompt handed to a backend adapter: always a message list.
 * Text-completion adapters flatten `messages` into a single prompt string
 * with their configured instruct template (server backends/formatTextPrompt).
 */
export interface Prompt {
  messages: PipelineMessage[];
  tokenUsage: { prompt: number; completion: number };
  systemPrompt?: string;
  tools?: ToolDefinition[];
  params?: Record<string, unknown>;
  responseFormat?: ResponseFormat;
  cacheDepth?: number;
  /**
   * IDs of World Info entries that triggered during this generation.
   * Stored in message extra for branch-aware sticky/cooldown/delay state.
   */
  wiActivations?: string[];
  /**
   * Append-only layout trace (docs/design/append-only-caching.md): which
   * features were suppressed and which volatile blocks were hoisted for this
   * prompt. Present only when appendOnlyPromptLayout is on; the runner copies
   * it into generations.meta.
   */
  appendOnlyTrace?: { suppressed: string[]; hoisted: string[] };
}
