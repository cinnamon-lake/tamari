/**
 * KoboldCpp native backend adapter.
 *
 * Uses the KoboldAI United compatible API endpoints:
 * - POST /api/v1/generate          (sync JSON response)
 * - POST /api/extra/generate/stream (SSE streaming)
 * - POST /api/extra/abort          (cancel generation)
 *
 * The prompt is sent as a flat string: this adapter flattens `prompt.messages`
 * with the configured instruct template (formatTextPrompt).
 */

import type { BackendAdapter, BackendStreamItem, GenerationResult, ModelInfo, Prompt } from './BackendAdapter.js';
import { logger } from '../lib/logger.js';
import { logDelta } from './RequestLogger.js';
import { executeRequest, type BaseAdapterConfig } from './executeRequest.js';
import { getInstructTemplate, type InstructTemplate } from './InstructTemplate.js';
import { formatTextPrompt } from './formatTextPrompt.js';
import {
  KoboldStreamEventSchema,
  type KoboldStreamEvent,
  type KoboldCppGenerateRequest,
} from './types.js';

export interface KoboldCppAdapterConfig extends BaseAdapterConfig {
  baseUrl: string;
  apiKey: string;
  contextLength?: number;
  /** Instruct template for the chat→string flattening (default: 'none'). */
  template?: InstructTemplate;
  /** Inline past reasoning blocks into the flat prompt (template delimiters). */
  includeReasoning?: boolean;
}



export class KoboldCppBackendAdapter implements BackendAdapter {
  readonly id = 'koboldcpp';
  readonly supportsStreaming = true;
  readonly supportsTools = false;

  private readonly template: InstructTemplate;
  readonly outputReasoning?: InstructTemplate['reasoning'];

  constructor(private config: KoboldCppAdapterConfig) {
    this.template = config.template ?? getInstructTemplate();
    this.outputReasoning = this.template.reasoning;
  }

  async *stream(prompt: Prompt, signal: AbortSignal): AsyncGenerator<BackendStreamItem, GenerationResult> {
    const baseUrl = this.normalizeBaseUrl(this.config.baseUrl);
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

    try {
      while (true) {
        if (signal.aborted) {
          // Notify KoboldCpp to abort the generation
          this.sendAbort(baseUrl).catch((err) => {
            logger.debug({ err }, 'KoboldCpp abort request failed');
          });
          return {
            finishReason: 'error',
            usage: {
              promptTokens: prompt.tokenUsage.prompt,
              completionTokens,
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

          try {
            const raw: unknown = JSON.parse(data);
            const parsed = KoboldStreamEventSchema.safeParse(raw);
            if (!parsed.success) continue;
            const event: KoboldStreamEvent = parsed.data;
            logDelta(this.id, event);
            if (event.token) {
              yield { type: 'text', token: event.token };
              completionTokens++;
            }
            if (event.finish_reason) {
              finishReason = event.finish_reason;
            }
          } catch (err) {
            logger.debug({ err, line: line.trim() }, 'Malformed SSE line in KoboldCpp stream');
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      finishReason: this.canonicalFinishReason(finishReason),
      usage: {
        promptTokens: prompt.tokenUsage.prompt,
        completionTokens,
      },
    };
  }

  buildRequest(prompt: Prompt): { url: string; init: RequestInit } {
    const baseUrl = this.normalizeBaseUrl(this.config.baseUrl);
    const url = `${baseUrl}/extra/generate/stream`;

    const body: KoboldCppGenerateRequest = this.buildBody(prompt);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
    };

    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };

    return { url, init };
  }

  private buildBody(prompt: Prompt): KoboldCppGenerateRequest {
    const body: KoboldCppGenerateRequest = {
      prompt: formatTextPrompt(prompt.messages, this.template, {
        includeReasoning: this.config.includeReasoning ?? false,
      }),
      max_context_length: this.config.contextLength ?? 4096,
      max_length: prompt.tokenUsage.completion,
    };

    // Map standard params to Kobold-native names
    const paramMap: Record<string, string> = {
      temperature: 'temperature',
      topP: 'top_p',
      topK: 'top_k',
      repetitionPenalty: 'rep_pen',
      rep_pen_range: 'rep_pen_range',
      rep_pen_slope: 'rep_pen_slope',
      minP: 'min_p',
      topA: 'top_a',
      typical: 'typical',
      tfs: 'tfs',
      sampler_seed: 'sampler_seed',
      sampler_order: 'sampler_order',
      mirostat: 'mirostat',
      mirostat_tau: 'mirostat_tau',
      mirostat_eta: 'mirostat_eta',
      grammar: 'grammar',
      stopStrings: 'stop_sequence',
      stop_sequence: 'stop_sequence',
      use_default_badwordsids: 'use_default_badwordsids',
      singleline: 'singleline',
    };

    const params = { ...this.config.params, ...prompt.params };
    for (const [stdKey, koboldKey] of Object.entries(paramMap)) {
      const value = params[stdKey];
      if (value !== undefined && value !== null) {
        body[koboldKey] = value;
      }
    }

    // Also pass through any raw Kobold params that were already set correctly
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && body[key] === undefined) {
        body[key] = value;
      }
    }

    return body;
  }

  private normalizeBaseUrl(url: string): string {
    // Old ST forced /api as the pathname. We do the same for compatibility.
    try {
      const parsed = new URL(url);
      if (parsed.pathname === '/' || parsed.pathname === '') {
        parsed.pathname = '/api';
      }
      return parsed.toString().replace(/\/$/, '');
    } catch (err) {
      logger.debug({ err, url }, 'KoboldCpp normalizeBaseUrl fallback');
      return url.replace(/\/$/, '');
    }
  }

  private async sendAbort(baseUrl: string): Promise<void> {
    await fetch(`${baseUrl}/extra/abort`, { method: 'POST' });
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

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}
