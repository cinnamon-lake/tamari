/**
 * `squash-system` builtin — merge consecutive system messages with string
 * content into one, joined by PROMPT_SEPARATOR.
 *
 * Same merge rule as the renderer's group-local squash
 * (ChatCompletionRenderer.squashConsecutiveSystemMessages), but as a chain
 * step it runs on the WHOLE rendered array — including history — and can
 * merge across the pre-history/history boundary. The renderer keeps its own
 * group-local pass regardless (chains are per-backend-config and append-only
 * disables them), so this step is an opt-in extra, not a migration of the
 * renderer behavior.
 */

import { z } from 'zod';
import type { PipelineMessage } from '@tamari/types';
import { PROMPT_SEPARATOR } from '../../pipeline/renderers/Renderer.js';
import type { BuiltinTransformer } from '../types.js';

export const squashSystem: BuiltinTransformer = {
  id: 'squash-system',
  description:
    'Merge consecutive system messages into one (joined by a blank line). Runs on the whole rendered prompt, history included.',
  paramSchema: z.object({}),
  apply(messages: PipelineMessage[]): PipelineMessage[] {
    const result: PipelineMessage[] = [];
    let last: PipelineMessage | null = null;

    for (const msg of messages) {
      if (
        msg.role === 'system' &&
        last &&
        last.role === 'system' &&
        typeof last.content === 'string' &&
        typeof msg.content === 'string'
      ) {
        const merged: PipelineMessage = { ...last, content: last.content + PROMPT_SEPARATOR + msg.content };
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
