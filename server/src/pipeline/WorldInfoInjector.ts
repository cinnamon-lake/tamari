/**
 * WorldInfoInjector — scans chat history for lorebook triggers and
 * returns activated entries.
 *
 * This is a simplified v2 port. It covers:
 * - Constant entries (always active)
 * - Keyword/regex triggers against chat text
 * - Probability rolls
 * - Position-aware ordering
 * - Recursive activation (entries triggering other entries)
 * - Branch-aware sticky, cooldown, and delay
 *
 * Activation is bounded by the deterministic knobs only: per-entry scan
 * depth, `maxRecursionDepth`, sticky/cooldown/delay. There is deliberately
 * no token budget — entry content is never silently dropped based on an
 * estimated token count.
 *
 * State is branch-aware: activation history is read from `_wiActivations`
 * stored in message extras. Each chat branch carries its own timeline.
 */

import { getMessageText } from '@tamari/types';
import type { Message } from '@tamari/types';
import type { WorldInfoEntry } from '@tamari/types';
import { parseDecorators, type DecoratorFlags } from './WiDecoratorParser.js';

export interface ScanOptions {
  entries: WorldInfoEntry[];
  chatHistory?: Message[];
  scanText?: string;
  tokenCounter: { count(text: string): number };
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  maxRecursionDepth?: number;
  /** Entry IDs that matched via semantic (RAG) retrieval. */
  semanticMatches?: Set<string>;
}

export interface ActivatedEntry {
  entry: WorldInfoEntry;
  tokens: number;
}

export interface InjectionResult {
  before: ActivatedEntry[];
  after: ActivatedEntry[];
  top: ActivatedEntry[];
  bottom: ActivatedEntry[];
  atDepth: ActivatedEntry[];
  totalTokens: number;
  /** Entry IDs that actually triggered this turn (excludes sticky carry-over). */
  activatedEntryIds: string[];
}

export class WorldInfoInjector {
  scan(opts: ScanOptions): InjectionResult {
    const {
      entries,
      chatHistory,
      scanText: explicitScanText,
      tokenCounter,
      caseSensitive = false,
      matchWholeWords = false,
      maxRecursionDepth = 3,
      semanticMatches = new Set<string>(),
    } = opts;

    const activatedIds = new Set<string>();
    const activated: ActivatedEntry[] = [];
    const activatedThisTurn: string[] = [];
    let totalTokens = 0;

    const messages = chatHistory ?? [];

    // Step 0: Parse V3 decorators from content → override entry fields + collect flags.
    // Decorators that map to existing fields (constant, disable, depth, role,
    // sticky, cooldown, delay) are applied as overrides so the existing scan
    // loop handles them unchanged. Only genuinely-new flags need extra logic.
    const processed = entries.map((entry) => {
      const { overrides, flags } = parseDecorators(entry.content);
      const processedEntry: WorldInfoEntry = { ...entry, ...overrides };
      // Merge additional/exclude keys into the entry's key lists.
      if (flags.additionalKeys && flags.additionalKeys.length > 0) {
        processedEntry.keys = [...entry.keys, ...flags.additionalKeys];
      }
      if (flags.excludeKeys && flags.excludeKeys.length > 0) {
        const exclude = new Set(flags.excludeKeys);
        processedEntry.keys = processedEntry.keys.filter((k) => !exclude.has(k));
        processedEntry.secondaryKeys = processedEntry.secondaryKeys.filter((k) => !exclude.has(k));
      }
      return { entry: processedEntry, flags };
    });

    const processedEntries = processed.map((p) => p.entry);
    const flagMap = new Map<string, DecoratorFlags>();
    for (const p of processed) {
      flagMap.set(p.entry.id, p.flags);
    }

    // Step 1: Build activation history from previous messages
    const activationHistory = this.buildActivationHistory(messages);

    // Step 2: Pre-evaluate sticky entries and apply delay/cooldown filters
    const stickyBuffer: ActivatedEntry[] = [];

    for (const entry of processedEntries) {
      if (entry.disable) continue;

      // @@dont_activate_after_match: skip if ever activated before
      const decFlags = flagMap.get(entry.id);
      if (decFlags?.dontActivateAfterMatch) {
        const lastIdx = this.findLastActivation(activationHistory, entry.id);
        if (lastIdx !== null) continue;
      }

      // Delay: skip entirely if chat hasn't reached the required length
      if (entry.delay && messages.length < entry.delay) {
        continue;
      }

      // Sticky: include if activated recently, even without current trigger
      if (entry.sticky && entry.sticky > 0) {
        const lastIdx = this.findLastActivation(activationHistory, entry.id);
        if (lastIdx !== null && messages.length - 1 - lastIdx < entry.sticky) {
          const tokens = tokenCounter.count(entry.content);
          stickyBuffer.push({ entry, tokens });
          activatedIds.add(entry.id);
          // Sticky carry-over is NOT recorded in activatedThisTurn
          continue;
        }
      }
    }

    // Step 3: Recursive scan for remaining entries
    let scanText = explicitScanText ?? this.buildScanText(messages);

    for (let round = 0; round <= maxRecursionDepth; round++) {
      const roundActivated: ActivatedEntry[] = [];

      // In round 0, add sticky entries alongside normal triggers so
      // everything is sorted by order together.
      if (round === 0) {
        for (const item of stickyBuffer) {
          roundActivated.push(item);
        }
      }

      for (const entry of processedEntries) {
        if (activatedIds.has(entry.id)) continue;
        if (entry.disable) continue;

        // Delay
        if (entry.delay && messages.length < entry.delay) continue;

        // Cooldown: skip if activated recently
        if (entry.cooldown && entry.cooldown > 0) {
          const lastIdx = this.findLastActivation(activationHistory, entry.id);
          if (lastIdx !== null && messages.length - 1 - lastIdx < entry.cooldown) {
            continue;
          }
        }

        // @@dont_activate_after_match: skip if ever activated before
        const decFlags = flagMap.get(entry.id);
        if (decFlags?.dontActivateAfterMatch) {
          const lastIdx = this.findLastActivation(activationHistory, entry.id);
          if (lastIdx !== null) continue;
        }

        // Constant entries are always active
        if (entry.constant) {
          const tokens = tokenCounter.count(entry.content);
          roundActivated.push({ entry, tokens });
          activatedIds.add(entry.id);
          activatedThisTurn.push(entry.id);
          continue;
        }

        // Probability check
        if (entry.probability < 100) {
          const roll = Math.random() * 100;
          if (roll > entry.probability) continue;
        }

        // Trigger check
        const triggered = this.checkTriggers(entry, scanText, caseSensitive, matchWholeWords, semanticMatches);
        if (!triggered) continue;

        const tokens = tokenCounter.count(entry.content);
        roundActivated.push({ entry, tokens });
        activatedIds.add(entry.id);
        activatedThisTurn.push(entry.id);
      }

      if (roundActivated.length === 0) break;

      // Sort by order so lower-order entries inject first within a round
      roundActivated.sort((a, b) => a.entry.order - b.entry.order);

      const roundAdded: ActivatedEntry[] = [];
      for (const item of roundActivated) {
        activated.push(item);
        roundAdded.push(item);
        totalTokens += item.tokens;
      }

      // Build scan text for next round from recursive entries
      const recursiveContent = roundAdded
        .filter((e) => e.entry.recursive)
        .map((e) => e.entry.content)
        .join('\n');

      if (!recursiveContent) break;
      scanText = recursiveContent;
    }

    return {
      before: activated.filter((e) => e.entry.position === 'before_char'),
      after: activated.filter((e) => e.entry.position === 'after_char'),
      top: activated.filter((e) => e.entry.position === 'top'),
      bottom: activated.filter((e) => e.entry.position === 'bottom'),
      atDepth: activated.filter((e) => e.entry.position === 'atDepth'),
      totalTokens,
      activatedEntryIds: activatedThisTurn,
    };
  }

