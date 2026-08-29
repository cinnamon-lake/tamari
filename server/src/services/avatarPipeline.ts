/**
 * Shared avatar-swap pipeline: resize + thumbnail + storage swap + persist +
 * publish. Backs setCharacterAvatarFromBuffer / setPersonaAvatarFromBuffer
 * (characterAvatar.ts / personaAvatar.ts), which differ only in storage
 * directory, repository, enrichment, and broadcast event names.
 */

import { randomUUID } from 'node:crypto';
import { resizeAvatar, resizeThumbnail } from '../lib/avatar.js';
import type { FileStorage } from './FileStorage.js';

export interface AvatarEntity {
  id: string;
  avatarPath: string | null;
  avatarThumbnailPath: string | null;
}

export interface SetAvatarOptions<T extends AvatarEntity> {
  storage: FileStorage;
  /** Storage subdirectory ('avatars' for characters, 'personas' for personas). */
  storageDir: string;
  entity: T;
  buffer: Buffer;
  /** Persist the new avatar paths; returns the updated entity. */
  update: (id: string, paths: { avatarPath: string; avatarThumbnailPath: string }) => Promise<T>;
  /** Enrich the updated entity and broadcast the update/snapshot/list events. */
  publish: (updated: T) => Promise<T>;
}

/** Swap an entity's avatar from a raw image buffer. Returns the enriched entity. */
export async function setAvatarFromBuffer<T extends AvatarEntity>(options: SetAvatarOptions<T>): Promise<T> {
  const { storage, storageDir, entity, buffer, update, publish } = options;

  const pngBuffer = await resizeAvatar(buffer);
  const thumbBuffer = await resizeThumbnail(buffer);

  const avatarFileName = `${randomUUID()}.png`;
  const thumbFileName = `${randomUUID()}.png`;
  const avatarPath = storage.write(storageDir, avatarFileName, new Uint8Array(pngBuffer));
  const avatarThumbnailPath = storage.write(`${storageDir}/thumbs`, thumbFileName, new Uint8Array(thumbBuffer));

  // Delete old avatar files before updating the DB
  if (entity.avatarPath) storage.delete(entity.avatarPath);
  if (entity.avatarThumbnailPath) storage.delete(entity.avatarThumbnailPath);

  const updated = await update(entity.id, { avatarPath, avatarThumbnailPath });
  return publish(updated);
}
