/**
 * Message-scoped macro variable helpers.
 *
 * Each message stores a full snapshot of all macro variables in
 * message.extra.macroVars.  Later messages copy the previous snapshot and
 * overlay any new {{setvar}} assignments made in that message.
 */

import { MacroResolver, type MacroContext } from '../pipeline/MacroResolver.js';

/**
 * Extracts {{setvar}} variable assignments from message content.
 * Returns a Record of variable name -> resolved value.
 */
export function extractMessageVariables(
  content: string,
  userName = 'User',
  charName = 'Character',
): Record<string, string> {
  if (!content.includes('{{setvar')) return {};

  const resolver = MacroResolver.createStorageResolver();
  const ctx: MacroContext = { userName, charName };
  resolver.resolve(content, ctx);

  return ctx.macroVars ? { ...ctx.macroVars } : {};
}
