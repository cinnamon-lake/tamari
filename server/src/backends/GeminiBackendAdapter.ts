/**
 * Google Gemini backend adapter.
 *
 * Uses the Generative Language API (v1beta) with SSE streaming.
 * Supports text, vision, tool use, system instructions, and
 * structured outputs via response schema.
 *
 * Docs: https://ai.google.dev/api/generate-content
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
import { getMessageText } from '@tamari/types';
import { logDelta } from './RequestLogger.js';
import { executeRequest, type BaseAdapterConfig } from './executeRequest.js';
import {
  GeminiStreamChunkSchema,
  GeminiModelListSchema,
  type GeminiStreamChunk,
  type GeminiGenerateContentRequest,
  type GeminiGenerationConfig,
  type GeminiContent,
} from './types.js';
import { resolveLocalAttachmentUrl, parseDataUrl } from './resolveLocalAttachment.js';
import { readSseEvents } from './sseReader.js';

export interface GeminiAdapterConfig extends BaseAdapterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Static fallback used when the live `/models` listing is unreachable
 * (invalid key, offline, proxy without a listing route).
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextLength: 1_048_576 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextLength: 1_048_576 },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', contextLength: 1_048_576 },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextLength: 1_048_576 },
];

export class GeminiBackendAdapter implements BackendAdapter {
  readonly id = 'gemini';
  readonly supportsStreaming = true;
  readonly supportsTools = true;

  constructor(private config: GeminiAdapterConfig) {}

  async *stream(prompt: Prompt, signal: AbortSignal): AsyncGenerator<BackendStreamItem, GenerationResult> {
    const outcome = await executeRequest({
      adapterId: this.id,
      request: this.buildRequest(prompt),
      requestScript: this.config.requestScript,
      signal,
      promptTokens: prompt.tokenUsage.prompt,
    });
    if (!outcome.ok) return outcome.result;
    // Request-script print() output, as backend_debug parts before the response.
    for (const line of outcome.prints) yield { type: 'backendDebug', token: line + '\n' };

    let completionTokens = 0;
    let finishReason: string | null = null;
    let promptTokens = 0;
    let outputTokens = 0;
    const toolCalls: ToolCall[] = [];

    for await (const item of readSseEvents(outcome.body, signal)) {
      if (item.type === 'aborted') {
        return {
          finishReason: 'error',
          usage: {
            promptTokens: promptTokens || prompt.tokenUsage.prompt,
            completionTokens: outputTokens || completionTokens,
          },
          error: 'Aborted',
        };
      }
      if (item.type === 'done') continue;

      try {
        const raw: unknown = JSON.parse(item.data);
        const parsed = GeminiStreamChunkSchema.safeParse(raw);
        if (!parsed.success) continue;
        const chunk: GeminiStreamChunk = parsed.data;
        logDelta(this.id, chunk);
        const candidate = chunk.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text) {
              // Gemini 2.5+ thinking models may return thoughts with a flag
              if (part.thought === true) {
                yield { type: 'reasoning', token: part.text };
              } else {
                yield { type: 'text', token: part.text };
                completionTokens++;
              }
            }
            if (part.functionCall) {
              toolCalls.push({
                id: part.functionCall.name,
                name: part.functionCall.name,
                arguments: part.functionCall.args,
              });
            }
          }
        }
        if (candidate?.finishReason) {
          finishReason = candidate.finishReason;
        }
        if (chunk.usageMetadata) {
          promptTokens = chunk.usageMetadata.promptTokenCount ?? promptTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        }
      } catch (err) {
        logger.debug({ err, line: item.line }, 'Malformed SSE line in Gemini stream');
      }
    }

    return {
      finishReason: this.canonicalFinishReason(finishReason),
      usage: {
        promptTokens: promptTokens || prompt.tokenUsage.prompt,
        completionTokens: outputTokens || completionTokens,
      },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  buildRequest(prompt: Prompt): { url: string; init: RequestInit } {
    const modelName = this.config.model.startsWith('models/') ? this.config.model : `models/${this.config.model}`;
    const base = this.config.baseUrl.replace(/\/$/, '');
    const url = `${base}/${modelName}:streamGenerateContent?alt=sse&key=${this.config.apiKey}`;

    const body: GeminiGenerateContentRequest = this.buildRequestBody(prompt);

    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };

    return { url, init };
  }

  private buildRequestBody(prompt: Prompt): GeminiGenerateContentRequest {
    const contents = this.convertMessages(prompt.messages);
    const body: GeminiGenerateContentRequest = { contents };

    // System instruction — one part per system message, never joined.
    const systemParts = this.extractSystemParts(prompt);
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: systemParts };
    }

    // Tools
    if (prompt.tools && prompt.tools.length > 0) {
      body.tools = [{ functionDeclarations: this.convertTools(prompt.tools) }];
    }

    // Generation config. 0 = unset — omit maxOutputTokens rather than send an
    // invalid zero upstream.
    const generationConfig: GeminiGenerationConfig = {};
    if (prompt.tokenUsage.completion > 0) {
      generationConfig.maxOutputTokens = prompt.tokenUsage.completion;
    }

    // Response format
    if (prompt.responseFormat) {
      switch (prompt.responseFormat.type) {
        case 'json_schema':
          generationConfig.responseMimeType = 'application/json';
          generationConfig.responseSchema = prompt.responseFormat.schema;
          break;
        case 'json_object':
          generationConfig.responseMimeType = 'application/json';
          break;
      }
    }

    // Provider params: typed knobs are mapped onto the generationConfig fields
    // Gemini supports; keys Gemini has no field for are dropped — Gemini has
    // no provider-native override channel. Prompt-level params beat
    // config-level.
    const params = { ...this.config.params, ...prompt.params };
    if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
    if (params.topP !== undefined) generationConfig.topP = params.topP;
    if (params.topK !== undefined) generationConfig.topK = params.topK;
    if (params.seed !== undefined) generationConfig.seed = params.seed;
    if (Array.isArray(params.stop)) generationConfig.stopSequences = params.stop;

    body.generationConfig = generationConfig;
    return body;
  }

  /** One text part per system message — no joining. */
  private extractSystemParts(prompt: Prompt): Array<{ text: string }> {
    const parts: Array<{ text: string }> = [];
    for (const m of prompt.messages) {
      if (m.role !== 'system') continue;
      const text = getMessageText(m.content);
      if (text) parts.push({ text });
    }
    return parts;
  }

  private convertMessages(messages: PipelineMessage[]): GeminiContent[] {
    // Strip a trailing empty assistant message (created as a stream target).
    // "Empty" means text-only parts with blank joined text — a message carrying
    // tool_use/tool_result/reasoning parts is real history and must be kept.
    const lastMsg = messages[messages.length - 1];
    if (
      lastMsg &&
      lastMsg.role === 'assistant' &&
      lastMsg.content.every((p) => p.type === 'text') &&
      !getMessageText(lastMsg.content).trim() &&
      !lastMsg.reasoningFormatted
    ) {
      messages = messages.slice(0, -1);
    }

    const out: GeminiContent[] = [];

    for (const m of messages) {
      if (m.role === 'system') continue;

      // reasoningFormatted (a pre-rendered string) takes precedence when present.
      if (m.reasoningFormatted !== undefined) {
        out.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.reasoningFormatted }],
        });
        continue;
      }

      if (m.role === 'assistant') {
        let modelBuffer: ContentPart[] = [];
        for (const part of m.content) {
          if (part.type === 'tool_result') {
            if (modelBuffer.length > 0) {
              out.push({
                role: 'model',
                parts: this.convertParts(modelBuffer),
              });
              modelBuffer = [];
            }

            // Build functionResponse from text parts
            const textContent = Array.isArray(part.content)
              ? part.content
                  .filter((c): c is TextPart => c.type === 'text')
                  .map((c) => c.text)
                  .join('')
              : part.content;

            const userParts: unknown[] = [
              {
                functionResponse: {
                  name: part.name ?? '',
                  response: {
                    result: textContent,
                    ...(part.isError ? { error: textContent } : {}),
                  },
                },
              },
            ];

            // Append any media parts from the tool result
            if (Array.isArray(part.content)) {
              const mediaParts = part.content.filter(
                (c): c is Extract<ContentPart, { type: 'image' | 'audio' | 'video' }> =>
                  c.type === 'image' || c.type === 'audio' || c.type === 'video',
              );
              userParts.push(...this.convertParts(mediaParts));
            }

            out.push({
              role: 'user',
              parts: userParts,
            });
          } else {
            modelBuffer.push(part);
          }
        }
        if (modelBuffer.length > 0) {
          out.push({
            role: 'model',
            parts: this.convertParts(modelBuffer),
          });
        }
        continue;
      }

      // Only user/tool messages reach this point (system skipped above,
      // assistant handled by the parts/model branch and the reasoningFormatted
      // early-out) — Gemini has no tool role, so both render as user.
      out.push({
        role: 'user',
        parts: this.convertParts(m.content),
      });
    }

    return out;
  }

  private convertParts(parts: ContentPart[]): unknown[] {
    return parts
      .filter((part) => part.type !== 'reasoning') // Gemini has no native reasoning block
      .map((part) => {
        switch (part.type) {
          case 'text':
            return { text: part.text };
          case 'image':
          case 'audio':
          case 'video': {
            const resolved = resolveLocalAttachmentUrl(part.source, part.mimeType);
            if (resolved.startsWith('data:')) {
              const parsed = parseDataUrl(resolved);
              if (parsed) {
                return { inlineData: { mimeType: parsed.mediaType, data: parsed.data } };
              }
            }
            const defaultMime = part.type === 'image' ? 'image/png' : 'application/octet-stream';
            return { fileData: { mimeType: part.mimeType ?? defaultMime, fileUri: resolved } };
          }
          case 'tool_use':
            return { functionCall: { name: part.name, args: part.input } };
          case 'tool_result': {
            // Gemini expects function_response with the function name and a response object.
            const content = Array.isArray(part.content)
              ? part.content
                  .filter((c): c is TextPart => c.type === 'text')
                  .map((c) => c.text)
                  .join('')
              : part.content;
            return {
              functionResponse: {
                name: part.name ?? '',
                response: {
                  result: content,
                  ...(part.isError ? { error: content } : {}),
                },
              },
            };
          }
          default:
            return part;
        }
      });
  }

  private convertTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }

  private canonicalFinishReason(reason: string | null): GenerationResult['finishReason'] {
    switch (reason) {
      case 'STOP':
      case null:
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
      case 'RECITATION':
        return 'content_filter';
      default:
        return 'error';
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const base = this.config.baseUrl.replace(/\/$/, '');
      const res = await fetch(`${base}/models?key=${this.config.apiKey}`, { signal });
      if (!res.ok) return FALLBACK_MODELS;
      const raw: unknown = await res.json();
      const parsed = GeminiModelListSchema.safeParse(raw);
      if (!parsed.success) return FALLBACK_MODELS;
      const models = (parsed.data.models ?? [])
        .filter((m) => m.name.startsWith('models/gemini') && !m.name.includes('embedding'))
        .map((m) => {
          const id = m.name.replace(/^models\//, '');
          return { id, name: m.displayName ?? id, contextLength: m.inputTokenLimit };
        });
      return models.length > 0 ? models : FALLBACK_MODELS;
    } catch (err) {
      logger.warn({ err }, 'Gemini listModels failed, returning fallback');
      return FALLBACK_MODELS;
    }
  }
}
