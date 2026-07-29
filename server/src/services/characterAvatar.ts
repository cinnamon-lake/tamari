/**
 * Shared character-avatar pipeline: resize + thumbnail + swap + broadcast.
 *
 * Used by the REST avatar upload route (api/characters.ts) and the
 * workbench `run set_avatar` verb so both paths produce
 * identical files, DB state, and broadcasts.
 */

import { randomUUID } from 'node:crypto';
import type { Character } from '@tamari/types';
import { resizeAvatar, resizeThumbnail } from '../lib/avatar.js';
import type { FileStorage } from './FileStorage.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { ICharacterAssetRepository } from '../repos/CharacterAssetRepository.js';
import type { EventBus } from '../bus/EventBus.js';
import { toCharacterSummary, withCharacterAssets, withCharacterAvatar } from '../lib/summaries.js';

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
  const pngBuffer = await resizeAvatar(buffer);
  const thumbBuffer = await resizeThumbnail(buffer);

  const avatarFileName = `${randomUUID()}.png`;
  const thumbFileName = `${randomUUID()}.png`;
  const relPath = deps.storage.write('avatars', avatarFileName, new Uint8Array(pngBuffer));
  const thumbPath = deps.storage.write('avatars/thumbs', thumbFileName, new Uint8Array(thumbBuffer));

  // Delete old avatar files before updating the DB
  if (character.avatarPath) deps.storage.delete(character.avatarPath);
  if (character.avatarThumbnailPath) deps.storage.delete(character.avatarThumbnailPath);

  const updated = await deps.characters.update(character.id, { avatarPath: relPath, avatarThumbnailPath: thumbPath });

  // Same enrichment + broadcast set as the WS/REST update paths.
  const assetList = await deps.characterAssets.listForCharacter(updated.id);
  const enriched = withCharacterAssets(withCharacterAvatar(updated), assetList);
  deps.bus.broadcast({ type: 'character.updated', character: enriched });
  deps.bus.broadcast({ type: 'character.snapshot', character: enriched });
  const list = await deps.characters.listSummaries();
  deps.bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) });
  return enriched;
}
