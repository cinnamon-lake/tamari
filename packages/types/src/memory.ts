/**
 * Memory / summarization types for tamari.
 */

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
  /** System prompt for the summarization LLM call. */
  systemPrompt: string;
  /** Target maximum tokens for the summary output. */
  maxSummaryTokens: number;
}
