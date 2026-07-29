/**
 * Contract-drift regression tests between the hand-written TS types and the
 * Zod schemas in `@tamari/types`
 * (docs/quality/audits/interface-audit-2026-07-20.md, live bug #7 and theme T1):
 *
 * 1. `tool_result` content: the domain type `ToolResultPart.content` is
 *    `string | InlineContentPart[]` (pipeline.ts:44) and server templates
 *    actually produce array content (ForgeImageTemplate.ts:178), but
 *    `ContentPartSchema` (schemas.ts:991) only accepts `z.string()`. Any
 *    broadcast payload carrying such a part (e.g. `prompt.announced`) is
 *    rejected by `ServerMessageSchema` — and the client bus drops the whole
 *    message. The `satisfies` expressions below prove the payloads are legal
 *    per the TS domain types; the schema assertions FAIL today.
 *
 * 2. `action.swipe.messageId`: optional in the hand-written `ClientMessage`
 *    union (events.ts:195) but REQUIRED in `ClientMessageSchema`
 *    (schemas.ts:799). A swipe message that is legal per the TS type is
 *    rejected at the server boundary. FAILS today.
 */

import { describe, it, expect } from 'vitest';
import {
  ClientMessageSchema,
  PromptSchema,
  ServerMessageSchema,
  type ClientMessage,
  type PipelineMessage,
  type ToolResultPart,
} from '@tamari/types';

describe('@tamari/types contract drift', () => {
  // Exactly what ForgeImageTemplate.execute returns as `content` — an
  // InlineContentPart[] with a text part and the generated image.
  const toolResultPart = {
    type: 'tool_result',
    toolUseId: 'toolu_01',
    name: 'forge_generate_image',
    content: [
      { type: 'text', text: 'Generated image. Include: {{attachment::abc-123}}' },
      { type: 'image', source: '/api/attachments/abc-123', mimeType: 'image/png' },
    ],
  } satisfies ToolResultPart;

  const assistantMessage = {
    role: 'assistant',
    content: [toolResultPart],
  } satisfies PipelineMessage;

  it('PromptSchema accepts a tool_result part with InlineContentPart[] content', () => {
    const prompt = {
      messages: [assistantMessage],
      tokenUsage: { prompt: 10, completion: 5 },
    };

    const result = PromptSchema.safeParse(prompt);
    expect(result.success).toBe(true);
  });

  it('ServerMessageSchema accepts prompt.announced carrying array tool_result content', () => {
    const msg = {
      type: 'prompt.announced',
      generationId: 'gen-1',
      prompt: {
        messages: [assistantMessage],
        tokenUsage: { prompt: 10, completion: 5 },
      },
    };

    const result = ServerMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('ClientMessageSchema accepts action.swipe without messageId (optional in the TS union)', () => {
    // Legal per the hand-written ClientMessage union (messageId?: number) —
    // this object literal type-checks via `satisfies`.
    const msg = {
      type: 'action.swipe',
      chatId: 'chat-1',
      direction: 'right',
    } satisfies ClientMessage;

    const result = ClientMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });
});
