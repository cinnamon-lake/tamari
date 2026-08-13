/**
 * Generic text-completion backend adapter.
 *
 * Targets OpenAI-compatible `/completions` endpoints:
 * - Ooba / text-generation-webui
 * - TabbyAPI
 * - Llama.cpp server
 * - vLLM (completion mode)
 * - TogetherAI
 * - KoboldCPP (when used in OpenAI-compat mode)
 *
 * Owns the chat→string flattening: `prompt.messages` are formatted with the
 * configured instruct template (formatTextPrompt). Expects SSE streaming
 * with `choices[0].text` deltas.
 */

import type { BackendAdapter, BackendStreamItem, GenerationResult, ModelInfo, Prompt } from './BackendAdapter.js';
import { logger } from '../lib/logger.js';
import { logDelta } from './RequestLogger.js';
import { executeRequest, type BaseAdapterConfig } from './executeRequest.js';
import { convertParamsToSnakeCase } from './camelToSnake.js';
import { getInstructTemplate, type InstructTemplate } from './InstructTemplate.js';
import { formatTextPrompt } from './formatTextPrompt.js';
import {
  TextCompletionStreamChunkSchema,
  OpenAIModelListSchema,
  type TextCompletionStreamChunk,
  type TextCompletionRequest,
} from './types.js';

export interface TextCompletionAdapterConfig extends BaseAdapterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Instruct template for the chat→string flattening (default: 'none'). */
  template?: InstructTemplate;
  /** Inline past reasoning blocks into the flat prompt (template delimiters). */
  includeReasoning?: boolean;
}



export class TextCompletionBackendAdapter implements BackendAdapter {
  readonly id = 'text-completion';
  readonly supportsStreaming = true;
  readonly supportsTools = false;

  private readonly template: InstructTemplate;
  readonly outputReasoning?: InstructTemplate['reasoning'];

  constructor(private config: TextCompletionAdapterConfig) {
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
            const parsed = TextCompletionStreamChunkSchema.safeParse(raw);
            if (!parsed.success) continue;
            const chunk: TextCompletionStreamChunk = parsed.data;
            logDelta(this.id, chunk);
            const choice = chunk.choices?.[0];
            // Some APIs emit `text` directly; others wrap it in `delta.text`
            const token = choice?.text ?? choice?.delta?.text;
            if (token) {
              yield { type: 'text', token };
              completionTokens++;
            }
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
            if (chunk.usage) {
              if (chunk.usage.prompt_tokens) reportedPromptTokens = chunk.usage.prompt_tokens;
              if (chunk.usage.completion_tokens) reportedCompletionTokens = chunk.usage.completion_tokens;
            }
          } catch (err) {
            logger.debug({ err, line: line.trim() }, 'Malformed SSE line in text-completion stream');
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
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/completions`;

    const body: TextCompletionRequest = {
      model: this.config.model,
      prompt: formatTextPrompt(prompt.messages, this.template, {
        includeReasoning: this.config.includeReasoning ?? false,
      }),
      stream: true,
    };

    if (prompt.tokenUsage.completion > 0) {
      body.max_tokens = prompt.tokenUsage.completion;
    }

    // Merge config-level params and prompt-level params (prompt wins)
    const params = convertParamsToSnakeCase({ ...this.config.params, ...prompt.params });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && body[key] === undefined) {
        body[key] = value;
      }
    }

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
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
      const url = `${this.config.baseUrl.replace(/\/$/, '')}/models`;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.config.apiKey) {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      }
      const res = await fetch(url, { headers, signal });
      if (!res.ok) return [];
      const raw: unknown = await res.json();
      const parsed = OpenAIModelListSchema.safeParse(raw);
      if (!parsed.success) return [];
      return (parsed.data.data ?? []).map((m) => ({ id: m.id, name: m.id }));
    } catch (err) {
      logger.warn({ err }, 'TextCompletion listModels failed');
      return [];
    }
  }
}
