/**
 * Anthropic Claude backend adapter.
 *
 * Native Messages API with streaming, tool use, vision, reasoning,
 * and structured outputs.
 * Docs: https://docs.anthropic.com/en/api/messages
 */

import type {
  BackendAdapter,
  ContentPart,
  GenerationResult,
  ModelInfo,
  PipelineMessage,
  Prompt,

  BackendStreamItem,
  TextPart,
  ToolCall,
  ToolDefinition,
} from './BackendAdapter.js';
import { logger } from '../lib/logger.js';
import { logDelta } from './RequestLogger.js';
import { executeRequest, type BaseAdapterConfig } from './executeRequest.js';
import { convertParamsToSnakeCase } from './camelToSnake.js';
import {
  isObjectRecord,
  ClaudeStreamEventSchema,
  ClaudeModelListSchema,
  type ClaudeStreamEvent,
  type ClaudeMessageRequest,
  type ClaudeTool,
} from './types.js';
import { resolveLocalAttachmentUrl } from './resolveLocalAttachment.js';

export interface ClaudeAdapterConfig extends BaseAdapterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}



export class ClaudeBackendAdapter implements BackendAdapter {
  readonly id = 'claude';
  readonly supportsStreaming = true;
  readonly supportsTools = true;

  constructor(private config: ClaudeAdapterConfig) {}

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
    let reasoningText = '';
    let reasoningSignature = '';
    let inputTokens = 0;
    let outputTokens = 0;

    // Track current content block type for tool_use accumulation
    let currentBlockType = '';
    let currentToolId = '';
    let currentToolName = '';
    let currentToolJson = '';
    const toolCalls: ToolCall[] = [];

