/**
 * Collision-checked word-ID generation for primary keys.
 */

import { newId } from '@tamari/wordid';

const MAX_ATTEMPTS = 5;

/**
 * Generate a word-ID that `exists` reports as free. The word-ID space is ~2^52,
 * so collisions are vanishingly rare; still, retry a few times and throw rather
 * than risk inserting a duplicate primary key.
 */
export async function newUniqueId(exists: (id: string) => Promise<boolean>): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const id = newId();
    if (!(await exists(id))) return id;
  }
  throw new Error(`newUniqueId: failed to generate a unique id after ${MAX_ATTEMPTS} attempts`);
}
