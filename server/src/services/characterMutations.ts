/**
 * Shared character create/update logic.
 *
 * Used by the Lua `st` API (scripting/StApi.ts) and the workbench
 * tool template so both paths validate, mutate, and broadcast identically.
 * Functions throw plain Errors; callers decide how to surface them (Lua
 * error vs. tool-result `content` string).
 */

import type { Character, CharacterUpdate } from '@tamari/types';
import type { EventBus } from '../bus/EventBus.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import { toCharacterSummary, withCharacterAvatar } from '../lib/summaries.js';

export interface CharacterMutationDeps {
  characters: ICharacterRepository;
  bus: EventBus;
}

const CHARACTER_FIELD_WHITELIST = [
  'description',
  'personality',
  'scenario',
  'firstMes',
  'mesExample',
  'systemPrompt',
  'postHistoryInstructions',
  'creatorNotes',
  'nickname',
] as const;

/** Pick the writable character fields out of an arbitrary input object. */
export function pickCharacterFields(input: Record<string, unknown>): CharacterUpdate {
  const patch: CharacterUpdate = {};
  for (const field of CHARACTER_FIELD_WHITELIST) {
    const value = input[field];
    if (typeof value === 'string') patch[field] = value;
  }
  const tags = input.tags;
  if (Array.isArray(tags) && tags.every((t) => typeof t === 'string')) {
    patch.tags = tags;
  }
  const alternateGreetings = input.alternateGreetings;
  if (Array.isArray(alternateGreetings) && alternateGreetings.every((g) => typeof g === 'string')) {
    patch.alternateGreetings = alternateGreetings;
  }
  return patch;
}

/** Rebroadcast the full list so other tabs' sidebars converge (AGENTS.md §5). */
export async function broadcastCharacterList(deps: CharacterMutationDeps): Promise<void> {
  const list = await deps.characters.listSummaries();
  deps.bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) });
}

export async function createCharacter(
  deps: CharacterMutationDeps,
  input: Record<string, unknown>,
): Promise<Character> {
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new Error('expected data.name (string)');
  }
  const existing = await deps.characters.getByName(input.name);
  if (existing) {
    throw new Error(`character "${input.name}" already exists`);
  }
  const id = crypto.randomUUID();
  const character = await deps.characters.create(id, { name: input.name, ...pickCharacterFields(input) });
  deps.bus.broadcast({ type: 'character.created', character: withCharacterAvatar(character) });
  await broadcastCharacterList(deps);
  return character;
}

export async function updateCharacter(
  deps: CharacterMutationDeps,
  characterId: string,
  patch: Record<string, unknown>,
): Promise<Character> {
  const character = await deps.characters.getById(characterId);
  if (!character) throw new Error(`character "${characterId}" not found`);
  const fields = pickCharacterFields(patch);
  // Rename is allowed but validated: non-empty and not colliding with another character.
  if (typeof patch.name === 'string') {
    const name = patch.name.trim();
    if (name.length === 0) throw new Error('name must not be empty');
    const existing = await deps.characters.getByName(name);
    if (existing && existing.id !== characterId) throw new Error(`character "${name}" already exists`);
    fields.name = name;
  }
  const updated = await deps.characters.update(characterId, fields);
  deps.bus.broadcast({ type: 'character.updated', character: withCharacterAvatar(updated) });
  await broadcastCharacterList(deps);
  return updated;
}
