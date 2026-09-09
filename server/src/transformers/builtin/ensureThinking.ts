/**
 * `ensure-thinking` builtin — for APIs where every assistant message must
 * carry a thinking block: prepend a placeholder reasoning part to assistant
 * messages that lack one.
 *
 * Representation: a standard `ReasoningPart` (`{ type: 'reasoning', text }`)
 * with no signature, inserted BEFORE the message's existing content (thinking
 * precedes text on every supported wire format). Adapter interplay:
 *   - OpenAI-family adapters re-send it as `reasoning_content`
 *     (OpenAIBackendAdapter flushAssistant).
 *   - Claude requires a signature for thinking blocks, so the unsigned
 *     placeholder degrades to plain inline text (ClaudeBackendAdapter
 *     convertParts).
 *
 * Assistant messages with no text at all (e.g. the empty trailing stream
 * target) are skipped — fabricating a thinking block for the message the
 * model is about to write would corrupt the continuation.
 */

import { z } from 'zod';
import type { PipelineMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { BuiltinTransformer } from '../types.js';

export const ensureThinkingParamsSchema = z.object({
  placeholder: z.string().default(''),
});

export const ensureThinking: BuiltinTransformer = {
  id: 'ensure-thinking',
  description:
    'Insert a placeholder reasoning (thinking) block into assistant messages that lack one — for APIs that require thinking on every assistant turn.',
  paramSchema: ensureThinkingParamsSchema,
  apply(messages: PipelineMessage[], params: unknown): PipelineMessage[] {
    const { placeholder } = ensureThinkingParamsSchema.parse(params ?? {});
    return messages.map((msg) => {
      if (msg.role !== 'assistant') return msg;
      if (!getMessageText(msg.content)) return msg;
      if (msg.content.some((p) => p.type === 'reasoning')) return msg;
      return { ...msg, content: [{ type: 'reasoning', text: placeholder }, ...msg.content] };
    });
  },
};
