/**
 * OpenAI-compatible backend adapter.
 *
 * Works with OpenAI, OpenRouter, Groq, and any other provider
 * that exposes a `/chat/completions` endpoint.
 */

import type {
  BackendAdapter,
  ContentPart,
  GenerationResult,
  ModelInfo,
  PipelineMessage,
  Prompt,
  ReasoningPart,
  TextPart,
  BackendStreamItem,
  ToolCall,
  ToolResultPart,
  ToolUsePart,
} from './BackendAdapter.js';
import { logger } from '../lib/logger.js';
import { logDelta } from './RequestLogger.js';
import { executeRequest, type BaseAdapterConfig } from './executeRequest.js';
import { convertParamsToSnakeCase } from './camelToSnake.js';
import {
  OpenAIStreamChunkSchema,
  OpenAIModelListSchema,
  type OpenAIStreamChunk,
  type OpenAIChatCompletionRequest,
} from './types.js';
import { resolveLocalAttachmentUrl } from './resolveLocalAttachment.js';

export interface OpenAIAdapterConfig extends BaseAdapterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}



export class OpenAIBackendAdapter implements BackendAdapter {
  readonly id: string = 'openai';
  readonly supportsStreaming = true;
  readonly supportsTools = true;

  constructor(protected config: OpenAIAdapterConfig) {}

  async *stream(prompt: Prompt, signal: AbortSignal): AsyncGenerator<BackendStreamItem, GenerationResult> {
    const outcome = await executeRequest({
      adapterId: this.id,
      request: this.buildRequest(prompt),
      requestScript: this.config.requestScript,
      signal,
      promptTokens: prompt.tokenUsage.prompt,
    });
    if (!outcome.ok) return outcome.result;

    return yield* this.parseStream(outcome.body, prompt, signal);
  }

