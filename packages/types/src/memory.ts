/**
 * Memory / summarization types for tamari.
 */

/**
 * Default system prompt for the summarization LLM call. Lives in the active
 * prompt list as the builtin `memorySummary` utility prompt (editable per
 * list); this is the fallback when the list or prompt is missing.
 */
export const DEFAULT_MEMORY_SUMMARY_PROMPT =
  'Summarize the most important facts and events in the story so far. For each event, include a citation to the message ID(s) it came from using [msg:ID] format. Be concise.';

export interface MemorySummary {
  /** The rolling summary text, containing inline [msg:ID] citations. */
  summaryText: string;
  /** Structured citations parsed from the summary text. */
  citations: MemoryCitation[];
  /** The message ID this summary is anchored to (newest summarized user message). */
  anchoredMessageId: number;
}

export interface MemoryCitation {
  /** The summarized event description. */
  event: string;
  /** Message IDs the event is cited from. */
  messageIds: number[];
}

export interface MemorySettings {
  /** Whether the rolling memory system is enabled. */
  enabled: boolean;
  /** Number of user messages between automatic summary updates. */
  updateInterval: number;
  /** Guaranteed number of recent messages kept verbatim before summarization. */
  depth: number;
  /** Optional backend config ID to use for summarization. Empty = active chat backend. */
  backendConfigId: string;
  /** Target maximum tokens for the summary output. */
  maxSummaryTokens: number;
}
