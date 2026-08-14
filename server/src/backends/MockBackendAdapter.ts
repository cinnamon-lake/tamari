/**
 * MockBackendAdapter — the deterministic scripted 'mock' provider.
 *
 * A TrivialBackendAdapter generalization driven by an inline script instead of
 * a constructor array, so canned responses can live in a BackendConfig
 * (`providerParams.mockScript`, one directive per line — blank lines and `#`
 * comments are ignored). No network, no external process; intended for
 * deterministic card-testing sessions and headless agent runs.
 *
 * Directive syntax (ported from e2e/fixtures/mockLlmServer.ts selectors):
 *   respond:<text>         default reply for any call with no more specific
 *                          directive (the last respond: line wins)
 *   seq:<n>:<text>         text reply for the nth stream call (1-based)
 *   tool:<name>:<json>     tool-call sequence, walked by counting tool results
 *                          already in the prompt: a call whose prompt carries k
 *                          tool results emits the k-th tool: directive; once the
 *                          sequence is exhausted the call falls through to
 *                          seq:/respond: — this is what makes scripted-card
 *                          tool-loop testing deterministic
 *
 * A call matching nothing replies with DEFAULT_RESPONSE. Streaming is
 * char-by-char and abort-aware, like TrivialBackendAdapter. Every prompt is
 * captured on `requests` for inspection.
 */

import type {
  BackendAdapter,
  BackendStreamItem,
  GenerationResult,
  ModelInfo,
  Prompt,
  ToolCall,
} from './BackendAdapter.js';
import type { TrivialBlock } from './TrivialBackendAdapter.js';

const DEFAULT_RESPONSE = 'This is a deterministic mock response.';

type MockDirective =
  | { kind: 'respond'; text: string }
  | { kind: 'seq'; call: number; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown> };

/** Parse one mock-script line into a directive, or null when it carries none. */
function parseDirective(line: string): MockDirective | null {
  const respond = /^respond:(.*)$/i.exec(line);
  if (respond) return { kind: 'respond', text: respond[1]!.trim() };
  const seq = /^seq:(\d+):(.*)$/i.exec(line);
  if (seq) return { kind: 'seq', call: parseInt(seq[1]!, 10), text: seq[2]!.trim() };
  const tool = /^tool:([^:]+):(.*)$/i.exec(line);
  if (tool) {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(tool[2]!.trim());
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed args degrade to {} (mockLlmServer's parseToolSequence rule).
    }
    return { kind: 'tool', name: tool[1]!.trim(), args };
  }
  return null;
}

export function parseMockScript(script: string): MockDirective[] {
  const directives: MockDirective[] = [];
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const directive = parseDirective(line);
    if (directive) directives.push(directive);
  }
  return directives;
}

/** Tool results already visible in the prompt (role:'tool' messages and
    tool_result parts) — the walk position for the tool: sequence. */
function countToolResults(prompt: Prompt): number {
  let count = 0;
  for (const message of prompt.messages) {
    if (message.role === 'tool') count++;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool_result') count++;
      }
    }
  }
  return count;
}

export class MockBackendAdapter implements BackendAdapter {
  readonly id = 'mock';
  readonly supportsStreaming = true;
  readonly supportsTools = true;

  /** Every prompt this adapter was asked to stream (request capture). */
  readonly requests: Prompt[] = [];

  private readonly directives: MockDirective[];
  private callIndex = 0;

  constructor(script: string) {
    this.directives = parseMockScript(script);
  }

  /** The canned blocks for one call, per the directive precedence rules. */
  private blocksFor(prompt: Prompt, callIndex: number): TrivialBlock[] {
    const tools = this.directives.filter((d) => d.kind === 'tool');
    const toolAt = tools[countToolResults(prompt)];
    if (toolAt) {
      return [{ type: 'tool_use', id: `mock-call-${callIndex}`, name: toolAt.name, input: toolAt.args }];
    }
    const seq = this.directives.find((d) => d.kind === 'seq' && d.call === callIndex);
    if (seq && seq.kind === 'seq') return [{ type: 'content', content: seq.text }];
    const responds = this.directives.filter((d) => d.kind === 'respond');
    const respond = responds[responds.length - 1];
    if (respond) return [{ type: 'content', content: respond.text }];
    return [{ type: 'content', content: DEFAULT_RESPONSE }];
  }

  async *stream(prompt: Prompt, signal: AbortSignal): AsyncGenerator<BackendStreamItem, GenerationResult> {
    this.requests.push(prompt);
    this.callIndex++;
    const blocks = this.blocksFor(prompt, this.callIndex);

    let completionTokens = 0;
    const toolCalls: ToolCall[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'content': {
          for (const char of block.content) {
            if (signal.aborted) {
              return {
                finishReason: 'error',
                usage: { promptTokens: prompt.tokenUsage.prompt, completionTokens },
                error: 'Aborted',
              };
            }
            yield { type: 'text', token: char };
            await sleep(1);
          }
          completionTokens += block.content.length;
          break;
        }
        case 'thinking': {
          for (const char of block.content) {
            if (signal.aborted) {
              return {
                finishReason: 'error',
                usage: { promptTokens: prompt.tokenUsage.prompt, completionTokens },
                error: 'Aborted',
              };
            }
            yield { type: 'reasoning', token: char };
            await sleep(1);
          }
          completionTokens += block.content.length;
          break;
        }
        case 'tool_use': {
          if (signal.aborted) {
            return {
              finishReason: 'error',
              usage: { promptTokens: prompt.tokenUsage.prompt, completionTokens },
              error: 'Aborted',
            };
          }
          toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
          yield { type: 'toolCall', id: block.id, name: block.name, arguments: block.input };
          completionTokens += 10;
          break;
        }
      }
    }

    return {
      finishReason: 'stop',
      usage: { promptTokens: prompt.tokenUsage.prompt, completionTokens },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async listModels(_signal?: AbortSignal): Promise<ModelInfo[]> {
    return [{ id: 'mock-model', name: 'Mock Model' }];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
