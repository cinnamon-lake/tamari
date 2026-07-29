/**
 * V3 Character Card decorator parser for World Info entries.
 *
 * Decorators are `@@`-prefixed lines at the top of `entry.content`. This
 * parser strips them and returns field overrides that map to existing
 * `WorldInfoEntry` fields (so the injector's existing logic handles them
 * without any new code paths) plus a few genuinely-new flags.
 *
 * V3 spec: docs/external/character-card-spec-v3/SPEC_V3.md (lines 374–562)
 * v1 reference: old/public/scripts/world-info.js (parseDecorators, line 4540)
 */

import type { WorldInfoEntry } from '@tamari/types';

/** Fields that override the entry's existing properties. */
export interface DecoratorOverrides {
  content: string;
  constant?: boolean;
  disable?: boolean;
  depth?: number;
  position?: WorldInfoEntry['position'];
  role?: WorldInfoEntry['role'];
  sticky?: number;
  cooldown?: number;
  delay?: number;
}

/** Flags for decorators with no existing field equivalent. */
export interface DecoratorFlags {
  dontActivateAfterMatch?: boolean;
  additionalKeys?: string[];
  excludeKeys?: string[];
  scanDepth?: number;
  isGreeting?: number;
  ignoreOnMaxContext?: boolean;
}

export interface ParsedDecorators {
  overrides: DecoratorOverrides;
  flags: DecoratorFlags;
}

/** A very large sticky value — effectively "stay active forever after first match." */
const STICKY_INFINITY = 1_000_000;

const KNOWN_DECORATORS = new Set([
  '@@activate',
  '@@dont_activate',
  '@@depth',
  '@@role',
  '@@keep_activate_after_match',
  '@@dont_activate_after_match',
  '@@activate_only_after',
  '@@activate_only_every',
  '@@additional_keys',
  '@@exclude_keys',
  '@@scan_depth',
  '@@position',
  '@@is_greeting',
  '@@ignore_on_max_context',
]);

/**
 * Parse `@@`-prefixed decorator lines from the top of `content`.
 *
 * - Only fires if `content.startsWith('@@')`.
 * - Walks leading lines that start with `@@` (or `@@@` for fallback).
 * - `@@@` (triple-at) is the fallback syntax: if the preceding decorator was
 *   unknown, the fallback is skipped; if known, normalized to `@@`.
 * - An unknown `@@` decorator stops collection — the rest is content.
 * - The stripped content (decorators removed) is returned for injection.
 */
export function parseDecorators(content: string): ParsedDecorators {
  const overrides: DecoratorOverrides = { content };
  const flags: DecoratorFlags = {};

  if (!content.startsWith('@@')) {
    return { overrides, flags };
  }

  const lines = content.split('\n');
  const decorators: string[] = [];
  let unknownPending = false;

  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('@@')) {
      // First non-@@ line — rest is content.
      overrides.content = lines.slice(i).join('\n');
      break;
    }

    const isFallback = line.startsWith('@@@');
    const normalized = isFallback ? line.slice(1) : line;
    const isKnown = isKnownDecorator(normalized);

    if (!isFallback) {
      // Regular @@ decorator.
      if (isKnown) {
        decorators.push(normalized);
        unknownPending = false;
      } else {
        // Unknown @@ decorator — mark as pending, look for @@@ fallback.
        unknownPending = true;
      }
    } else {
      // Fallback @@@ decorator.
      if (unknownPending) {
        // Previous was unknown — try this fallback.
        if (isKnown) {
          decorators.push(normalized);
          unknownPending = false;
        }
        // If also unknown, stay in unknownPending and continue.
      }
      // If not unknownPending, the preceding @@ was known — skip the fallback.
    }
  }

  // If we consumed all lines as decorators, content is empty.
  if (decorators.length > 0 && overrides.content === content) {
    overrides.content = '';
  }

  // Apply decorators to overrides/flags.
  for (const dec of decorators) {
    applyDecorator(dec, overrides, flags);
  }

  return { overrides, flags };
}

function isKnownDecorator(line: string): boolean {
  // Check if the line starts with any known decorator (prefix match, since
  // decorators can have values like `@@depth 5`).
  for (const known of KNOWN_DECORATORS) {
    if (line === known || line.startsWith(known + ' ')) {
      return true;
    }
  }
  return false;
}

function applyDecorator(
  dec: string,
  overrides: DecoratorOverrides,
  flags: DecoratorFlags,
): void {
  const [name, ...rest] = dec.split(/\s+/);
  const value = rest.join(' ');

  switch (name) {
    case '@@activate':
      overrides.constant = true;
      break;
    case '@@dont_activate':
      overrides.disable = true;
      break;
    case '@@depth': {
      const n = Number(value);
      if (!isNaN(n)) {
        overrides.depth = n;
        overrides.position = 'atDepth';
      }
      break;
    }
    case '@@role':
      if (value === 'system' || value === 'user' || value === 'assistant') {
        overrides.role = value;
      }
      break;
    case '@@keep_activate_after_match':
      overrides.sticky = STICKY_INFINITY;
      break;
    case '@@dont_activate_after_match':
      flags.dontActivateAfterMatch = true;
      break;
    case '@@activate_only_after': {
      const n = Number(value);
      if (!isNaN(n)) overrides.delay = n;
      break;
    }
    case '@@activate_only_every': {
      const n = Number(value);
      if (!isNaN(n)) overrides.cooldown = n;
      break;
    }
    case '@@additional_keys':
      flags.additionalKeys = value.split(',').map((s) => s.trim()).filter(Boolean);
      break;
    case '@@exclude_keys':
      flags.excludeKeys = value.split(',').map((s) => s.trim()).filter(Boolean);
      break;
    case '@@scan_depth': {
      const n = Number(value);
      if (!isNaN(n)) flags.scanDepth = n;
      break;
    }
    case '@@is_greeting': {
      const n = Number(value);
      if (!isNaN(n)) flags.isGreeting = n;
      break;
    }
    case '@@ignore_on_max_context':
      flags.ignoreOnMaxContext = true;
      break;
    // @@position is recognized but maps to new position values not in the
    // current enum (after_desc/before_desc/personality/scenario). For now,
    // we accept it but don't override — the entry keeps its UI-set position.
    // This can be extended when the position enum grows.
    case '@@position':
      // Recognized but no-op for now (new positions need enum extension).
      break;
  }
}