    try {
      while (true) {
        if (signal.aborted) {
          return {
            finishReason: 'error',
            usage: {
              promptTokens: inputTokens || prompt.tokenUsage.prompt,
              completionTokens: outputTokens || completionTokens,
            },
            error: 'Aborted',
            reasoningText: reasoningText || undefined,
            reasoningSignature: reasoningSignature || undefined,
          };
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let currentEventType = '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event: ')) {
            currentEventType = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trimStart();

          try {
            const raw: unknown = JSON.parse(data);
            const parsed = ClaudeStreamEventSchema.safeParse(raw);
            if (!parsed.success) continue;
            const event: ClaudeStreamEvent = parsed.data;
            logDelta(this.id, event);
            // Some events carry their type inside the JSON as well
            const eventType = event.type || currentEventType;

            switch (eventType) {
              case 'message_start':
                if (event.message?.usage) {
                  inputTokens = event.message.usage.input_tokens ?? 0;
                }
                break;
              case 'content_block_start':
                if (event.content_block?.type) {
                  currentBlockType = event.content_block.type;
                  if (currentBlockType === 'tool_use') {
                    currentToolId = event.content_block.id ?? '';
                    currentToolName = event.content_block.name ?? '';
                    currentToolJson = '';
                  }
                }
                break;
              case 'content_block_delta':
                if (event.delta?.type === 'text_delta' && event.delta.text) {
                  yield { type: 'text', token: event.delta.text };
                  completionTokens++;
                } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
                  reasoningText += event.delta.thinking;
                  yield { type: 'reasoning', token: event.delta.thinking };
                } else if (event.delta?.type === 'signature_delta' && event.delta.signature) {
                  reasoningSignature += event.delta.signature;
                  yield { type: 'reasoningSignature', signature: event.delta.signature };
                } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                  currentToolJson += event.delta.partial_json;
                }
                break;
              case 'content_block_stop':
                if (currentBlockType === 'tool_use' && currentToolId) {
                  let args: Record<string, unknown> = {};
                  if (currentToolJson) {
                    try {
                      args = JSON.parse(currentToolJson) as Record<string, unknown>;
                    } catch (err) {
                      logger.warn({ err, rawArgs: currentToolJson }, 'Failed to parse Claude tool-use arguments');
                      args = {};
                    }
                  }
                  toolCalls.push({ id: currentToolId, name: currentToolName, arguments: args });
                  currentToolId = '';
                  currentToolName = '';
                  currentToolJson = '';
                }
                currentBlockType = '';
                break;
              case 'message_delta':
                if (event.delta?.stop_reason) {
                  finishReason = event.delta.stop_reason;
                }
                if (event.usage) {
                  outputTokens = event.usage.output_tokens ?? 0;
                }
                break;
            }
          } catch (err) {
            logger.debug({ err, line: line.trim() }, 'Malformed SSE line in Claude stream');
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      finishReason: this.canonicalFinishReason(finishReason),
      usage: {
        promptTokens: inputTokens || prompt.tokenUsage.prompt,
        completionTokens: outputTokens || completionTokens,
      },
      reasoningText: reasoningText || undefined,
      reasoningSignature: reasoningSignature || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  buildRequest(prompt: Prompt): { url: string; init: RequestInit } {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/messages`;

    // Extract system messages into top-level system param
    const systemPrompt = this.extractSystemPrompt(prompt);
    const messages = this.convertMessages(prompt.messages);

    const cachingEnabled = typeof prompt.cacheDepth === 'number' && prompt.cacheDepth >= 0;
    // Per-config TTL (providerParams.cacheTTL, merged into the params blob by
    // buildBackendSettings) — there is no global fallback.
    const cacheTTL = this.config.params?.cacheTTL as string | undefined;

    if (typeof prompt.cacheDepth === 'number' && prompt.cacheDepth >= 0) {
      this.injectCacheControls(messages, prompt.cacheDepth, cacheTTL);
    }

    const body: ClaudeMessageRequest = {
      model: this.config.model,
      max_tokens: prompt.tokenUsage.completion,
      messages,
      stream: true,
    };

    if (systemPrompt) {
      if (cachingEnabled) {
        body.system = [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral', ...(cacheTTL ? { ttl: cacheTTL } : {}) },
          },
        ];
      } else {
        body.system = systemPrompt;
      }
    }

    if (prompt.tools && prompt.tools.length > 0) {
      const strictTools = Boolean(prompt.params?.strictTools ?? this.config.params?.strictTools ?? false);
      const tools = this.convertTools(prompt.tools, strictTools);
      if (cachingEnabled && tools.length > 0) {
        (tools[tools.length - 1] as Record<string, unknown>).cache_control = {
          type: 'ephemeral',
          ...(cacheTTL ? { ttl: cacheTTL } : {}),
        };
      }
      body.tools = tools as ClaudeTool[];
    }

    // Structured outputs
    if (prompt.responseFormat) {
      body.output_config = { format: this.convertResponseFormat(prompt.responseFormat) };
    }

    // Merge config-level params and prompt-level params (prompt wins)
    const params = convertParamsToSnakeCase({ ...this.config.params, ...prompt.params });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && body[key] === undefined) {
        body[key] = value;
      }
    }

    // Claude uses stop_sequences instead of stop
    if (typeof body.stop === 'string') {
      body.stop_sequences = [body.stop];
      delete body.stop;
    } else if (Array.isArray(body.stop)) {
      body.stop_sequences = body.stop;
      delete body.stop;
    }

    const betaHeaders = ['output-128k-2025-02-19', 'context-1m-2025-08-07'];
    if (cachingEnabled) {
      betaHeaders.push('prompt-caching-2024-07-31');
      betaHeaders.push('extended-cache-ttl-2025-04-11');
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-beta': betaHeaders.join(','),
      'anthropic-version': '2023-06-01',
    };
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };

    return { url, init };
  }

  private extractSystemPrompt(prompt: Prompt): string | undefined {
    const systemMessages = prompt.messages.filter((m) => m.role === 'system');
    const texts: string[] = [];

    if (prompt.systemPrompt) {
      texts.push(prompt.systemPrompt);
    }

    for (const m of systemMessages) {
      if (typeof m.content === 'string') {
        texts.push(m.content);
      } else {
        const textParts = m.content.filter((p): p is TextPart => p.type === 'text');
        texts.push(textParts.map((p) => p.text).join(''));
      }
    }

    return texts.join('\n\n') || undefined;
  }

  private convertMessages(messages: PipelineMessage[]): Array<{ role: string; content: string | unknown[] }> {
    // Strip trailing empty assistant message (created as a stream target).
    const lastMsg = messages[messages.length - 1];
    if (
      lastMsg &&
      lastMsg.role === 'assistant' &&
      typeof lastMsg.content === 'string' &&
      !lastMsg.content.trim() &&
      !lastMsg.reasoningFormatted
    ) {
      messages = messages.slice(0, -1);
    }

    const out: Array<{ role: string; content: string | unknown[] }> = [];

    for (const m of messages) {
      if (m.role === 'system') continue;

      // If the message has an array of parts, translate them directly to Claude content blocks.
      // A single internal message may contain multiple tool-call cycles;
      // we emit interleaved assistant / user turns.
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        let assistantBuffer: ContentPart[] = [];
        for (const part of m.content) {
          if (part.type === 'tool_result') {
            if (assistantBuffer.length > 0) {
              out.push({
                role: 'assistant',
                content: this.convertParts(assistantBuffer),
              });
              assistantBuffer = [];
            }
            out.push({
              role: 'user',
              content: this.convertParts([part]),
            });
          } else {
            assistantBuffer.push(part);
          }
        }
        if (assistantBuffer.length > 0) {
          out.push({
            role: 'assistant',
            content: this.convertParts(assistantBuffer),
          });
        }
        continue;
      }

      // Fallback: use pre-formatted reasoning + content for adapters without native block support
      const textContent = m.reasoningFormatted
        ? m.reasoningFormatted
        : typeof m.content === 'string'
          ? m.content
          : this.convertParts(m.content);

      out.push({
        role: m.role,
        content: textContent,
      });
    }

    return out;
  }

  private convertParts(parts: ContentPart[]): unknown[] {
    return parts.map((part) => {
      switch (part.type) {
        case 'text':
          return { type: 'text', text: part.text };
        case 'image': {
          const resolved = resolveLocalAttachmentUrl(part.source, part.mimeType);
          if (resolved.startsWith('data:')) {
            const parsed = this.parseDataUrl(resolved);
            if (parsed) {
              return {
                type: 'image',
                source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
              };
            }
          }
          return {
            type: 'image',
            source: { type: 'url', url: resolved },
          };
        }
        case 'audio':
        case 'video':
          // Claude Messages API does not support audio or video input
          return { type: 'text', text: `[${part.type === 'audio' ? 'Audio' : 'Video'}: ${part.source}]` };
        case 'tool_use':
          return { type: 'tool_use', id: part.id, name: part.name, input: part.input };
        case 'tool_result': {
          let content: string | unknown[];
          if (Array.isArray(part.content)) {
            content = this.convertParts(part.content);
          } else {
            content = part.content;
          }
          const out: { type: string; tool_use_id: string; content: string | unknown[]; is_error?: boolean } = {
            type: 'tool_result',
            tool_use_id: part.toolUseId,
            content,
          };
          if (part.isError) out.is_error = true;
          return out;
        }
        case 'reasoning': {
          if (part.signature) {
            return { type: 'thinking', thinking: part.text, signature: part.signature };
          }
          // Claude requires a signature for thinking blocks; without one, inline as text
          return { type: 'text', text: part.text };
        }
        default:
          return part;
      }
    });
  }

  private parseDataUrl(url: string): { mediaType: string; data: string } | null {
    const match = /^data:([^;]+);base64,(.+)$/.exec(url);
    const mediaType = match?.[1];
    const data = match?.[2];
    if (mediaType === undefined || data === undefined) return null;
    return { mediaType, data };
  }

  private convertTools(tools: ToolDefinition[], strict: boolean): unknown[] {
    return tools.map((t) => {
      const out: Record<string, unknown> = {
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? { type: 'object', properties: {} },
      };
      if (strict) out.strict = true;
      return out;
    });
  }

  private convertResponseFormat(format: NonNullable<Prompt['responseFormat']>): Record<string, unknown> {
    switch (format.type) {
      case 'json_schema':
        return { type: 'json_schema', schema: format.schema };
      case 'json_object':
        return { type: 'json_schema', schema: { type: 'object' } };
      case 'text':
      default:
        return { type: 'text' };
    }
  }

  /**
   * Inject `cache_control` breakpoints into Claude messages.
   * Walks from the end of the message list, counting role transitions,
   * and adds `cache_control` to the last content part at the target depth
   * and at `depth + 2` (second breakpoint).
   */
  private injectCacheControls(
    messages: Array<{ role: string; content: string | unknown[]; name?: string }>,
    cachingAtDepth: number,
    ttl?: string,
  ): void {
    let passedThePrefill = false;
    let depth = 0;
    let previousRoleName = '';
    const cacheControl = { type: 'ephemeral', ...(ttl ? { ttl } : {}) };

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;

      // Skip assistant prefill messages at the very end
      if (!passedThePrefill && msg.role === 'assistant') {
        continue;
      }
      passedThePrefill = true;

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

  private canonicalFinishReason(reason: string | null): GenerationResult['finishReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
      case 'tool_use':
      case null:
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'error';
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/models`;
    const res = await fetch(url, {
      headers: {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
    });
    if (!res.ok) {
      throw new Error(`Claude /models returned HTTP ${res.status}`);
    }
    const raw: unknown = await res.json();
    const parsed = ClaudeModelListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Claude /models parse failed: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      );
    }
    return (parsed.data.data ?? []).map((m) => ({
      id: m.id,
      name: m.display_name ?? m.id,
      contextLength: m.max_input_tokens,
    }));
  }
}
