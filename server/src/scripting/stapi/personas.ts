/**
 * st-api domain: personas — persona queries and assigning the chat persona.
 */

import { FULL_BRANCH_MESSAGE_LIMIT, type StApiContext } from './context.js';
import type { StApi } from './types.js';

export type PersonasApi = Pick<StApi, 'get_personas' | 'get_persona' | 'set_persona' | 'get_persona_id'>;

export function createPersonas(c: StApiContext): PersonasApi {
  const { chats, personas, chatBroadcast, chatMetaBroadcast } = c.deps;
  const { chatId, checkAbort } = c;

  return {
    get_personas: async () => {
      checkAbort();
      const list = await personas.listSummaries();
      return list.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
      }));
    },

    get_persona: async (id: string) => {
      checkAbort();
      if (typeof id !== 'string') throw new Error('get_persona: expected string');
      const p = await personas.getById(id);
      if (!p) return null;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
      };
    },

    set_persona: async (personaId: string) => {
      checkAbort();
      if (typeof personaId !== 'string') throw new Error('set_persona: expected string');
      const persona = await personas.getById(personaId);
      if (!persona) throw new Error(`set_persona: persona "${personaId}" not found`);
      const updatedChat = await chats.updateChat(chatId, { personaId });
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
      // personaId is structural (drives chatPersona/greeting) → refresh via snapshot.
      await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
    },

    get_persona_id: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      return chat?.personaId ?? null;
    },
  };
}
