/**
 * Read-through world-info repository — serves the virtual `unpacked/<id>:book`
 * lorebook of an on-disk card from its parsed `lorebook/` folder, so the
 * generation pipeline (`worldInfo.getById(character.worldInfoId)` in
 * ChatPromptAssembly) reads disk-fresh entries with no row syncing.
 *
 * All other ids delegate to the inner repo. Writes to unpacked book ids throw —
 * lorebook edits happen in the folder, not the app.
 */

import type { WorldInfo, WorldInfoInsert, WorldInfoUpdate } from '@tamari/types';
import type { IWorldInfoRepository } from '../../repos/WorldInfoRepository.js';
import { buildUnpackedWorldInfo } from './overlay.js';
import type { UnpackedCardRegistry } from './UnpackedCardService.js';
import { isUnpackedWorldInfoId, unpackedCardIdFromWorldInfoId } from './unpackedIds.js';

export class ReadThroughWorldInfoRepository implements IWorldInfoRepository {
  constructor(
    private inner: IWorldInfoRepository,
    private registry: UnpackedCardRegistry,
  ) {}

  async getById(id: string): Promise<WorldInfo | undefined> {
    if (isUnpackedWorldInfoId(id)) {
      const entry = this.registry.get(unpackedCardIdFromWorldInfoId(id));
      if (entry) return buildUnpackedWorldInfo(id, entry.parsed);
      // Unknown/unloaded unpacked book — fall through to inner (normally absent).
    }
    return this.inner.getById(id);
  }

  /** Virtual books are not listed — they exist only as a card's linked lorebook. */
  async list(): Promise<WorldInfo[]> {
    return this.inner.list();
  }

  async create(id: string, data: WorldInfoInsert): Promise<WorldInfo> {
    this.rejectUnpackedWrite(id);
    return this.inner.create(id, data);
  }

  async update(id: string, patch: WorldInfoUpdate): Promise<WorldInfo> {
    this.rejectUnpackedWrite(id);
    return this.inner.update(id, patch);
  }

  async delete(id: string): Promise<void> {
    this.rejectUnpackedWrite(id);
    return this.inner.delete(id);
  }

  private rejectUnpackedWrite(id: string): void {
    if (!isUnpackedWorldInfoId(id)) return;
    const dir = this.registry.get(unpackedCardIdFromWorldInfoId(id))?.dir ?? 'unpacked-cards/ (under the server data dir)';
    throw new Error(`Lorebook is unpacked (on-disk); edit the card folder instead: ${dir}/lorebook/`);
  }
}
