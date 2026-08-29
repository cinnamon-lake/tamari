/**
 * Shared character-avatar pipeline: resize + thumbnail + swap + broadcast.
 *
 * Used by the REST avatar upload route (api/characters.ts) and the
 * workbench `run set_avatar` verb so both paths produce
 * identical files, DB state, and broadcasts.
 */

import type { Character } from '@tamari/types';
import type { FileStorage } from './FileStorage.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { ICharacterAssetRepository } from '../repos/CharacterAssetRepository.js';
import type { EventBus } from '../bus/EventBus.js';
import { toCharacterSummary, withCharacterAssets, withCharacterAvatar } from '../lib/summaries.js';
import { setAvatarFromBuffer } from './avatarPipeline.js';

export interface CharacterAvatarDeps {
  characters: ICharacterRepository;
  characterAssets: ICharacterAssetRepository;
  storage: FileStorage;
  bus: EventBus;
}

/** Set a character's avatar from a raw image buffer. Returns the enriched character. */
export async function setCharacterAvatarFromBuffer(
  deps: CharacterAvatarDeps,
  character: Character,
  buffer: Buffer,
): Promise<Character> {
  return setAvatarFromBuffer({
    storage: deps.storage,
    storageDir: 'avatars',
    entity: character,
    buffer,
    update: (id, paths) => deps.characters.update(id, paths),
    publish: async (updated) => {
      // Same enrichment + broadcast set as the WS/REST update paths.
      const assetList = await deps.characterAssets.listForCharacter(updated.id);
      const enriched = withCharacterAssets(withCharacterAvatar(updated), assetList);
      deps.bus.broadcast({ type: 'character.updated', character: enriched });
      deps.bus.broadcast({ type: 'character.snapshot', character: enriched });
      const list = await deps.characters.listSummaries();
      deps.bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) });
      return enriched;
    },
  });
}
