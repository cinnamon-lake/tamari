/**
 * st-api domain: characters — character queries, create/update, chat
 * membership, system prompts, and tags.
 */

import { createCharacter, updateCharacter } from '../../services/characterMutations.js';
import { addChatMember, removeChatMember } from '../../services/chatMembership.js';
import { FULL_BRANCH_MESSAGE_LIMIT, type StApiContext } from './context.js';
import type { StApi } from './types.js';

export type CharactersApi = Pick<
  StApi,
  | 'get_characters'
  | 'find_character'
  | 'get_character'
  | 'set_character'
  | 'get_character_id'
  | 'get_character_name'
  | 'create_character'
  | 'update_character'
  | 'add_chat_member'
  | 'remove_chat_member'
  | 'set_system_prompt'
  | 'get_system_prompt'
  | 'tag_add'
  | 'tag_remove'
  | 'tag_list'
>;

export function createCharacters(c: StApiContext): CharactersApi {
  const { chats, characters, chatMembers, bus, chatBroadcast, chatMetaBroadcast } = c.deps;
  const { chatId, checkAbort } = c;

  return {
    get_characters: async () => {
      checkAbort();
      const list = await characters.list();
      return list.items.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        personality: c.personality,
        scenario: c.scenario,
      }));
    },

    find_character: async (name: string) => {
      checkAbort();
      if (typeof name !== 'string') throw new Error('find_character: expected string');
      const c = await characters.getByName(name);
      if (!c) return null;
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        personality: c.personality,
        scenario: c.scenario,
      };
    },

    get_character: async (id: string) => {
      checkAbort();
      if (typeof id !== 'string') throw new Error('get_character: expected string');
      const c = await characters.getById(id);
      if (!c) return null;
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        personality: c.personality,
        scenario: c.scenario,
        firstMes: c.firstMes,
        mesExample: c.mesExample,
        creatorNotes: c.creatorNotes,
        systemPrompt: c.systemPrompt,
        postHistoryInstructions: c.postHistoryInstructions,
        extensions: c.extensions,
      };
    },

    set_character: async (characterId: string) => {
      checkAbort();
      if (typeof characterId !== 'string') throw new Error('set_character: expected string');
      const character = await characters.getById(characterId);
      if (!character) throw new Error(`set_character: character "${characterId}" not found`);
      const updatedChat = await chats.updateChat(chatId, { characterId });
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
      // characterId is structural (drives chatCharacter/greeting) → refresh via snapshot.
      await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
    },

    get_character_id: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      return chat?.characterId ?? null;
    },

    get_character_name: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat?.characterId) return null;
      const character = await characters.getById(chat.characterId);
      return character?.name ?? null;
    },

    create_character: async (data: unknown) => {
      checkAbort();
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('create_character: expected table');
      }
      try {
        const character = await createCharacter({ characters, bus }, data as Record<string, unknown>);
        return { id: character.id, name: character.name };
      } catch (err) {
        throw new Error(`create_character: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    },

    update_character: async (characterId: string, patch: unknown) => {
      checkAbort();
      if (typeof characterId !== 'string' || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('update_character: expected (string, table)');
      }
      try {
        await updateCharacter({ characters, bus }, characterId, patch as Record<string, unknown>);
      } catch (err) {
        throw new Error(`update_character: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    },

    add_chat_member: async (characterId: string) => {
      checkAbort();
      if (typeof characterId !== 'string') throw new Error('add_chat_member: expected string');
      await addChatMember({ chats, characters, chatMembers, chatMetaBroadcast }, chatId, characterId);
    },

    remove_chat_member: async (characterId: string) => {
      checkAbort();
      if (typeof characterId !== 'string') throw new Error('remove_chat_member: expected string');
      await removeChatMember({ chats, characters, chatMembers, chatMetaBroadcast }, chatId, characterId);
    },

    set_system_prompt: async (characterId: string, text: string) => {
      checkAbort();
      if (typeof characterId !== 'string' || typeof text !== 'string') {
        throw new Error('set_systemPrompt: expected (string, string)');
      }
      const character = await characters.getById(characterId);
      if (!character) throw new Error(`set_systemPrompt: character "${characterId}" not found`);
      await characters.update(characterId, { systemPrompt: text });
      const updated = await characters.getById(characterId);
      if (updated) bus.broadcast({ type: 'character.updated', character: updated });
    },

    get_system_prompt: async (characterId: string) => {
      checkAbort();
      if (typeof characterId !== 'string') throw new Error('get_systemPrompt: expected string');
      const character = await characters.getById(characterId);
      if (!character) return null;
      return character.systemPrompt;
    },

    tag_add: async (characterId: string, tag: string) => {
      checkAbort();
      if (typeof characterId !== 'string' || typeof tag !== 'string') {
        throw new Error('tag_add: expected (string, string)');
      }
      const character = await characters.getById(characterId);
      if (!character) throw new Error(`tag_add: character "${characterId}" not found`);
      const tags = new Set(character.tags);
      tags.add(tag);
      await characters.update(characterId, { tags: Array.from(tags) });
      const updated = await characters.getById(characterId);
      if (updated) bus.broadcast({ type: 'character.updated', character: updated });
    },

    tag_remove: async (characterId: string, tag: string) => {
      checkAbort();
      if (typeof characterId !== 'string' || typeof tag !== 'string') {
        throw new Error('tag_remove: expected (string, string)');
      }
      const character = await characters.getById(characterId);
      if (!character) throw new Error(`tag_remove: character "${characterId}" not found`);
      const tags = character.tags.filter((t) => t !== tag);
      await characters.update(characterId, { tags });
      const updated = await characters.getById(characterId);
      if (updated) bus.broadcast({ type: 'character.updated', character: updated });
    },

    tag_list: async (characterId: string) => {
      checkAbort();
      if (typeof characterId !== 'string') throw new Error('tag_list: expected string');
      const character = await characters.getById(characterId);
      if (!character) throw new Error(`tag_list: character "${characterId}" not found`);
      return character.tags;
    },
  };
}
