/**
 * Decompression-bomb guard for in-memory `fflate.unzipSync` extraction.
 *
 * Uploads cap the compressed size, but a crafted archive can expand ~1000×
 * and OOM the server. The filter callback sees each entry's UNCOMPRESSED
 * size from the central directory before inflation — track the running
 * total there and abort once a cap is crossed. Throwing inside `filter`
 * propagates out of unzipSync and rejects the import.
 */

import { unzipSync } from 'fflate';

export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export function unzipWithCap(
  data: Uint8Array,
  opts?: { skipDirectories?: boolean },
): Record<string, Uint8Array> {
  let total = 0;
  return unzipSync(data, {
    filter: (file) => {
      if (opts?.skipDirectories && file.name.endsWith('/')) return false;
      if (file.originalSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
        throw new Error(
          `ZIP entry "${file.name}" inflates to ${file.originalSize} bytes (limit ${MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES})`,
        );
      }
      total += file.originalSize;
      if (total > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
        throw new Error(`ZIP inflates beyond ${MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES} bytes total`);
      }
      return true;
    },
  });
}
