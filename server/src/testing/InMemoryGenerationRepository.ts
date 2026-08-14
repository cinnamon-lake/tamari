/**
 * InMemoryGenerationRepository — Map-backed IGenerationRepository for
 * card-testing sessions. Full (small) interface: generation records live
 * next to the in-memory chat state, so traces stay inspectable via
 * TestSessionService.state without touching the DB.
 */

import type { Generation, GenerationInsert } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import type { IGenerationRepository } from '../repos/GenerationRepository.js';

export class InMemoryGenerationRepository implements IGenerationRepository {
  private generations = new Map<string, Generation>();

  async getById(id: string): Promise<Generation | undefined> {
    return this.generations.get(id);
  }

  async listByChat(chatId: string): Promise<Generation[]> {
    // Newest first, like GenerationRepository.listByChat.
    return [...this.generations.values()]
      .filter((g) => g.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  async create(id: string, data: Omit<GenerationInsert, 'id'>): Promise<Generation> {
    const now = Math.floor(Date.now() / 1000);
    const generation: Generation = {
      id,
      chatId: data.chatId,
      messageId: data.messageId ?? null,
      status: data.status,
      backend: data.backend,
      promptTokens: data.promptTokens ?? null,
      completionTokens: data.completionTokens ?? null,
      errorMessage: data.errorMessage ?? null,
      kind: data.kind ?? 'send',
      parentId: data.parentId ?? null,
      meta: data.meta ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.generations.set(id, generation);
    return generation;
  }

  async update(id: string, patch: Partial<Omit<Generation, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Generation> {
    const existing = this.generations.get(id);
    if (!existing) throw new NotFoundError('Generation', id);
    Object.assign(existing, patch);
    existing.updatedAt = Math.floor(Date.now() / 1000);
    return existing;
  }

  async delete(id: string): Promise<void> {
    if (!this.generations.delete(id)) throw new NotFoundError('Generation', id);
  }

  /** Drop every record for a chat (session teardown; not part of the interface). */
  deleteByChat(chatId: string): void {
    for (const [id, g] of this.generations) {
      if (g.chatId === chatId) this.generations.delete(id);
    }
  }
}
