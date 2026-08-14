/**
 * Helpers shared across dispatch domain modules.
 */

import type { Chat, ChatMember, ChatMemberSummary } from '@tamari/types';
import type { ChatBroadcastService } from '../services/ChatBroadcastService.js';
import { toChatMemberSummary } from '../lib/summaries.js';
import type { DispatcherDeps } from './types.js';

/**
 * Rebroadcast the chat snapshot when an unmaterialized solo chat's greeting
 * may have changed (character/persona/userName edits), so open clients
 * re-render the resolved greeting.
 */
export async function maybeRebroadcastGreetingSnapshot(
  chatBroadcast: ChatBroadcastService,
  chat: Chat,
  senderId: string,
): Promise<void> {
  if (!chat.materialized && chat.characterId) {
    await chatBroadcast.broadcastSnapshot(chat.id, 30, senderId);
  }
}

/**
 * Fetch a group chat's members enriched with character data for the
 * `group.members` payload (client never looks up characters itself).
 */
export async function getEnrichedChatMembers(
  deps: Pick<DispatcherDeps, 'chatMembers' | 'characters'>,
  chatId: string,
): Promise<ChatMemberSummary[]> {
  const members = await deps.chatMembers.getMembers(chatId);
  const charIds = members.map((m) => m.characterId);
  const chars = await deps.characters.getByIds(charIds);
  const charMap = new Map(chars.map((c) => [c.id, c]));
  return members.map((m) => {
    const char = charMap.get(m.characterId);
    return char ? toChatMemberSummary(m, char) : (m as ChatMemberSummary);
  });
}

/** Enrich a single member row with its character (member add/update broadcasts). */
export async function enrichChatMember(
  deps: Pick<DispatcherDeps, 'characters'>,
  member: ChatMember,
): Promise<ChatMemberSummary> {
  const char = await deps.characters.getById(member.characterId);
  return char ? toChatMemberSummary(member, char) : (member as ChatMemberSummary);
}

/**
 * Top-level settings keys that must never reach a client. Server-side
 * consumers (scripts, backend factory) read the full blob via the repository;
 * the WS surface gets a filtered copy.
 */
export function isSecretSettingKey(key: string): boolean {
  return key === 'apiKey' || key.endsWith('.apiKey') || key.endsWith('.api_key');
}

/** Copy a settings blob with secret values removed (for client-bound messages). */
export function stripSecretSettings<T extends Record<string, unknown>>(blob: T): T {
  const out = { ...blob };
  for (const key of Object.keys(out)) {
    if (isSecretSettingKey(key)) delete out[key];
  }
  return out;
}
