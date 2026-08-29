/**
 * Shared SSE line/event reader for streaming backend adapters.
 *
 * OpenAI-, Claude- and Gemini-style providers all frame their streaming
 * responses the same way: `data: <payload>` lines (optionally preceded by
 * `event: <type>` lines), a `[DONE]` sentinel, and byte chunks that may
 * split a line anywhere. This reader owns that framing — chunked reads,
 * partial lines across chunks, prefix stripping — so adapters only parse
 * the per-provider payloads.
 */

export type SseStreamItem =
  | {
      type: 'event';
      /** Payload of a `data:` line (prefix stripped, leading whitespace trimmed). */
      data: string;
      /** The trimmed raw line, kept for malformed-line logging. */
      line: string;
      /**
       * Value of the most recent `event:` line within the same read chunk,
       * or '' when none. (Per-chunk scoping matches the adapters' original
       * inline framing, where the tracker was reset on every chunk.)
       */
      eventType: string;
    }
  /** The `[DONE]` sentinel (`data: [DONE]`). */
  | { type: 'done' }
  /** The abort signal fired while waiting for the next chunk. */
  | { type: 'aborted' };

/**
 * Read an SSE response body as a stream of parsed items. Blank lines and
 * non-`data:` lines (comments, `event:` after use) are dropped; a trailing
 * partial line at end-of-stream is discarded, matching the adapters'
 * original inline framing. The reader lock is always released.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseStreamItem, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) {
        yield { type: 'aborted' };
        return;
      }

      const { done, value } = await reader.read();
      if (done) return;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let eventType = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event: ')) {
          eventType = trimmed.slice(7);
          continue;
        }
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trimStart();
        if (data === '[DONE]') {
          yield { type: 'done' };
          continue;
        }
        yield { type: 'event', data, line: trimmed, eventType };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
