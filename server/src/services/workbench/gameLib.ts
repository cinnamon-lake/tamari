/**
 * The game lib — canonical Lua sources for game cards (tool loops, ledger,
 * todo, toolset, registry, rolling…), vendored into a card's
 * backend_logic/lib/ VFS by the `add_game_lib` workbench verb.
 *
 * Sources of truth live in the repo at docs/design/examples/game-lib/*.lua
 * (the same files the Guildhall example and its test suite exercise);
 * the Docker image copies the whole repo, so repo-relative reads resolve in
 * dev, dist, and Docker alike. Vendored per card on purpose: the card owns
 * its copies — exports work on any install and behavior is pinned.
 */

import { readFileSync } from 'node:fs';

export const GAME_LIB_MODULES = [
  'loop',
  'sanitize',
  'chrome',
  'ledger',
  'toolset',
  'todo',
  'registry',
  'maptag',
  'summarize',
  'events',
  'rolling',
] as const;

const LIB_DIR = new URL('../../../../docs/design/examples/game-lib/', import.meta.url);

let cached: Record<string, string> | undefined;

/** The lib as a VFS file map ({ "lib/loop.lua": source, … }), loaded once. */
export function gameLibFiles(): Record<string, string> {
  cached ??= Object.fromEntries(
    GAME_LIB_MODULES.map((m) => [`lib/${m}.lua`, readFileSync(new URL(`${m}.lua`, LIB_DIR), 'utf8')]),
  );
  return { ...cached };
}
