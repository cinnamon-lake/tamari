/**
 * Shared persona-avatar pipeline: resize + thumbnail + swap + broadcast.
 *
 * Persona-side call site of avatarPipeline.ts — used by the REST avatar
 * upload route (api/personas.ts) so the HTTP path produces the same files,
 * DB state, and broadcasts as the WS persona.update path.
 */

import type { Persona } from '@tamari/types';
import type { FileStorage } from './FileStorage.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { EventBus } from '../bus/EventBus.js';
import { toPersonaSummary, withPersonaAvatar } from '../lib/summaries.js';
import { setAvatarFromBuffer } from './avatarPipeline.js';

export interface PersonaAvatarDeps {
  personas: IPersonaRepository;
  storage: FileStorage;
  bus: EventBus;
}

/** Set a persona's avatar from a raw image buffer. Returns the enriched persona. */
export async function setPersonaAvatarFromBuffer(
  deps: PersonaAvatarDeps,
  persona: Persona,
  buffer: Buffer,
): Promise<Persona> {
  return setAvatarFromBuffer({
    storage: deps.storage,
    storageDir: 'personas',
    entity: persona,
    buffer,
    update: (id, paths) => deps.personas.update(id, paths),
    publish: async (updated) => {
      // Enrich identically to the WS update path (dispatch/personaHandlers.ts persona.update):
      // the same enriched object for .updated and .snapshot, plus a .listed so the
      // persona sidebar stays in sync. A raw .snapshot here previously clobbered
      // activePersona and dropped avatarUrl/avatarUploadUrl.
      const enriched = withPersonaAvatar(updated);
      deps.bus.broadcast({ type: 'persona.updated', persona: enriched });
      deps.bus.broadcast({ type: 'persona.snapshot', persona: enriched });
      const list = await deps.personas.listSummaries();
      deps.bus.broadcast({ type: 'persona.listed', personas: list.map(toPersonaSummary) });
      return enriched;
    },
  });
}
