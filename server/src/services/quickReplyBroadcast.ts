/**
 * Shared quick-reply list rebroadcast (AGENTS.md §5: `.listed` owns client lists).
 *
 * A per-view merged list can't be broadcast — each client's view depends on its
 * active chat, which the dumb bus doesn't track — so the full table (all scopes)
 * goes to all clients; QuickReplyBar/QuickReplySettings filter by scope at render
 * time (same philosophy as EventBus: clients ignore what they don't render).
 */

import type { EventBus } from '../bus/EventBus.js';
import type { IQuickReplyRepository } from '../repos/QuickReplyRepository.js';

export async function broadcastQuickReplyList(
  bus: EventBus,
  quickReplies: IQuickReplyRepository,
  originatorId?: string,
): Promise<void> {
  const items = await quickReplies.listAll();
  bus.broadcast({ type: 'quickreply.listed', items }, originatorId);
}
