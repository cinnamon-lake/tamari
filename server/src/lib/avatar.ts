/**
 * Shared avatar image processing utilities.
 */

import { createJimp, type JimpPlugin } from '@jimp/core';
import png from '@jimp/js-png';
import jpeg from '@jimp/js-jpeg';
import gif from '@jimp/js-gif';
import * as resizePlugin from '@jimp/plugin-resize';

export const Jimp = createJimp({
  formats: [png, jpeg, gif],
  plugins: [resizePlugin.methods as JimpPlugin],
});

export const AVATAR_MAX_SIZE = 512;
export const THUMBNAIL_MAX_SIZE = 96;

/**
 * Resize an image to fit within AVATAR_MAX_SIZE and return as PNG buffer.
 */
export async function resizeAvatar(buffer: Buffer): Promise<Buffer> {
  const image = await Jimp.read(buffer);
  if (image.bitmap.width > AVATAR_MAX_SIZE || image.bitmap.height > AVATAR_MAX_SIZE) {
    image.scaleToFit!({ w: AVATAR_MAX_SIZE, h: AVATAR_MAX_SIZE });
  }
  return image.getBuffer('image/png');
}

/**
 * Resize and center-crop an image to a THUMBNAIL_MAX_SIZE square and return as PNG buffer.
 * Matches CSS object-fit: cover behavior.
 */
export async function resizeThumbnail(buffer: Buffer): Promise<Buffer> {
  const image = await Jimp.read(buffer);
  const size = THUMBNAIL_MAX_SIZE;

  // Scale so the image covers a size×size square (CSS object-fit: cover)
  const scale = Math.max(size / image.bitmap.width, size / image.bitmap.height);
  if (scale < 1) {
    image.resize!({
      w: Math.round(image.bitmap.width * scale),
      h: Math.round(image.bitmap.height * scale),
    });
  }

  // Center crop to square
  const cropSize = Math.min(size, image.bitmap.width, image.bitmap.height);
  const x = Math.floor((image.bitmap.width - cropSize) / 2);
  const y = Math.floor((image.bitmap.height - cropSize) / 2);

  if (x !== 0 || y !== 0 || image.bitmap.width !== cropSize || image.bitmap.height !== cropSize) {
    const dst = Buffer.alloc(cropSize * cropSize * 4);
    for (let row = 0; row < cropSize; row++) {
      const srcOffset = ((y + row) * image.bitmap.width + x) * 4;
      const dstOffset = row * cropSize * 4;
      image.bitmap.data.copy(dst, dstOffset, srcOffset, srcOffset + cropSize * 4);
    }
    image.bitmap = { data: dst, width: cropSize, height: cropSize };
  }

  return image.getBuffer('image/png');
}
