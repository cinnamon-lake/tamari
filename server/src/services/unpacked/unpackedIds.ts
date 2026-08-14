/**
 * Id conventions for unpacked (on-disk) cards.
 *
 * Handle rows and overlays are namespaced under the `unpacked/` prefix so they
 * can never collide with real (DB-authored) character ids, and so the
 * read-through repository wrappers can recognize them by prefix alone.
 */

export const UNPACKED_ID_PREFIX = 'unpacked/';

/** Full card id for an unpacked card slug (meta.id or folder name). */
export function unpackedCardId(slug: string): string {
  return `${UNPACKED_ID_PREFIX}${slug}`;
}

/** Whether an id belongs to an unpacked card. */
export function isUnpackedCardId(id: string): boolean {
  return id.startsWith(UNPACKED_ID_PREFIX);
}

/** Suffix marking the virtual world-info id serving an unpacked card's lorebook/ folder. */
export const UNPACKED_WORLD_INFO_SUFFIX = ':book';

/** The virtual world-info id serving an unpacked card's lorebook/ folder. */
export function unpackedWorldInfoId(cardId: string): string {
  return `${cardId}${UNPACKED_WORLD_INFO_SUFFIX}`;
}

/** Whether an id is the virtual world-info id of an unpacked card. */
export function isUnpackedWorldInfoId(id: string): boolean {
  return id.startsWith(UNPACKED_ID_PREFIX) && id.endsWith(UNPACKED_WORLD_INFO_SUFFIX);
}

/** The card id behind a virtual unpacked world-info id. */
export function unpackedCardIdFromWorldInfoId(id: string): string {
  return id.slice(0, -UNPACKED_WORLD_INFO_SUFFIX.length);
}
