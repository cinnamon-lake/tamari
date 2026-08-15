/**
 * OpenRouter backend adapter.
 *
 * OpenRouter exposes an OpenAI-compatible `/chat/completions` endpoint
 * with additional provider-routing headers, transforms, plugins, and
 * reasoning extraction.
 *
 * Inherits message/tool conversion, streaming, and stream parsing from
 * OpenAIBackendAdapter and overrides request building plus stream-chunk
 * validation for OpenRouter-specific behaviour.
 *
 * Docs: https://openrouter.ai/docs
 */

import { OpenAIBackendAdapter, type OpenAIAdapterConfig } from './OpenAIBackendAdapter.js';
import type { Prompt, ModelInfo } from './BackendAdapter.js';
import { OpenRouterModelCache } from './OpenRouterModelCache.js';
import {
  isObjectRecord,
  OpenRouterStreamChunkSchema,
  type OpenAIChatMessage,
  type OpenRouterStreamChunk,
  type OpenRouterChatCompletionRequest,
} from './types.js';

export interface OpenRouterAdapterConfig extends OpenAIAdapterConfig {
  /** OpenRouter transforms, e.g. ['middle-out'] */
  transforms?: string[];
  /** OpenRouter plugins, e.g. [{ id: 'web' }] */
  plugins?: Array<{ id: string }>;
  /** Provider preference order, e.g. ['Anthropic', 'OpenAI'] */
  providerOrder?: string[];
  /** Whether to allow fallback to other providers */
  allowFallbacks?: boolean;
  /** Reasoning effort: constrains effort on reasoning for reasoning models */
  reasoningEffort?: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
  /** Reasoning summary verbosity: auto, concise, or detailed */
  reasoningSummary?: 'auto' | 'concise' | 'detailed';
}



export class OpenRouterBackendAdapter extends OpenAIBackendAdapter {
  readonly id = 'openrouter';
  private modelCache = new OpenRouterModelCache();

  constructor(private openRouterConfig: OpenRouterAdapterConfig) {
    super(openRouterConfig);
  }

  buildRequest(prompt: Prompt): { url: string; init: RequestInit } {
    const { url, init } = super.buildRequest(prompt);
    // The parent's buildRequest always serializes the body to a JSON string.
    if (typeof init.body !== 'string') {
      throw new Error('OpenAI buildRequest did not produce a string body');
    }
    const body = JSON.parse(init.body) as OpenRouterChatCompletionRequest;

    // OpenRouter-specific body fields
    body.transforms = this.openRouterConfig.transforms;
    body.plugins = this.openRouterConfig.plugins;

    const reasoning = this.buildReasoningBody();
    if (reasoning) {
      body.reasoning = reasoning;
    }

    // Provider routing
    if (this.openRouterConfig.providerOrder && this.openRouterConfig.providerOrder.length > 0) {
      body.provider = {
        order: this.openRouterConfig.providerOrder,
        allow_fallbacks: this.openRouterConfig.allowFallbacks ?? true,
      };
    }

    // Prompt caching for Claude models via OpenRouter. The TTL rides in the
    // params blob (providerParams.cacheTTL, merged by buildBackendSettings).
    const cacheTTL = this.openRouterConfig.params?.cacheTTL as string | undefined;

    if (
      typeof prompt.cacheDepth === 'number' &&
      prompt.cacheDepth >= 0 &&
      (this.openRouterConfig.model.startsWith('anthropic/claude') ||
        this.openRouterConfig.model.startsWith('claude-'))
    ) {
      this.injectOpenRouterCacheControls(body.messages, prompt.cacheDepth, cacheTTL);
    }

    return {
      url,
      init: {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          'HTTP-Referer': 'https://github.com/cinnamon-lake/tamari',
          'X-Title': 'tamari',
        },
        body: JSON.stringify(body),
      },
    };
  }

  /**
   * Inject `cache_control` into OpenRouter messages for Claude models.
   * Mirrors the old `cachingAtDepthForOpenRouterClaude` + `cachingSystemPromptForOpenRouter`.
   */
  private injectOpenRouterCacheControls(
    messages: OpenAIChatMessage[],
    cachingAtDepth: number,
    ttl?: string,
  ): void {
    const cacheControl = { type: 'ephemeral', ...(ttl ? { ttl } : {}) };

    // 1. System prompt caching
    const systemMsg = messages.find((m) => m.role === 'system');
    if (systemMsg) {
      if (typeof systemMsg.content === 'string') {
        systemMsg.content = [{ type: 'text', text: systemMsg.content, cache_control: cacheControl }];
      } else if (Array.isArray(systemMsg.content)) {
        for (let i = systemMsg.content.length - 1; i >= 0; i--) {
          const part = systemMsg.content[i];
          if (isObjectRecord(part) && part.type === 'text') {
            part.cache_control = cacheControl;
            break;
          }
        }
      }
    }

    // 2. Depth-based caching (skip system messages when counting depth)
    let passedThePrefill = false;
    let depth = 0;
    let previousRoleName = '';

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;

      if (!passedThePrefill && msg.role === 'assistant') {
        continue;
      }
      passedThePrefill = true;

      if (msg.role === 'system') {
        continue;
      }

      if (msg.role !== previousRoleName) {
        if (depth === cachingAtDepth || depth === cachingAtDepth + 2) {
          if (typeof msg.content === 'string') {
            msg.content = [{ type: 'text', text: msg.content, cache_control: cacheControl }];
          } else if (Array.isArray(msg.content)) {
            const lastPart = msg.content[msg.content.length - 1];
            if (isObjectRecord(lastPart)) {
              lastPart.cache_control = cacheControl;
            }
          }
        }

        if (depth === cachingAtDepth + 2) {
          break;
        }

        depth += 1;
        previousRoleName = msg.role;
      }
    }
  }

  /**
   * Validate stream chunks with the OpenRouter schema (a superset of the
   * OpenAI chunk shape). All delta handling — including the cumulative-
   * content defense and reasoning buffering — is inherited from the parent.
   */
  protected parseStreamChunk(raw: unknown): OpenRouterStreamChunk | undefined {
    const parsed = OpenRouterStreamChunkSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private buildReasoningBody(): Record<string, unknown> | undefined {
    const effort = this.openRouterConfig.reasoningEffort;
    const summary = this.openRouterConfig.reasoningSummary;
    if (!effort && !summary) return undefined;
    const body: Record<string, unknown> = {};
    if (effort) body.effort = effort;
    if (summary) body.summary = summary;
    return body;
  }

  async listModels(_signal?: AbortSignal): Promise<ModelInfo[]> {
    const models = await this.modelCache.listModels();
    return models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.top_provider?.context_length ?? m.context_length,
      description: m.description,
    }));
  }
}
