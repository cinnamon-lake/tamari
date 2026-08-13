/**
 * llama.cpp server native /completion adapter.
 *
 * Targets the non-OpenAI endpoint:
 *   POST /completion
 *
 * Request format:
 *   { prompt: string, n_predict: number, stream: boolean, ... }
 *
 * Streaming response (SSE):
 *   data: { content: string, stop: boolean, generation_settings: {...},
 *           model: string, tokens_predicted: number, tokens_evaluated: number }
 *
 * The `content` field contains the *delta* text for that chunk.
 * `stop: true` indicates generation has finished.
 *
 * OpenAI-compatible /v1/completions is handled by TextCompletionBackendAdapter.
 * This adapter is for the native endpoint so users don't have to append /v1
 * to their base URL.
 */

import type { BackendAdapter, BackendStreamItem, GenerationResult, ModelInfo, Prompt } from './BackendAdapter.js';
import { logger } from '../lib/logger.js';
import { logDelta } from './RequestLogger.js';
import { executeRequest, type BaseAdapterConfig } from './executeRequest.js';
import {
  LlamaCppStreamChunkSchema,
  OpenAIModelListSchema,
  type LlamaCppStreamChunk,
  type LlamaCppCompletionRequest,
} from './types.js';
import { convertParamsToSnakeCase } from './camelToSnake.js';
import { getInstructTemplate, type InstructTemplate } from './InstructTemplate.js';
import { formatTextPrompt } from './formatTextPrompt.js';

export interface LlamaCppAdapterConfig extends BaseAdapterConfig {
  baseUrl: string;
  model: string;
  /** Instruct template for the chat→string flattening (default: 'none'). */
  template?: InstructTemplate;
  /** Inline past reasoning blocks into the flat prompt (template delimiters). */
  includeReasoning?: boolean;
}



export class LlamaCppBackendAdapter implements BackendAdapter {
  readonly id = 'llamacpp';
  readonly supportsStreaming = true;
  readonly supportsTools = false;

  private readonly template: InstructTemplate;
  readonly outputReasoning?: InstructTemplate['reasoning'];

  constructor(private config: LlamaCppAdapterConfig) {
    this.template = config.template ?? getInstructTemplate();
    this.outputReasoning = this.template.reasoning;
  }

  async *stream(prompt: Prompt, signal: AbortSignal): AsyncGenerator<BackendStreamItem, GenerationResult> {
    const outcome = await executeRequest({
      adapterId: this.id,
      request: this.buildRequest(prompt),
      requestScript: this.config.requestScript,
      signal,
      promptTokens: prompt.tokenUsage.prompt,
    });
    if (!outcome.ok) return outcome.result;

    const reader = outcome.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completionTokens = 0;
    let finishReason: string | null = null;
    let reportedPromptTokens = 0;
    let reportedCompletionTokens = 0;

    try {
      while (true) {
        if (signal.aborted) {
          return {
            finishReason: 'error',
            usage: {
              promptTokens: reportedPromptTokens || prompt.tokenUsage.prompt,
              completionTokens: reportedCompletionTokens || completionTokens,
            },
            error: 'Aborted',
          };
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trimStart();
          if (data === '[DONE]') {
            finishReason = finishReason ?? 'stop';
            continue;
          }

          try {
            const raw: unknown = JSON.parse(data);
            const parsed = LlamaCppStreamChunkSchema.safeParse(raw);
            if (!parsed.success) continue;
            const chunk: LlamaCppStreamChunk = parsed.data;
            logDelta(this.id, chunk);
            if (typeof chunk.content === 'string') {
              yield { type: 'text', token: chunk.content };
              completionTokens++;
            }
            if (chunk.stop === true) {
              // Determine finish reason from detailed flags if available
              if (chunk.stopped_limit) {
                finishReason = 'length';
              } else if (chunk.stopped_eos || chunk.stopped_word) {
                finishReason = 'stop';
              } else {
                finishReason = 'stop';
              }
            }
            if (typeof chunk.tokens_evaluated === 'number') {
              reportedPromptTokens = chunk.tokens_evaluated;
            }
            if (typeof chunk.tokens_predicted === 'number') {
              reportedCompletionTokens = chunk.tokens_predicted;
            }
          } catch (err) {
            logger.debug({ err, line: line.trim() }, 'Malformed SSE line in LlamaCpp stream');
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      finishReason: this.canonicalFinishReason(finishReason),
      usage: {
        promptTokens: reportedPromptTokens || prompt.tokenUsage.prompt,
        completionTokens: reportedCompletionTokens || completionTokens,
      },
    };
  }

  buildRequest(prompt: Prompt): { url: string; init: RequestInit } {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/completion`;

    const body: LlamaCppCompletionRequest = {
      prompt: formatTextPrompt(prompt.messages, this.template, {
        includeReasoning: this.config.includeReasoning ?? false,
      }),
      stream: true,
    };

    // llama.cpp native param is n_predict; also accept maxTokens for compatibility
    if (prompt.tokenUsage.completion > 0) {
      body.n_predict = prompt.tokenUsage.completion;
    }

    // Merge config-level params and prompt-level params (prompt wins)
    const params = { ...this.config.params, ...prompt.params };

    // Convert OpenAI-style logitBias object to llama.cpp array format
    if (params.logitBias && typeof params.logitBias === 'object' && !Array.isArray(params.logitBias)) {
      const biasArray: [number, number][] = [];
      for (const [token, bias] of Object.entries(params.logitBias)) {
        const tokenId = Number(token);
        const biasValue = Number(bias);
        if (!isNaN(tokenId) && !isNaN(biasValue)) {
          biasArray.push([tokenId, biasValue]);
        }
      }
      if (biasArray.length > 0) {
        params.logitBias = biasArray;
      } else {
        delete params.logitBias;
      }
    }

    const snakeParams = convertParamsToSnakeCase(params);
    for (const [key, value] of Object.entries(snakeParams)) {
      if (value !== undefined && value !== null && body[key] === undefined) {
        body[key] = value;
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };

    return { url, init };
  }

  private canonicalFinishReason(reason: string | null): GenerationResult['finishReason'] {
    switch (reason) {
      case 'stop':
      case null:
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'error';
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/models`, { signal });
      if (!res.ok) return [];
      const raw: unknown = await res.json();
      const parsed = OpenAIModelListSchema.safeParse(raw);
      if (!parsed.success) return [];
      return (parsed.data.data ?? []).map((m) => ({ id: m.id, name: m.id }));
    } catch (err) {
      logger.warn({ err }, 'LlamaCpp listModels failed');
      return [];
    }
  }
}
