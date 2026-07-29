/**
 * TrivialBackendAdapter — test-only backend that emits predefined token sequences.
 *
 * Not exposed to the client. Used for deterministic end-to-end tests
 * through the WebSocket bus mock.
 *
 * Example:
 *   const backend = new TrivialBackendAdapter([
 *     [{ type: 'content', content: 'First response.' }],
 *     [
 *       { type: 'thinking', content: 'Hmm...' },
 *       { type: 'content', content: 'Second response.' },
 *     ],
 *   ]);
 */

import type {
  BackendAdapter,
  BackendStreamItem,
  GenerationResult,
  ModelInfo,
  Prompt,
  ToolCall,
} from './BackendAdapter.js';

export type TrivialBlock =
  | { type: 'content'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export class TrivialBackendAdapter implements BackendAdapter {
  readonly id = 'trivial';
  readonly supportsStreaming = true;
  readonly supportsTools = true;

  private callIndex = 0;

  constructor(private responses: TrivialBlock[][]) {}

  async *stream(prompt: Prompt, signal: AbortSignal): AsyncGenerator<BackendStreamItem, GenerationResult> {
    const blocks = this.responses[this.callIndex] ?? [];
    this.callIndex++;

    let completionTokens = 0;
    const toolCalls: ToolCall[] = [];
    let reasoningText = '';

    for (const block of blocks) {
      if (signal.aborted) {
        return {
          finishReason: 'error',
          usage: { promptTokens: prompt.tokenUsage.prompt, completionTokens },
          error: 'Aborted',
        };
      }

      switch (block.type) {
        case 'content': {
          for (const char of block.content) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AbortSignal state changes between loop iterations
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
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AbortSignal state changes between loop iterations
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
          reasoningText += block.content;
          completionTokens += block.content.length;
          break;
        }
        case 'tool_use': {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input,
          });
          yield { type: 'toolCall', id: block.id, name: block.name, arguments: block.input };
          completionTokens += 10;
          break;
        }
      }
    }

    return {
      finishReason: 'stop',
      usage: { promptTokens: prompt.tokenUsage.prompt, completionTokens },
      reasoningText: reasoningText || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async listModels(_signal?: AbortSignal): Promise<ModelInfo[]> {
    return [{ id: 'trivial-model', name: 'Trivial Model' }];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