  buildRequest(prompt: Prompt): { url: string; init: RequestInit } {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const body: OpenAIChatCompletionRequest = {
      model: this.config.model,
      messages: this.convertMessages(prompt.messages),
      stream: true,
    };

    // o-series / reasoning models use max_completion_tokens; legacy uses max_tokens
    const tokenKey = this.isReasoningModel(this.config.model) ? 'max_completion_tokens' : 'max_tokens';
    body[tokenKey] = prompt.tokenUsage.completion;

    if (prompt.tools && prompt.tools.length > 0) {
      body.tools = prompt.tools;
      body.tool_choice = 'auto';
    }

    // Response format
    if (prompt.responseFormat) {
      body.response_format = this.convertResponseFormat(prompt.responseFormat);
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

  /**
   * Validate a raw SSE `data:` payload into a stream chunk.
   *
   * This is the provider-specific extension point of `parseStream`:
   * subclasses with their own chunk schema override this hook and inherit
   * the shared delta handling (cumulative-content defense, reasoning
   * buffering, tool-call accumulation) unchanged.
   */
  protected parseStreamChunk(raw: unknown): OpenAIStreamChunk | undefined {
    const parsed = OpenAIStreamChunkSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  protected async *parseStream(
    body: ReadableStream<Uint8Array>,
    prompt: Prompt,
    signal: AbortSignal,
  ): AsyncGenerator<BackendStreamItem, GenerationResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completionTokens = 0;
    let finishReason: string | null = null;
    let reportedPromptTokens = 0;
    let reportedCompletionTokens = 0;
    let reasoningText = '';
    let sawContentField = false;
    let reasoningBuffer = '';
    let bufferedReasoningChunks = 0;
    let lastContent = ''; // track previous content delta to detect cumulative streams

    // Accumulate tool calls by index
    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; args: string }
    >();

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
            reasoningText: reasoningText || undefined,
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
            const chunk = this.parseStreamChunk(raw);
            if (!chunk) continue;
            logDelta(this.id, chunk);
            const delta = chunk.choices?.[0]?.delta;
            if (delta && 'content' in delta) {
              sawContentField = true;
            }
            const content = delta?.content;
            const reasoningChunk = delta?.reasoning_content ?? delta?.reasoning;

            if (typeof content === 'string' && content.length > 0) {
              // First time we see real content: flush any buffered reasoning
              // to the reasoning panel (this is a normal provider).
              if (reasoningBuffer.length > 0) {
                yield { type: 'reasoning', token: reasoningBuffer };
                reasoningBuffer = '';
              }
              // Defensive: some providers (Fireworks, etc.) send cumulative content
              // instead of incremental deltas. Only emit the net-new text.
              let token = content;
              if (content.startsWith(lastContent) && content.length > lastContent.length) {
                token = content.slice(lastContent.length);
              }
              lastContent = content;
              yield { type: 'text', token };
              completionTokens++;
            }

            if (reasoningChunk) {
              reasoningText += reasoningChunk;
              if (sawContentField) {
                // Normal provider: reasoning belongs in the reasoning panel
                yield { type: 'reasoning', token: reasoningChunk };
              } else {
                // Haven't seen a content key yet. Buffer the reasoning in case
                // this turns out to be a normal provider that omits content in
                // early reasoning chunks. If content never arrives, we'll emit
                // the buffer as message text at the end (Fireworks-style).
                reasoningBuffer += reasoningChunk;
                bufferedReasoningChunks++;
              }
            }

            // Accumulate tool call deltas
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                let acc = toolCallAccumulators.get(idx);
                if (!acc) {
                  acc = { id: '', name: '', args: '' };
                  toolCallAccumulators.set(idx, acc);
                }
                if (tc.id) acc.id = tc.id;
                if (tc.type) {
                  // store type if needed
                }
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
              }
            }

            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
            if (chunk.usage) {
              if (chunk.usage.prompt_tokens) reportedPromptTokens = chunk.usage.prompt_tokens;
              if (chunk.usage.completion_tokens) reportedCompletionTokens = chunk.usage.completion_tokens;
            }
          } catch (err) {
            logger.debug({ err, line: line.trim() }, `Malformed SSE line in ${this.id} stream`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // If we buffered reasoning and never saw content, this is a Fireworks-style
    // stream where everything is reasoning_content. Emit the buffer as message text.
    if (reasoningBuffer.length > 0 && !sawContentField) {
      yield { type: 'text', token: reasoningBuffer };
      completionTokens += bufferedReasoningChunks;
    }

    // Build tool calls from accumulated data
    let toolCalls: ToolCall[] | undefined;
    if (toolCallAccumulators.size > 0) {
      toolCalls = [];
      const sortedEntries = Array.from(toolCallAccumulators.entries()).sort(([a], [b]) => a - b);
      for (const [, acc] of sortedEntries) {
        let args: Record<string, unknown> = {};
        if (acc.args) {
          try {
            args = JSON.parse(acc.args) as Record<string, unknown>;
          } catch (err) {
            logger.warn({ err, rawArgs: acc.args }, 'Failed to parse OpenAI tool-call arguments');
            args = {};
          }
        }
        toolCalls.push({ id: acc.id, name: acc.name, arguments: args });
      }
    }

    return {
      finishReason: this.canonicalFinishReason(finishReason),
      usage: {
        promptTokens: reportedPromptTokens || prompt.tokenUsage.prompt,
        completionTokens: reportedCompletionTokens || completionTokens,
      },
      reasoningText: reasoningText || undefined,
      toolCalls,
    };
  }

  protected isReasoningModel(model: string): boolean {
    return /^o\d/.test(model) || model.startsWith('gpt-5.1') || model.includes('reasoning');
  }

  protected convertMessages(
    messages: PipelineMessage[],
  ): Array<{ role: string; content?: string | unknown[] | null; tool_calls?: unknown[]; tool_call_id?: string }> {
    // Strip trailing empty assistant message (created as a stream target).
    // It is the adapter's responsibility to drop it before sending to the API.
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

    const out: Array<{
      role: string;
      content?: string | unknown[] | null;
      reasoning_content?: string;
      tool_calls?: unknown[];
      tool_call_id?: string;
    }> = [];

    function flushAssistant(buffer: ContentPart[]) {
      if (buffer.length === 0) return;
      const textParts = buffer.filter((p): p is TextPart => p.type === 'text');
      const reasoningParts = buffer.filter((p): p is ReasoningPart => p.type === 'reasoning');
      const toolUseParts = buffer.filter((p): p is ToolUsePart => p.type === 'tool_use');

      const assistantMsg: {
        role: string;
        content?: string | unknown[] | null;
        reasoning_content?: string;
        tool_calls?: unknown[];
      } = { role: 'assistant' };

      if (textParts.length > 0) {
        assistantMsg.content = textParts.map((p) => p.text).join('');
      } else if (toolUseParts.length > 0) {
        assistantMsg.content = null;
      } else {
        assistantMsg.content = '';
      }

      if (reasoningParts.length > 0) {
        assistantMsg.reasoning_content = reasoningParts.map((p) => p.text).join('');
      }

      if (toolUseParts.length > 0) {
        assistantMsg.tool_calls = toolUseParts.map((p) => ({
          id: p.id,
          type: 'function',
          function: { name: p.name, arguments: JSON.stringify(p.input) },
        }));
      }

      out.push(assistantMsg);
    }

    for (const m of messages) {
      // Use pre-formatted reasoning+content when available
      const effectiveContent = m.reasoningFormatted ? m.reasoningFormatted : m.content;
      const parts: ContentPart[] =
        typeof effectiveContent === 'string' ? [{ type: 'text', text: effectiveContent }] : effectiveContent;

      // Assistant messages may contain multiple tool-call cycles.
      // We flush an assistant message whenever we hit a tool_result part.
      if (m.role === 'assistant') {
        let assistantBuffer: ContentPart[] = [];
        for (const part of parts) {
          if (part.type === 'tool_result') {
            flushAssistant(assistantBuffer);
            assistantBuffer = [];
            const toolContent = Array.isArray(part.content)
              ? this.convertParts(part.content)
              : part.content;
            out.push({
              role: 'tool',
              tool_call_id: part.toolUseId,
              content: toolContent,
            });
          } else {
            assistantBuffer.push(part);
          }
        }
        flushAssistant(assistantBuffer);
        continue;
      }

      // Tool messages (backward compatibility with old messages)
      if (m.role === 'tool') {
        const toolResultParts = parts.filter((p): p is ToolResultPart => p.type === 'tool_result');
        const textParts = parts.filter((p): p is TextPart => p.type === 'text');

        const msg: { role: string; content: string | unknown[]; tool_call_id?: string } = { role: 'tool', content: '' };

        const firstToolResult = toolResultParts[0];
        if (firstToolResult) {
          msg.tool_call_id = firstToolResult.toolUseId;
          msg.content = textParts.map((p) => p.text).join('') || firstToolResult.content || '';
        } else {
          msg.content = typeof m.content === 'string' ? m.content : this.convertParts(parts);
        }
        out.push(msg);
        continue;
      }

      // User / system messages
      out.push({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : this.convertParts(parts),
      });
    }

    return out;
  }

  protected convertParts(parts: ContentPart[]): unknown[] {
    return parts.map((part) => {
      switch (part.type) {
        case 'text':
          return { type: 'text', text: part.text };
        case 'image':
          return { type: 'image_url', image_url: { url: resolveLocalAttachmentUrl(part.source, part.mimeType), detail: part.detail ?? 'auto' } };
        case 'audio': {
          const resolved = resolveLocalAttachmentUrl(part.source, part.mimeType);
          if (resolved.startsWith('data:')) {
            const parsed = this.parseDataUrl(resolved);
            if (parsed) {
              const format = parsed.mediaType === 'audio/wav' ? 'wav' : 'mp3';
              return { type: 'input_audio', input_audio: { data: parsed.data, format } };
            }
          }
          return { type: 'text', text: `[Audio: ${part.source}]` };
        }
        case 'video':
          return { type: 'image_url', image_url: { url: resolveLocalAttachmentUrl(part.source, part.mimeType), detail: 'auto' } };
        case 'tool_use':
          // tool_use should not appear inside user/system content in OpenAI format
          return { type: 'text', text: `[Tool call: ${part.name}]` };
        case 'tool_result':
          return { type: 'text', text: `[Tool result: ${part.toolUseId}]` };
        default:
          return part;
      }
    });
  }

  protected convertResponseFormat(format: NonNullable<Prompt['responseFormat']>): Record<string, unknown> {
    switch (format.type) {
      case 'json_schema':
        return { type: 'json_schema', json_schema: { schema: format.schema, strict: true } };
      case 'json_object':
        return { type: 'json_object' };
      case 'text':
      default:
        return { type: 'text' };
    }
  }

  protected canonicalFinishReason(reason: string | null): GenerationResult['finishReason'] {
    switch (reason) {
      case 'stop':
      case 'tool_calls':
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

  private parseDataUrl(url: string): { mediaType: string; data: string } | null {
    const match = /^data:([^;]+);base64,(.+)$/.exec(url);
    const mediaType = match?.[1];
    const data = match?.[2];
    if (mediaType === undefined || data === undefined) return null;
    return { mediaType, data };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/models`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    const res = await fetch(url, { headers, signal });
    if (!res.ok) {
      throw new Error(`OpenAI /models returned HTTP ${res.status}`);
    }
    const raw: unknown = await res.json();
    const parsed = OpenAIModelListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `OpenAI /models parse failed: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      );
    }
    return (parsed.data.data ?? []).map((m) => ({ id: m.id, name: m.id }));
  }
}
