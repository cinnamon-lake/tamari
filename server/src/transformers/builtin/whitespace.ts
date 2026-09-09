/**
 * `whitespace` builtin — normalize whitespace in the text parts of outgoing
 * messages at request time. Replaces the former global `whitespaceMode`
 * setting's send-time input pass and settle-time output pass (both deleted;
 * stored messages now stay verbatim and the transform applies per request).
 *
 * Modes:
 *   - 'none': no-op.
 *   - 'trim': trim leading/trailing whitespace (the old 'essential').
 *   - 'full': trim, then collapse whitespace runs — runs containing a newline
 *     become '\n\n', others a single space (the old input-pass semantics).
 */

import { z } from 'zod';
import type { ContentPart, PipelineMessage } from '@tamari/types';
import type { BuiltinTransformer, TransformerContext } from '../types.js';

export const whitespaceParamsSchema = z.object({
  mode: z.enum(['none', 'trim', 'full']).default('none'),
});

function applyMode(content: string, mode: 'none' | 'trim' | 'full'): string {
  if (mode === 'none') return content;
  let result = content.trim();
  if (mode === 'full') {
    result = result.replace(/\s+/g, (match) => (match.includes('\n') ? '\n\n' : ' '));
  }
  return result;
}

function mapTextParts(content: ContentPart[], mode: 'none' | 'trim' | 'full'): ContentPart[] {
  return content.map((p) => (p.type === 'text' ? { ...p, text: applyMode(p.text, mode) } : p));
}

export const whitespace: BuiltinTransformer = {
  id: 'whitespace',
  description:
    "Normalize whitespace in message text: 'trim' strips leading/trailing whitespace, 'full' also collapses internal runs.",
  paramSchema: whitespaceParamsSchema,
  apply(messages: PipelineMessage[], params: unknown, _ctx: TransformerContext): PipelineMessage[] {
    const { mode } = whitespaceParamsSchema.parse(params ?? {});
    if (mode === 'none') return messages;
    return messages.map((m) => ({ ...m, content: mapTextParts(m.content, mode) }));
  },
};
