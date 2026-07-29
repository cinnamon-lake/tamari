/**
 * Character-scoped regex rules ("character-coupled regexes").
 *
 * Rules live in the character's `extensions` JSON blob under `regexScripts`
 * (no DB migration needed) and are merged AFTER global rules
 * (`settings.regexRules`) everywhere rules are applied — prompt building and
 * display rendering — so a character's rules win on overlapping patterns.
 *
 * v1 character cards store scoped scripts at `extensions.regex_scripts` in a
 * different shape; `convertLegacyScopedScripts` maps them to v2 rules at
 * import time.
 */

import { randomUUID } from 'node:crypto';
import type { Character, RegexRule } from '@tamari/types';

export const CHARACTER_REGEX_EXTENSION_KEY = 'regexScripts';

/** Tolerant parse of a character's scoped regex rules. */
export function getCharacterRegexRules(character: Character | null | undefined): RegexRule[] {
  const raw = character?.extensions[CHARACTER_REGEX_EXTENSION_KEY];
  if (!Array.isArray(raw)) return [];
  const rules: RegexRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r['findRegex'] !== 'string' || r['findRegex'].length === 0) continue;
    rules.push({
      id: typeof r['id'] === 'string' && r['id'].length > 0 ? r['id'] : randomUUID(),
      name: typeof r['name'] === 'string' ? r['name'] : '',
      findRegex: r['findRegex'],
      replaceString: typeof r['replaceString'] === 'string' ? r['replaceString'] : '',
      ...(typeof r['replaceLua'] === 'string' && r['replaceLua'].length > 0 ? { replaceLua: r['replaceLua'] } : {}),
      disabled: Boolean(r['disabled']),
      userInput: Boolean(r['userInput']),
      aiOutput: Boolean(r['aiOutput']),
      // Universal by default (v1 parity: neither markdownOnly nor promptOnly = everywhere).
      prompt: r['prompt'] === undefined ? true : Boolean(r['prompt']),
      display: r['display'] === undefined ? true : Boolean(r['display']),
    });
  }
  return rules;
}

/** Global rules first, character-scoped after (scoped wins on overlap). */
export function mergeRegexRules(globalRules: RegexRule[], character: Character | null | undefined): RegexRule[] {
  const scoped = getCharacterRegexRules(character);
  return scoped.length === 0 ? globalRules : [...globalRules, ...scoped];
}

/** Parse the global regex rules stored in settings (`settings.regexRules`). */
export function getGlobalRegexRules(settings: Record<string, unknown>): RegexRule[] {
  const raw = settings['regexRules'];
  if (!raw || !Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      id: typeof r['id'] === 'string' ? r['id'] : '',
      name: typeof r['name'] === 'string' ? r['name'] : '',
      findRegex: typeof r['findRegex'] === 'string' ? r['findRegex'] : '',
      replaceString: typeof r['replaceString'] === 'string' ? r['replaceString'] : '',
      ...(typeof r['replaceLua'] === 'string' && r['replaceLua'].length > 0 ? { replaceLua: r['replaceLua'] } : {}),
      disabled: Boolean(r['disabled']),
      userInput: Boolean(r['userInput']),
      aiOutput: Boolean(r['aiOutput']),
      prompt: Boolean(r['prompt']),
      display: Boolean(r['display']),
    }))
    .filter((r) => r.id && r.findRegex);
}

// v1 placement enum (old/public/scripts/extensions/regex/engine.js).
const V1_PLACEMENT_USER_INPUT = 1;
const V1_PLACEMENT_AI_OUTPUT = 2;

/**
 * Convert a v1 card's `extensions.regex_scripts` array to v2 RegexRules.
 * Returns [] when the extensions blob has no scoped scripts.
 */
export function convertLegacyScopedScripts(extensions: Record<string, unknown> | null | undefined): RegexRule[] {
  const raw = extensions?.['regex_scripts'];
  if (!Array.isArray(raw)) return [];
  const rules: RegexRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as Record<string, unknown>;
    if (typeof s['findRegex'] !== 'string' || s['findRegex'].length === 0) continue;
    const placement = Array.isArray(s['placement']) ? s['placement'].map(Number) : [];
    const markdownOnly = Boolean(s['markdownOnly']);
    const promptOnly = Boolean(s['promptOnly']);
    const universal = !markdownOnly && !promptOnly;
    rules.push({
      id: randomUUID(),
      name: typeof s['scriptName'] === 'string' ? s['scriptName'] : '',
      findRegex: s['findRegex'],
      replaceString: typeof s['replaceString'] === 'string' ? s['replaceString'] : '',
      disabled: Boolean(s['disabled']),
      userInput: placement.includes(V1_PLACEMENT_USER_INPUT),
      aiOutput: placement.includes(V1_PLACEMENT_AI_OUTPUT),
      prompt: promptOnly || universal,
      display: markdownOnly || universal,
    });
  }
  return rules;
}
