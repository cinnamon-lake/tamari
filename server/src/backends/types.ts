/**
 * Typed request bodies and response schemas for backend adapters.
 *
 * Request interfaces represent the canonical shape each adapter sends.
 * Response schemas are non-strict (passthrough) so unknown fields from
 * providers don't cause parse failures.
 */

import { z } from 'zod';
import type { MessageRole } from '@tamari/types';

/** Narrow an unknown value to a mutable object record (e.g. a provider content part). */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ===========================================================================
// OpenAI-compatible (OpenAI, OpenRouter, Moonshot, TextCompletion)
// ===========================================================================

export interface OpenAIChatMessage {
  role: MessageRole;
  content?: string | unknown[] | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  min_p?: number;
  top_a?: number;
  logit_bias?: Record<string, number> | Array<[number, number]>;
  stop?: string | string[];
  tool_choice?: string | { type: 'function'; function: { name: string } };
  tools?: unknown[];
  response_format?: Record<string, unknown>;
  seed?: number;
  // Provider-specific extensions
  reasoning_effort?: string;
  [key: string]: unknown;
}

export const OpenAIStreamChunkSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(
        z.object({
          delta: z
            .object({
              content: z.string().nullable().optional(),
              reasoning: z.string().nullable().optional(),
              reasoning_content: z.string().nullable().optional(),
              role: z.string().nullable().optional(),
              tool_calls: z
                .array(
                  z
                    .object({
                      index: z.number(),
                      id: z.string().nullable().optional(),
                      type: z.string().nullable().optional(),
                      function: z
                        .object({
                          name: z.string().nullable().optional(),
                          arguments: z.string().nullable().optional(),
                        })
                        .passthrough()
                        .optional(),
                    })
                    .passthrough(),
                )
                .optional(),
            })
            .passthrough(),
          finish_reason: z.string().nullable().optional(),
        }).passthrough(),
      )
      .optional(),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type OpenAIStreamChunk = z.infer<typeof OpenAIStreamChunkSchema>;

export const OpenAIModelListSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
      }),
    )
    .optional(),
});

export type OpenAIModelList = z.infer<typeof OpenAIModelListSchema>;

// ===========================================================================
// Claude
// ===========================================================================

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | unknown[];
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: unknown;
  strict?: boolean;
}

export interface ClaudeMessageRequest {
  model: string;
  max_tokens: number;
  messages: ClaudeMessage[];
  stream: boolean;
  system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: string; ttl?: string } }>;
  tools?: ClaudeTool[];
  tool_choice?: string | { type: 'tool'; name: string };
  stop_sequences?: string[] | null;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  metadata?: Record<string, unknown>;
  thinking?: { type: 'enabled'; budget_tokens: number };
  output_config?: { format: Record<string, unknown> };
  [key: string]: unknown;
}

