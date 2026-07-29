/**
 * Quick-reply workbench tool template.
 *
 * Lets the model list, create, and update quick replies, mirroring the
 * dispatcher's quickreply.* handlers. Create/update only — no delete, and no
 * quickreply_execute (model-triggered execution is deliberately out of scope).
 *
 * All errors are returned as `content` strings, never thrown.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { QuickReplyInsertSchema, QuickReplyUpdateSchema } from '@tamari/types';
import type { ToolContext, ToolExecuteResult } from '../ToolTemplate.js';
import type { EventBus } from '../../bus/EventBus.js';
import type { IQuickReplyRepository } from '../../repos/QuickReplyRepository.js';
import { broadcastQuickReplyList } from '../quickReplyBroadcast.js';

export interface QuickReplyWorkbenchDeps {
  quickReplies: IQuickReplyRepository;
  bus: EventBus;
}

const QuickReplyListArgs = z.object({
  scope: z.enum(['global', 'character', 'chat']).default('global').describe('Which scope to list.'),
  scopeId: z
    .string()
    .default('')
    .describe('Character or chat id for the character/chat scopes. Empty string for global.'),
});

const QuickReplyCreateArgs = QuickReplyInsertSchema;

const QuickReplyUpdateArgs = z.object({
  id: z.string().describe('Quick reply id (from quickreply_list).'),
  patch: QuickReplyUpdateSchema.describe('Fields to update.'),
});

export class QuickReplyWorkbench {

  constructor(private deps: QuickReplyWorkbenchDeps) {}

  async execute(toolName: string, args: Record<string, unknown>, _context?: ToolContext): Promise<ToolExecuteResult> {
    try {
      switch (toolName) {
        case 'quickreply_list':
          return await this.listQuickReplies(args);
        case 'quickreply_create':
          return await this.createQuickReply(args);
        case 'quickreply_update':
          return await this.updateQuickReply(args);
        default:
          return { content: `Error: unknown tool ${toolName}` };
      }
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async listQuickReplies(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = QuickReplyListArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const items = await this.deps.quickReplies.listByScope(parsed.data.scope, parsed.data.scopeId);
    return { content: JSON.stringify(items) };
  }

  private async createQuickReply(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = QuickReplyCreateArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const item = await this.deps.quickReplies.create(randomUUID(), parsed.data);
    // Same broadcasts as the quickreply.create dispatcher handler (no exclusion):
    // `.created` for snapshots, `.listed` so every client's list converges (§5).
    this.deps.bus.broadcast({ type: 'quickreply.created', item });
    await broadcastQuickReplyList(this.deps.bus, this.deps.quickReplies);
    return { content: JSON.stringify(item) };
  }

  private async updateQuickReply(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = QuickReplyUpdateArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const item = await this.deps.quickReplies.update(parsed.data.id, parsed.data.patch);
    this.deps.bus.broadcast({ type: 'quickreply.updated', item });
    await broadcastQuickReplyList(this.deps.bus, this.deps.quickReplies);
    return { content: JSON.stringify(item) };
  }
}
