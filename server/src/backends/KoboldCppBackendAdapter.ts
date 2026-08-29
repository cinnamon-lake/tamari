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
import { readSseEvents } from './sseReader.js';
import {
  KoboldStreamEventSchema,
  type KoboldStreamEvent,
  type KoboldCppGenerateRequest,
  INTERNAL_PARAM_KEYS,
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

    let completionTokens = 0;
    let finishReason: string | null = null;

    for await (const item of readSseEvents(outcome.body, signal)) {
      if (item.type === 'aborted') {
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
      if (item.type === 'done') continue;

      try {
        const raw: unknown = JSON.parse(item.data);
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
        logger.debug({ err, line: item.line }, 'Malformed SSE line in KoboldCpp stream');
      }
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

    // Provider params: typed knobs are mapped onto the KoboldCpp field names
    // below, explicitly; every other key is a Kobold-native override
    // (mirostat, dry_*, sampler_seed, rep_pen_range, …) and passes through
    // verbatim. Prompt-level params beat config-level; request fields above
    // beat both.
    const params = { ...this.config.params, ...prompt.params };
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (INTERNAL_PARAM_KEYS.has(key)) continue;
      if (body[key] !== undefined) continue;
      body[key] = value;
    }
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.topK !== undefined) body.top_k = params.topK;
    if (params.minP !== undefined) body.min_p = params.minP;
    if (params.topA !== undefined) body.top_a = params.topA;
    if (params.repetitionPenalty !== undefined) body.rep_pen = params.repetitionPenalty;
    if (Array.isArray(params.stop)) body.stop_sequence = params.stop;

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
