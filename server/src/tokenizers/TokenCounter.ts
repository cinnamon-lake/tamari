/**
 * Server-side token counter.
 *
 * Uses tiktoken for OpenAI models and a byte-per-token fallback
 * for everything else. In future this can be expanded to the full
 * tokenizer zoo from the old codebase (SentencePiece, WebTokenizers, etc.).
 */

import tiktoken from 'tiktoken';

const BYTES_PER_TOKEN = 3.35;

function guesstimate(str: string): number {
  const byteLength = Buffer.byteLength(str, 'utf8');
  return Math.ceil(byteLength / BYTES_PER_TOKEN);
}

const cache = new Map<string, tiktoken.Tiktoken>();

function getTokenizer(model: string): tiktoken.Tiktoken | undefined {
  try {
    if (!cache.has(model)) {
      const t = tiktoken.encoding_for_model(model as tiktoken.TiktokenModel);
      cache.set(model, t);
    }
    return cache.get(model);
  } catch {
    return undefined;
  }
}

export interface ITokenCounter {
  count(text: string): number;
  countMessages(messages: Array<{ role: string; content: string; name?: string | null }>): number;
}

export class TokenCounter implements ITokenCounter {
  private tokenizer: tiktoken.Tiktoken | undefined;

  constructor(model = 'gpt-3.5-turbo') {
    this.tokenizer = getTokenizer(model);
  }

  /**
   * Count tokens in a plain string.
   */
  count(text: string): number {
    if (!this.tokenizer) {
      return guesstimate(text);
    }
    return this.tokenizer.encode(text).length;
  }

  /**
   * Count tokens in an array of chat messages (approximate).
   * This is a rough approximation; real APIs may count differently.
   */
  countMessages(messages: Array<{ role: string; content: string }>): number {
    if (!this.tokenizer) {
      const joined = messages.map((m) => `${m.role}\n\n${m.content}`).join('\n\n');
      return guesstimate(joined);
    }

    // Every message follows <|start|>{role}\n{content}<|end|>\n
    let tokens = 0;
    for (const msg of messages) {
      tokens += 3; // <|start|>, \n, <|end|>
      tokens += this.tokenizer.encode(msg.role).length;

      tokens += this.tokenizer.encode(msg.content).length;
    }
    tokens += 3; // every reply is primed with <|start|>assistant
    return tokens;
  }
}

/**
 * Provider that caches TokenCounter instances by model.
 * Callers should use `provideTokenCounter(model)` to get a counter and then call `.count()` on it.
 */
export class TokenCounterProvider {
  private counters = new Map<string, TokenCounter>();

  provideTokenCounter(model?: string): TokenCounter {
    const key = model ?? 'default';
    let counter = this.counters.get(key);
    if (!counter) {
      counter = new TokenCounter(model);
      this.counters.set(key, counter);
    }
    return counter;
  }
}

export const tokenCounterProvider = new TokenCounterProvider();
