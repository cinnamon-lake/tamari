/**
 * `group.*` messages — group-chat membership management.
 */

import { ValidationError } from '../errors.js';
import { enrichChatMember, getEnrichedChatMembers } from './helpers.js';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildGroupHandlers(
  deps: DispatcherDeps,
): Handlers<'group.members.get' | 'group.member.add' | 'group.member.remove' | 'group.member.update'> {
  const { bus, chats, chatMembers, chatMetaBroadcast } = deps;

  return {
    'group.members.get': async (client, msg) => {
      const enriched = await getEnrichedChatMembers(deps, msg.chatId);
      bus.sendTo(client.id, { type: 'group.members', chatId: msg.chatId, members: enriched });
    },

    'group.member.add': async (client, msg) => {
      const chat = await chats.getChatById(msg.chatId);
      if (!chat) throw new ValidationError('Chat not found');
      if (chat.characterId !== null) {
        bus.sendTo(client.id, {
          type: 'error',
          message: 'Cannot add members to a single-character chat',
          code: 'NOT_GROUP_CHAT',
        });
        return;
      }
      const member = await chatMembers.addMember(msg.chatId, msg.characterId);
      const enriched = await enrichChatMember(deps, member);
      chatMetaBroadcast.broadcastGroupMemberAdded(msg.chatId, enriched, client.id);
    },

    'group.member.remove': async (client, msg) => {
      await chatMembers.removeMember(msg.chatId, msg.characterId);
      chatMetaBroadcast.broadcastGroupMemberRemoved(msg.chatId, msg.characterId, client.id);
    },

    'group.member.update': async (client, msg) => {
      const member = await chatMembers.updateMember(msg.chatId, msg.characterId, msg.patch);
      const enriched = await enrichChatMember(deps, member);
      chatMetaBroadcast.broadcastGroupMemberUpdated(msg.chatId, enriched, client.id);
    },
  };
}
