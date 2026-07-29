/**
 * RegexEngine — applies user-defined regex find/replace rules to text.
 *
 * Patterns must use JS-style delimiters (v1 parity):
 *   "/foo/"     → /foo/g
 *   "/foo/gi"   → /foo/gi
 * Bare patterns without delimiters are rejected (parseRegexString returns null).
 *
 * Replacement string supports standard JS back-references:
 *   $1, $2      → capture groups
 *   $&          → full match
 *   $$          → literal $
 *
 * Regex execution runs in a Worker thread with a 1-second timeout
 * to prevent ReDoS from freezing the Node event loop.
 *
 * Rules with a non-empty `replaceLua` take the Lua replacement path instead
 * (Layer 2, docs/design/scriptable-layers.md): the JS side only finds matches
 * (still via the compiled RegExp — ReDoS exposure there is inherent to the
 * rule's pattern, same as the worker path), and each match is replaced by the
 * script's `replace(match, captures)` return value. Lua runs in a sandboxed
 * wasmoon state (no io/os/debug/net) shared across all Lua rules of one
 * applyRules call; a script error or timeout skips that rule, text unchanged,
 * exactly like a failed worker rule.
 */

import { Worker } from 'node:worker_threads';
import type { LuaEngine } from 'wasmoon';
import { logger } from '../lib/logger.js';
import type { RegexRule } from '@tamari/types';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import { toLuaLiteral } from '../backends/LuaBackendAdapter.js';

const REGEX_TIMEOUT_MS = 1000;
const MAX_INPUT_LENGTH = 100_000;
const LUA_REPLACE_TIMEOUT_MS = 5000;

export interface ParsedRegex {
  pattern: string;
  flags: string;
}

/**
 * Parse a regex string in /pattern/flags format.
 * Returns null if the input is not properly delimited.
 */
export function parseRegexString(input: string): ParsedRegex | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('/') && trimmed.length > 1) {
    // Find the last slash to separate pattern from flags
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash > 0) {
      const pattern = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1);
      return { pattern, flags: flags || 'g' };
    }
  }
  return null;
}

export function compileRule(rule: RegexRule): RegExp | null {
  try {
    const parsed = parseRegexString(rule.findRegex);
    if (!parsed) return null;
    return new RegExp(parsed.pattern, parsed.flags);
  } catch (err) {
    logger.warn({ err, findRegex: rule.findRegex }, 'Invalid regex pattern, skipping rule');
    return null;
  }
}

function getWorkerPath(): URL {
  // In compiled dist/ the file is .js; in vitest/dev it stays .ts
  const workerFile = import.meta.url.endsWith('.js')
    ? './RegexEngine.worker.js'
    : './RegexEngine.worker.ts';
  return new URL(workerFile, import.meta.url);
}

async function applyRule(text: string, rule: RegexRule): Promise<string> {
  const parsed = parseRegexString(rule.findRegex);
  if (!parsed) return text;
  const { pattern, flags } = parsed;

  return new Promise((resolve, reject) => {
    const worker = new Worker(getWorkerPath());
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`Regex timed out after ${REGEX_TIMEOUT_MS}ms: ${rule.findRegex}`));
    }, REGEX_TIMEOUT_MS);

    worker.on('message', (msg: { result?: string; error?: string }) => {
      clearTimeout(timeout);
      void worker.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result ?? text);
    });

    worker.on('error', (err) => {
      clearTimeout(timeout);
      void worker.terminate();
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    worker.postMessage({ text, pattern, flags, replaceString: rule.replaceString });
  });
}

export async function applyRules(text: string, rules: RegexRule[]): Promise<string> {
  if (text.length > MAX_INPUT_LENGTH) {
    return text.slice(0, MAX_INPUT_LENGTH);
  }

  let result = text;
  // Lazily created on the first Lua rule; shared by all Lua rules in this call
  // and always cleaned up — wasmoon engines are not cheap to leak.
  let luaState: { lua: LuaEngine; cleanup: () => void } | null = null;
  try {
    for (const rule of rules) {
      if (rule.disabled) continue;
      try {
        if (rule.replaceLua && rule.replaceLua.trim().length > 0) {
          luaState ??= await getLuaRuntime().createState({}, LUA_REPLACE_TIMEOUT_MS);
          result = await applyLuaRule(result, rule, luaState.lua);
        } else {
          result = await applyRule(result, rule);
        }
      } catch (err) {
        // Skip malformed or timed-out rules
        logger.warn({ err, rule: rule.name }, 'regex rule failed, skipped');
      }
    }
  } finally {
    luaState?.cleanup();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Lua replacement path (Layer 2)
// ---------------------------------------------------------------------------

let sharedLuaRuntime: LuaRuntime | undefined;
function getLuaRuntime(): LuaRuntime {
  sharedLuaRuntime ??= new LuaRuntime();
  return sharedLuaRuntime;
}

/**
 * Apply a rule whose replacement is a Lua script defining
 * `replace(match, captures)`. `captures` is a 1-indexed array of capture
 * groups (nil for unmatched optional groups). A non-string/nil return keeps
 * the original match. Script errors (missing replace, runtime error, timeout)
 * propagate to applyRules, which skips the rule — same contract as the worker
 * path.
 */
async function applyLuaRule(text: string, rule: RegexRule, lua: LuaEngine): Promise<string> {
  const regex = compileRule(rule);
  if (!regex) return text;
  await lua.doString(rule.replaceLua!);
  if (typeof lua.global.get('replace') !== 'function') {
    throw new Error(`regex rule "${rule.name}": replaceLua must define replace(match, captures)`);
  }

  let result = '';
  let lastIndex = 0;
  regex.lastIndex = 0;
  for (;;) {
    const m = regex.exec(text);
    if (!m) break;
    const replacement: unknown = await lua.doString(
      // Unmatched optional capture groups are `undefined` at runtime even
      // though RegExpExecArray is typed string[] — the `?? null` is real.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      `return replace(${toLuaLiteral(m[0])}, ${toLuaLiteral(m.slice(1).map((c) => c ?? null))})`,
    );
    result += text.slice(lastIndex, m.index);
    result += typeof replacement === 'string' ? replacement : m[0];
    lastIndex = m.index + m[0].length;
    if (!regex.global) break;
    // Zero-width matches consume nothing — advance manually or exec loops forever.
    if (m[0].length === 0) regex.lastIndex = m.index + 1;
  }
  result += text.slice(lastIndex);
  return result;
}

export function filterRules(
  rules: RegexRule[],
  placement: 'prompt' | 'display',
): RegexRule[] {
  return rules.filter((r) => !r.disabled && r[placement]);
}

/**
 * Filter rules by placement AND message role.
 *
 * `userInput` and `aiOutput` act as role filters on top of `display`/`prompt`:
 * - If neither `userInput` nor `aiOutput` is set, the rule applies to all roles.
 * - If `userInput` is set, the rule applies to user messages.
 * - If `aiOutput` is set, the rule applies to assistant messages.
 */
export function filterRulesByRole(
  rules: RegexRule[],
  placement: 'prompt' | 'display',
  role: 'user' | 'assistant' | 'system' | 'tool',
): RegexRule[] {
  const placementRules = filterRules(rules, placement);
  return placementRules.filter((r) => {
    if (!r.userInput && !r.aiOutput) return true;
    if (role === 'user') return r.userInput;
    if (role === 'assistant') return r.aiOutput;
    return false;
  });
}