export const ClaudeStreamEventSchema = z
  .object({
    type: z.string(),
    index: z.number().optional(),
    delta: z
      .object({
        type: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
        thinking: z.string().nullable().optional(),
        signature: z.string().nullable().optional(),
        stop_reason: z.string().nullable().optional(),
        stop_sequence: z.string().nullable().optional(),
        partial_json: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    content_block: z
      .object({
        type: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
        thinking: z.string().nullable().optional(),
        signature: z.string().nullable().optional(),
        id: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    message: z
      .object({
        usage: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type ClaudeStreamEvent = z.infer<typeof ClaudeStreamEventSchema>;

export const ClaudeModelListSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        display_name: z.string().optional(),
        max_input_tokens: z.number().optional(),
      }),
    )
    .optional(),
});

export type ClaudeModelList = z.infer<typeof ClaudeModelListSchema>;

// ===========================================================================
// Gemini
// ===========================================================================

export interface GeminiContent {
  role?: 'user' | 'model';
  parts: unknown[];
}

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: unknown[] }>;
  generationConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

export const GeminiStreamChunkSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            content: z
              .object({
                role: z.string().optional(),
                parts: z
                  .array(
                    z
                      .object({
                        text: z.string().nullable().optional(),
                        thought: z.boolean().optional(),
                        functionCall: z
                          .object({
                            name: z.string(),
                            args: z.record(z.string(), z.unknown()),
                          })
                          .passthrough()
                          .optional(),
                        functionResponse: z
                          .object({
                            name: z.string(),
                            response: z.record(z.string(), z.unknown()),
                          })
                          .passthrough()
                          .optional(),
                      })
                      .passthrough(),
                  )
                  .optional(),
              })
              .passthrough()
              .optional(),
            finishReason: z.string().optional(),
            safetyRatings: z
              .array(
                z
                  .object({
                    category: z.string(),
                    probability: z.string(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    usageMetadata: z
      .object({
        promptTokenCount: z.number().optional(),
        candidatesTokenCount: z.number().optional(),
        totalTokenCount: z.number().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type GeminiStreamChunk = z.infer<typeof GeminiStreamChunkSchema>;

export const GeminiModelListSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        displayName: z.string().optional(),
        inputTokenLimit: z.number().optional(),
      }),
    )
    .optional(),
});

export type GeminiModelList = z.infer<typeof GeminiModelListSchema>;

// ===========================================================================
// KoboldCpp
// ===========================================================================

export interface KoboldCppGenerateRequest {
  prompt: string;
  max_context_length: number;
  max_length: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  rep_pen?: number;
  rep_pen_range?: number;
  rep_pen_slope?: number;
  min_p?: number;
  top_a?: number;
  typical?: number;
  tfs?: number;
  sampler_seed?: number;
  sampler_order?: number[];
  mirostat?: number;
  mirostat_tau?: number;
  mirostat_eta?: number;
  grammar?: string;
  stop_sequence?: string[];
  use_default_badwordsids?: boolean;
  singleline?: boolean;
  [key: string]: unknown;
}

export const KoboldStreamEventSchema = z
  .object({
    token: z.string().nullable().optional(),
    finish_reason: z.string().optional(),
  })
  .passthrough();

export type KoboldStreamEvent = z.infer<typeof KoboldStreamEventSchema>;

// ===========================================================================
// LlamaCpp (native /completion endpoint)
// ===========================================================================

export interface LlamaCppCompletionRequest {
  prompt: string;
  stream: boolean;
  n_predict?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  min_p?: number;
  top_a?: number;
  typical_p?: number;
  tfs_z?: number;
  logit_bias?: Array<[number, number]> | Record<string, number>;
  stop?: string[];
  seed?: number;
  [key: string]: unknown;
}

export const LlamaCppStreamChunkSchema = z
  .object({
    content: z.string().nullable().optional(),
    stop: z.boolean().optional(),
    generation_settings: z.record(z.string(), z.unknown()).optional(),
    model: z.string().optional(),
    tokens_predicted: z.number().optional(),
    tokens_evaluated: z.number().optional(),
    stopped_eos: z.boolean().optional(),
    stopped_limit: z.boolean().optional(),
    stopped_word: z.boolean().optional(),
  })
  .passthrough();

export type LlamaCppStreamChunk = z.infer<typeof LlamaCppStreamChunkSchema>;

// ===========================================================================
// TextCompletion (OpenAI /completions)
// ===========================================================================

export interface TextCompletionRequest {
  model: string;
  prompt: string;
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  min_p?: number;
  top_a?: number;
  logit_bias?: Record<string, number> | Array<[number, number]>;
  stop?: string | string[];
  seed?: number;
  [key: string]: unknown;
}

export const TextCompletionStreamChunkSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            text: z.string().nullable().optional(),
            delta: z.object({ text: z.string().nullable().optional() }).passthrough().optional(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type TextCompletionStreamChunk = z.infer<typeof TextCompletionStreamChunkSchema>;

// ===========================================================================
// OpenRouter
// ===========================================================================

export interface OpenRouterChatCompletionRequest extends OpenAIChatCompletionRequest {
  transforms?: string[];
  plugins?: Array<{ id: string }>;
  provider?: {
    order?: string[];
    allow_fallbacks?: boolean;
  };
  reasoning?: {
    effort?: string;
    summary?: string;
  };
}

export const OpenRouterStreamChunkSchema = OpenAIStreamChunkSchema.extend({
  // OpenRouter may include provider-specific deltas
});

export type OpenRouterStreamChunk = z.infer<typeof OpenRouterStreamChunkSchema>;

export const OpenRouterModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    context_length: z.number().optional(),
    pricing: z
      .object({
        prompt: z.union([z.string(), z.number()]).optional(),
        completion: z.union([z.string(), z.number()]).optional(),
        image: z.union([z.string(), z.number()]).optional(),
        request: z.union([z.string(), z.number()]).optional(),
      })
      .optional(),
    top_provider: z
      .object({
        context_length: z.union([z.number(), z.null()]).optional(),
        max_completion_tokens: z.union([z.number(), z.null()]).optional(),
        is_moderated: z.boolean().optional(),
      })
      .optional(),
    architecture: z
      .object({
        modality: z.string().optional(),
        tokenizer: z.string().optional(),
        input_modalities: z.array(z.string()).optional(),
        output_modalities: z.array(z.string()).optional(),
      })
      .optional(),
    per_request_limits: z.unknown().optional(),
  })
  .passthrough();

export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

export const OpenRouterModelListSchema = z.object({
  data: z.array(OpenRouterModelSchema).optional(),
});

export type OpenRouterModelList = z.infer<typeof OpenRouterModelListSchema>;

// ===========================================================================
// Moonshot
// ===========================================================================

export const MoonshotModelSchema = z
  .object({
    id: z.string(),
    object: z.string().optional(),
    created: z.number().optional(),
    owned_by: z.string().optional(),
    context_length: z.number().optional(),
    supports_image_in: z.boolean().optional(),
    supports_video_in: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
  })
  .passthrough();

export type MoonshotModel = z.infer<typeof MoonshotModelSchema>;

export const MoonshotModelListSchema = z.object({
  data: z.array(MoonshotModelSchema).optional(),
});

export type MoonshotModelList = z.infer<typeof MoonshotModelListSchema>;
