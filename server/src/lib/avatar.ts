/**
 * Shared avatar image processing utilities (sharp/libvips).
 */

import sharp from 'sharp';

export const AVATAR_MAX_SIZE = 512;
export const THUMBNAIL_MAX_SIZE = 96;

/**
 * Resize an image to fit within AVATAR_MAX_SIZE and return as PNG buffer.
 */
export async function resizeAvatar(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: AVATAR_MAX_SIZE, height: AVATAR_MAX_SIZE, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

/**
 * Resize and center-crop an image to a THUMBNAIL_MAX_SIZE square and return as PNG buffer.
 * sharp's `fit: 'cover'` is CSS object-fit: cover — scale to cover, then center crop.
 */
export async function resizeThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: THUMBNAIL_MAX_SIZE, height: THUMBNAIL_MAX_SIZE, fit: 'cover', position: 'center' })
    .png()
    .toBuffer();
}
