/**
 * `strip-reasoning` builtin — remove reasoning / tool_use / tool_result parts
 * from every assistant message except the latest one (the continuation
 * target keeps its blocks so the model can continue coherently).
 *
 * Ported from ChatCompletionRenderer (the old `reasoningAddToPrompts: false`
 * path). Opt-in only: the default everywhere — renderer included — is that
 * prompts carry full thinking/reasoning blocks; stripping happens only when
 * a chain explicitly contains this step, enabled.
 */

import { z } from 'zod';
import type { PipelineMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { BuiltinTransformer } from '../types.js';

/** Index of the last assistant message (the streaming/continuation target). */
function latestAssistantIndex(messages: PipelineMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return i;
  }
  return -1;
}

export const stripReasoning: BuiltinTransformer = {
  id: 'strip-reasoning',
  description:
    'Strip reasoning and tool blocks from all assistant messages except the latest, keeping only their final text.',
  paramSchema: z.object({}),
  apply(messages: PipelineMessage[]): PipelineMessage[] {
    const latest = latestAssistantIndex(messages);
    return messages.map((msg, i) => {
      if (msg.role !== 'assistant' || i === latest) return msg;

      const stripped = msg.content.filter(
        (p) => p.type !== 'reasoning' && p.type !== 'tool_use' && p.type !== 'tool_result',
      );
      // Only keep the very last block if it's text; anything else is
      // effectively request corruption for a stripped old message. When
      // nothing text-like survives, fall back to the message's joined text
      // (mirrors the renderer's resolvedText fallback).
      const lastStripped = stripped[stripped.length - 1];
      if (lastStripped?.type === 'text') {
        return { ...msg, content: [lastStripped] };
      }
      return { ...msg, content: [{ type: 'text', text: getMessageText(msg.content) }] };
    });
  },
};
