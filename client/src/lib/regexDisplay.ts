import type { RegexRule } from '@tamari/types';

export function parseRegexString(input: string): { pattern: string; flags: string } | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('/') && trimmed.length > 1) {
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash > 0) {
      return {
        pattern: trimmed.slice(1, lastSlash),
        flags: trimmed.slice(lastSlash + 1) || 'g',
      };
    }
  }
  return null;
}

export function compileRule(rule: RegexRule): RegExp | null {
  try {
    const parsed = parseRegexString(rule.findRegex);
    if (!parsed) return null;
    return new RegExp(parsed.pattern, parsed.flags);
  } catch {
    return null;
  }
}

export function applyDisplayRules(text: string, rules: RegexRule[]): string {
  let result = text;
  for (const rule of rules) {
    if (rule.disabled || !rule.display) continue;
    const regex = compileRule(rule);
    if (!regex) continue;
    try {
      result = result.replace(regex, rule.replaceString);
    } catch {
      // skip
    }
  }
  return result;
}
