/**
 * `history-squash` builtin — collapse the whole dialogue into ONE message,
 * covering the classic user-squash extension (target role 'user') and noass
 * (target role 'assistant') — the same transform differing only in role.
 *
 * Every user/assistant message with non-empty text is wrapped in its
 * per-role prefix/suffix (defaults `<userName>: ` / `<charName>: ` from the
 * transformer ctx — macros are already resolved at this stage), the wrapped
 * turns are joined with `separator` into a single message of the target
 * `role`, placed at the position of the first collapsed message. System and
 * tool messages are left untouched in place (preamble stays preamble,
 * jailbreak stays last); user/assistant messages with no text (e.g. the
 * empty trailing stream target) are also left in place.
 *
 * NoAss's exotic post-processing (history cropping, rearranging,
 * inter-split prompts, {{lastlines}}) is deliberately out of scope — Lua
 * transformer steps cover that. Note: incompatible with prompt caching (the
 * whole history block is rewritten every turn).
 */

import { z } from 'zod';
import type { PipelineMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { BuiltinTransformer, TransformerContext } from '../types.js';

export const historySquashParamsSchema = z.object({
  role: z.enum(['user', 'assistant']).default('user'),
  userPrefix: z.string().optional(),
  userSuffix: z.string().default(''),
  charPrefix: z.string().optional(),
  charSuffix: z.string().default(''),
  separator: z.string().default('\n\n'),
});

export const historySquash: BuiltinTransformer = {
  id: 'history-squash',
  description:
    "Collapse all user/assistant turns into a single message (role param: 'user' = classic user-squash, 'assistant' = noass), wrapping each turn with per-role prefix/suffix.",
  paramSchema: historySquashParamsSchema,
  apply(messages: PipelineMessage[], params: unknown, ctx: TransformerContext): PipelineMessage[] {
    const p = historySquashParamsSchema.parse(params ?? {});
    const userPrefix = p.userPrefix ?? `${ctx.userName}: `;
    const charPrefix = p.charPrefix ?? `${ctx.charName ?? 'Character'}: `;

    const turns: string[] = [];
    let firstIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const text = getMessageText(msg.content);
      if (!text) continue;
      if (firstIndex === -1) firstIndex = i;
      const prefix = msg.role === 'user' ? userPrefix : charPrefix;
      const suffix = msg.role === 'user' ? p.userSuffix : p.charSuffix;
      turns.push(`${prefix}${text}${suffix}`);
    }

    if (firstIndex === -1) return messages;

    const collapsed: PipelineMessage = { role: p.role, content: [{ type: 'text', text: turns.join(p.separator) }] };
    const result: PipelineMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      if (i === firstIndex) {
        result.push(collapsed);
        continue;
      }
      if ((msg.role === 'user' || msg.role === 'assistant') && getMessageText(msg.content)) continue;
      result.push(msg);
    }
    return result;
  },
};
