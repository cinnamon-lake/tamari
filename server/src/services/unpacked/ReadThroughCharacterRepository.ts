/**
 * Read-through character repository — the write-guard chokepoint for unpacked
 * (on-disk) cards.
 *
 * Reads: rows whose id is in the UnpackedCardService registry get the parsed
 * folder content overlaid on the thin handle row (overlay.ts), so every
 * consumer — WS handlers, REST, StApi, workbench, generation — sees disk-fresh
 * content. Unknown `unpacked/`-prefixed ids (folder deleted but row lingering,
 * or the feature off) pass through the inner result unchanged.
 *
 * Writes: `create` rejects the reserved prefix (reserving the namespace), and
 * `update`/`delete` throw only for ids LIVE in the registry — orphan
 * `unpacked/`-prefixed rows (folder deleted, or the feature since disabled)
 * pass through to the inner repo so they can be cleaned up from the UI.
 * Folder removal on disk is the delete path for live cards
 * (UnpackedCardService owns it via the INNER repo).
 */

import type { Character, CharacterInsert, CharacterUpdate } from '@tamari/types';
import type { ICharacterRepository } from '../../repos/CharacterRepository.js';
import { overlayCharacter, overlayCharacterSummary } from './overlay.js';
import type { UnpackedCardRegistry } from './UnpackedCardService.js';
import { isUnpackedCardId, UNPACKED_ID_PREFIX } from './unpackedIds.js';

type ListOpts = {
  search?: string;
  tag?: string;
  limit?: number;
  offset?: number;
};

export class ReadThroughCharacterRepository implements ICharacterRepository {
  constructor(
    private inner: ICharacterRepository,
    private registry: UnpackedCardRegistry,
  ) {}

  private overlay(row: Character): Character {
    const entry = this.registry.get(row.id);
    return entry ? overlayCharacter(row, entry.parsed) : row;
  }

  async getById(id: string): Promise<Character | undefined> {
    const row = await this.inner.getById(id);
    return row ? this.overlay(row) : undefined;
  }

  async getByIds(ids: string[]): Promise<Character[]> {
    return (await this.inner.getByIds(ids)).map((row) => this.overlay(row));
  }

  async getByName(name: string): Promise<Character | undefined> {
    const row = await this.inner.getByName(name);
    return row ? this.overlay(row) : undefined;
  }

  async list(opts: ListOpts = {}): Promise<{ items: Character[]; total: number }> {
    const res = await this.inner.list(opts);
    return { items: res.items.map((row) => this.overlay(row)), total: res.total };
  }

  async listSummaries(opts: ListOpts = {}): Promise<{
    items: Array<
      Pick<Character, 'id' | 'name' | 'tags' | 'avatarPath' | 'avatarThumbnailPath' | 'external' | 'createdAt' | 'updatedAt'>
    >;
    total: number;
  }> {
    const res = await this.inner.listSummaries(opts);
    return {
      items: res.items.map((item) => {
        const entry = this.registry.get(item.id);
        return entry ? overlayCharacterSummary(item, entry.parsed) : item;
      }),
      total: res.total,
    };
  }

  async create(id: string, data: CharacterInsert): Promise<Character> {
    if (isUnpackedCardId(id)) {
      throw new Error(`Character id "${id}" uses the reserved '${UNPACKED_ID_PREFIX}' prefix (on-disk card folders)`);
    }
    return this.inner.create(id, data);
  }

  async update(id: string, patch: CharacterUpdate): Promise<Character> {
    this.rejectUnpackedWrite(id);
    return this.inner.update(id, patch);
  }

  async delete(id: string): Promise<void> {
    this.rejectUnpackedWrite(id);
    return this.inner.delete(id);
  }

  private rejectUnpackedWrite(id: string): void {
    const entry = isUnpackedCardId(id) ? this.registry.get(id) : undefined;
    if (!entry) return;
    throw new Error(`Card is unpacked (on-disk); edit the folder instead: ${entry.dir}`);
  }
}
