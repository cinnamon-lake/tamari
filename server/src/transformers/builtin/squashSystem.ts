/**
 * `squash-system` builtin — merge consecutive system messages into one,
 * keeping component boundaries as separate text parts joined by a
 * PROMPT_SEPARATOR part.
 *
 * This is now the ONLY squashing in the system: the renderer never merges
 * prompt components (each preset prompt / marker entry is its own message),
 * so this opt-in chain step is how a user asks for the old merged shape.
 * As a chain step it runs on the WHOLE rendered array — including history —
 * and can merge across the pre-history/history boundary.
 */

import { z } from 'zod';
import type { ContentPart, PipelineMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import { PROMPT_SEPARATOR } from '../../pipeline/renderers/Renderer.js';
import type { BuiltinTransformer } from '../types.js';

/** All-text parts? Then merging is just text concatenation. */
function isTextOnly(parts: ContentPart[]): boolean {
  return parts.every((p) => p.type === 'text');
}

export const squashSystem: BuiltinTransformer = {
  id: 'squash-system',
  description:
    'Merge consecutive system messages into one (components separated by a blank line). Runs on the whole rendered prompt, history included.',
  paramSchema: z.object({}),
  apply(messages: PipelineMessage[]): PipelineMessage[] {
    const result: PipelineMessage[] = [];
    let last: PipelineMessage | null = null;

    for (const msg of messages) {
      if (
        msg.role === 'system' &&
        last &&
        last.role === 'system' &&
        isTextOnly(last.content) &&
        isTextOnly(msg.content)
      ) {
        const merged: PipelineMessage = {
          ...last,
          content: [
            { type: 'text', text: getMessageText(last.content) + PROMPT_SEPARATOR + getMessageText(msg.content) },
          ],
        };
        last = merged;
      } else {
        if (last) result.push(last);
        last = msg;
      }
    }

    if (last) result.push(last);
    return result;
  },
};
