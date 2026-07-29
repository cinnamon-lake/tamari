/**
 * `persona.*` messages — selection, CRUD, greeting rebroadcast side effects.
 */

import { randomUUID } from 'node:crypto';
import { toPersonaSummary, withPersonaAvatar } from '../lib/summaries.js';
import { maybeRebroadcastGreetingSnapshot } from './helpers.js';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildPersonaHandlers(
  deps: DispatcherDeps,
): Handlers<'persona.select' | 'persona.list' | 'persona.create' | 'persona.update' | 'persona.delete'> {
  const { bus, chats, personas, personaService, chatBroadcast, chatMetaBroadcast } = deps;

  return {
    'persona.select': async (client, msg) => {
      const persona = await personas.getById(msg.personaId);
      if (!persona) {
        bus.sendTo(client.id, { type: 'error', message: 'Persona not found', code: 'NOT_FOUND' });
        return;
      }
      bus.broadcast({ type: 'persona.snapshot', persona: withPersonaAvatar(persona) }, client.id);
    },

    'persona.list': async (client, _msg) => {
      const list = await personas.listSummaries();
      bus.sendTo(client.id, { type: 'persona.listed', personas: list.map(toPersonaSummary) });
    },

    'persona.create': async (client, msg) => {
      const id = randomUUID();
      const persona = await personas.create(id, msg.data);
      bus.broadcast({ type: 'persona.created', persona: withPersonaAvatar(persona) }, client.id);
      bus.broadcast({ type: 'persona.snapshot', persona: withPersonaAvatar(persona) }, client.id);
      const list = await personas.listSummaries();
      bus.broadcast({ type: 'persona.listed', personas: list.map(toPersonaSummary) }, client.id);
    },

    'persona.update': async (client, msg) => {
      const persona = await personas.update(msg.personaId, msg.patch);
      bus.broadcast({ type: 'persona.updated', persona: withPersonaAvatar(persona) }, client.id);
      bus.broadcast({ type: 'persona.snapshot', persona: withPersonaAvatar(persona) }, client.id);
      const list = await personas.listSummaries();
      bus.broadcast({ type: 'persona.listed', personas: list.map(toPersonaSummary) }, client.id);
      const chatList = await chats.listChats({ personaId: msg.personaId, limit: 0 });
      for (const chat of chatList.items) {
        await maybeRebroadcastGreetingSnapshot(chatBroadcast, chat, client.id);
      }
    },

    'persona.delete': async (client, msg) => {
      const result = await personaService.deletePersona(msg.personaId);
      if (!result.success) {
        bus.sendTo(client.id, {
          type: 'error',
          message: result.error.message,
          code: result.error.code,
        });
        return;
      }
      for (const chatId of result.affectedChatIds) {
        const chat = await chats.getChatById(chatId);
        if (!chat) continue;
        chatMetaBroadcast.broadcastChatUpdated(chat, client.id);
        await maybeRebroadcastGreetingSnapshot(chatBroadcast, chat, client.id);
      }
      bus.broadcast({ type: 'persona.deleted', personaId: msg.personaId }, client.id);
      const list = await personas.listSummaries();
      bus.broadcast({ type: 'persona.listed', personas: list.map(toPersonaSummary) }, client.id);
    },
  };
}
