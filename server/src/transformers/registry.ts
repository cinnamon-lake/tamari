/**
 * Builtin transformer registry — id → implementation lookup plus the catalog
 * the chain editor uses for its add-builtin picker.
 */

import type { BuiltinTransformerId } from '@tamari/types';
import type { BuiltinTransformer } from './types.js';
import { squashSystem } from './builtin/squashSystem.js';
import { whitespace } from './builtin/whitespace.js';
import { stripReasoning } from './builtin/stripReasoning.js';
import { historySquash } from './builtin/historySquash.js';
import { ensureThinking } from './builtin/ensureThinking.js';

const BUILTINS: readonly BuiltinTransformer[] = [
  squashSystem,
  whitespace,
  stripReasoning,
  historySquash,
  ensureThinking,
];

const BY_ID = new Map<BuiltinTransformerId, BuiltinTransformer>(BUILTINS.map((b) => [b.id, b]));

export function getBuiltinTransformer(id: BuiltinTransformerId): BuiltinTransformer | undefined {
  return BY_ID.get(id);
}

/** Catalog for the UI: id + description + the params' JSON schema shape. */
export function builtinTransformerCatalog(): Array<{ id: BuiltinTransformerId; description: string }> {
  return BUILTINS.map((b) => ({ id: b.id, description: b.description }));
}