  /** Read _wiActivations from message extras to build a branch-local activation timeline. */
  private buildActivationHistory(
    messages: Message[],
  ): Array<{ index: number; entryIds: string[] }> {
    const history: Array<{ index: number; entryIds: string[] }> = [];
    for (const [i, message] of messages.entries()) {
      const entryIds = message.extra._wiActivations;
      if (entryIds) {
        history.push({ index: i, entryIds });
      }
    }
    return history;
  }

  /** Find the most recent message index where the given entry was activated. */
  private findLastActivation(
    history: Array<{ index: number; entryIds: string[] }>,
    entryId: string,
  ): number | null {
    for (let i = history.length - 1; i >= 0; i--) {
      const activation = history[i];
      if (activation?.entryIds.includes(entryId)) {
        return activation.index;
      }
    }
    return null;
  }

  private buildScanText(messages: Message[]): string {
    return messages.map((m) => `${m.role}: ${getMessageText(m.extra.parts)}`).join('\n');
  }

  private checkTriggers(
    entry: WorldInfoEntry,
    text: string,
    caseSensitive: boolean,
    matchWholeWords: boolean,
    semanticMatches: Set<string>,
  ): boolean {
    // Semantic retrieval mode: activate if the vector index returned this entry
    if (entry.retrievalMode === 'semantic') {
      return semanticMatches.has(entry.id);
    }

    // Constant mode is handled upstream, but guard here too
    if (entry.retrievalMode === 'constant' || entry.constant) {
      return true;
    }

    const scanText = caseSensitive ? text : text.toLowerCase();

    const primaryHit = this.checkKeyList(entry.keys, scanText, caseSensitive, matchWholeWords, entry.regex);
    if (!primaryHit) return false;

    // Secondary keys (selective mode)
    if (entry.selective && entry.secondaryKeys.length > 0) {
      const secondaryHit = this.checkKeyList(
        entry.secondaryKeys,
        scanText,
        caseSensitive,
        matchWholeWords,
        entry.regex,
      );
      if (!secondaryHit) return false;
    }

    return true;
  }

  private checkKeyList(
    keys: string[],
    scanText: string,
    caseSensitive: boolean,
    matchWholeWords: boolean,
    useRegex: boolean,
  ): boolean {
    for (const key of keys) {
      if (!key) continue;

      if (useRegex) {
        try {
          const flags = caseSensitive ? '' : 'i';
          const regex = new RegExp(key, flags);
          if (regex.test(scanText)) return true;
        } catch {
          // Invalid regex pattern — skip this key silently
          continue;
        }
      } else {
        const searchKey = caseSensitive ? key : key.toLowerCase();
        if (matchWholeWords) {
          const regex = new RegExp(`\\b${this.escapeRegex(searchKey)}\\b`, caseSensitive ? '' : 'i');
          if (regex.test(scanText)) return true;
        } else {
          if (scanText.includes(searchKey)) return true;
        }
      }
    }
    return false;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
