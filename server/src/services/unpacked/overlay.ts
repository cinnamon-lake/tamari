/**
 * Read-through overlay builders for unpacked (on-disk) cards.
 *
 * Handle rows in `characters` carry only id + name; these functions merge the
 * parsed folder content (UnpackedCardService registry) onto a handle row on
 * every read. Shared by the read-through repository wrappers and the service's
 * own broadcasts so all read paths produce the identical shape.
 */

import type { Character, WorldInfo } from '@tamari/types';
import { CHARACTER_BACKEND_EXTENSION_KEY } from '../../backends/customBackendFactory.js';
import { CHARACTER_REGEX_EXTENSION_KEY } from '../characterRegex.js';
import type { ParsedCard } from './cardFolderParser.js';
import { unpackedWorldInfoId } from './unpackedIds.js';

/** Extensions key surfacing non-fatal folder parse problems to the client. */
export const UNPACKED_ERRORS_EXTENSION_KEY = 'unpackedErrors';

/** Merge a parsed folder onto its handle row. Disk wins for every content field. */
export function overlayCharacter(row: Character, parsed: ParsedCard): Character {
  const extensions: Record<string, unknown> = {
    ...row.extensions,
    [CHARACTER_REGEX_EXTENSION_KEY]: parsed.regexRules,
  };
  if (parsed.backendLogic) {
    extensions[CHARACTER_BACKEND_EXTENSION_KEY] = { enabled: true, ...parsed.backendLogic };
  }
  if (parsed.errors.length > 0) {
    extensions[UNPACKED_ERRORS_EXTENSION_KEY] = parsed.errors;
  }
  return {
    ...row,
    name: parsed.name,
    description: parsed.textFields['description'] ?? '',
    personality: parsed.textFields['personality'] ?? '',
    scenario: parsed.textFields['scenario'] ?? '',
    firstMes: parsed.textFields['firstMes'] ?? '',
    mesExample: parsed.textFields['mesExample'] ?? '',
    systemPrompt: parsed.textFields['systemPrompt'] ?? '',
    postHistoryInstructions: parsed.textFields['postHistoryInstructions'] ?? '',
    creatorNotes: parsed.textFields['creatorNotes'] ?? '',
    nickname: parsed.textFields['nickname'] ?? '',
    tags: parsed.tags,
    alternateGreetings: parsed.alternateGreetings,
    extensions,
    // The virtual book is served by ReadThroughWorldInfoRepository from
    // lorebook/ — empty folders simply yield an empty entry list.
    worldInfoId: unpackedWorldInfoId(row.id),
    external: true,
  };
}

/** Summary variant: only the fields list views render (name/tags) plus the external badge. */
export function overlayCharacterSummary<
  T extends Pick<Character, 'id' | 'name' | 'tags' | 'avatarPath' | 'avatarThumbnailPath' | 'createdAt' | 'updatedAt'>,
>(row: T, parsed: ParsedCard): T & { external: true } {
  return { ...row, name: parsed.name, tags: parsed.tags, external: true };
}

/** Assemble the virtual WorldInfo record for an unpacked card's lorebook/ folder. */
export function buildUnpackedWorldInfo(bookId: string, parsed: ParsedCard): WorldInfo {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: bookId,
    name: `${parsed.name} (unpacked)`,
    entries: parsed.lorebookEntries,
    createdAt: now,
    updatedAt: now,
  };
}
