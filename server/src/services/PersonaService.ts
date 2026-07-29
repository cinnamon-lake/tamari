/**
 * Persona service — orchestrates persona lifecycle with cascading side effects.
 *
 * Encapsulates business logic that would otherwise leak into the dispatcher:
 * - deleting a persona must reassign chats to a fallback persona
 * - avatar files must be cleaned up after DB commit
 */

import type { Persona } from '@tamari/types';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { FileStorage } from './FileStorage.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('services/persona');

export type DeletePersonaResult =
  | {
      success: true;
      /** The persona that was deleted, if found. */
      persona?: Persona;
      /** Chat IDs whose personaId was reassigned. */
      affectedChatIds: string[];
      /** The fallback persona ID used for reassignment, or null. */
      fallbackPersonaId: string | null;
    }
  | {
      success: false;
      error: { message: string; code: string };
      /** Chat IDs whose personaId was reassigned. */
      affectedChatIds: string[];
      /** The fallback persona ID used for reassignment, or null. */
      fallbackPersonaId: string | null;
    };

export class PersonaService {
  constructor(
    private personas: IPersonaRepository,
    private chats: IChatRepository,
    private storage: FileStorage,
  ) {}

  async deletePersona(personaId: string): Promise<DeletePersonaResult> {
    const count = await this.personas.count();
    if (count <= 1) {
      return {
        success: false,
        error: { message: 'Cannot delete the last persona', code: 'FORBIDDEN' },
        affectedChatIds: [],
        fallbackPersonaId: null,
      };
    }

    const persona = await this.personas.getById(personaId);
    const remaining = await this.personas.listSummaries();
    const fallback = remaining.find((p) => p.id !== personaId);

    // Gather affected chats using a targeted query instead of loading every chat
    const affectedChatIds: string[] = [];
    if (fallback) {
      const affected = await this.chats.listChatSummaries({ personaId: personaId, limit: 10000 });
      affectedChatIds.push(...affected.items.map((c) => c.id));
    }

    // Atomically reassign chats and delete persona (repo owns the transaction)
    await this.personas.deleteAndReassign(personaId, fallback?.id ?? null);

    // Delete avatar files only after successful DB commit
    if (persona?.avatarPath) {
      try {
        this.storage.delete(persona.avatarPath);
      } catch (err) {
        log.warn({ err }, 'failed to delete persona avatar');
      }
    }
    if (persona?.avatarThumbnailPath) {
      try {
        this.storage.delete(persona.avatarThumbnailPath);
      } catch (err) {
        log.warn({ err }, 'failed to delete persona thumbnail');
      }
    }

    return {
      success: true,
      persona: persona ?? undefined,
      affectedChatIds,
      fallbackPersonaId: fallback?.id ?? null,
    };
  }
}
