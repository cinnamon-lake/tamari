/**
 * Shared group-chat membership logic.
 *
 * Used by the Lua `st` API (scripting/StApi.ts) and the chat workbench
 * tool template so both paths validate and broadcast identically.
 * Functions throw plain Errors; callers decide how to surface them.
 */

import type { Character, ChatMember } from '@tamari/types';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { IChatMemberRepository } from '../repos/ChatMemberRepository.js';
import type { ChatMetaBroadcastService } from './ChatMetaBroadcastService.js';
import { toChatMemberSummary } from '../lib/summaries.js';

export interface ChatMembershipDeps {
  chats: IChatRepository;
  characters: ICharacterRepository;
  chatMembers: IChatMemberRepository;
  chatMetaBroadcast: Pick<ChatMetaBroadcastService, 'broadcastGroupMemberAdded' | 'broadcastGroupMemberRemoved'>;
}

async function requireGroupChatAndCharacter(
  deps: ChatMembershipDeps,
  fn: string,
  chatId: string,
  characterId: string,
): Promise<Character> {
  const chat = await deps.chats.getChatById(chatId);
  if (!chat) throw new Error(`${fn}: chat not found`);
  if (chat.characterId !== null) {
    throw new Error(`${fn}: cannot manage members on a single-character chat`);
  }
  const character = await deps.characters.getById(characterId);
  if (!character) throw new Error(`${fn}: character "${characterId}" not found`);
  return character;
}

export async function addChatMember(deps: ChatMembershipDeps, chatId: string, characterId: string): Promise<ChatMember> {
  const character = await requireGroupChatAndCharacter(deps, 'add_chat_member', chatId, characterId);
  const member = await deps.chatMembers.addMember(chatId, characterId);
  deps.chatMetaBroadcast.broadcastGroupMemberAdded(chatId, toChatMemberSummary(member, character));
  return member;
}

export async function removeChatMember(deps: ChatMembershipDeps, chatId: string, characterId: string): Promise<void> {
  await requireGroupChatAndCharacter(deps, 'remove_chat_member', chatId, characterId);
  await deps.chatMembers.removeMember(chatId, characterId);
  deps.chatMetaBroadcast.broadcastGroupMemberRemoved(chatId, characterId);
}
