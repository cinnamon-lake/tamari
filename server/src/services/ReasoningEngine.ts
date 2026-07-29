/**
 * ReasoningEngine — parses and reconstructs reasoning blocks from model output.
 *
 * In text-completion mode, the instruct template defines a regex pattern that
 * extracts the thinking block from the model's raw output. The pattern uses
 * capture groups: group 1 is the thinking block (including any delimiters),
 * group 2 is the visible content.
 */

export interface ParseResult {
  reasoning: string;
  content: string;
}

/**
 * Extract reasoning from text using a regex pattern.
 *
 * The pattern must have two capture groups:
 *   - Group 1: the thinking block (optional — if absent, no reasoning)
 *   - Group 2: the remaining content
 *
 * prefix and suffix are stripped from group 1 to yield the inner reasoning text.
 */
export function extractReasoning(
  text: string,
  pattern: string,
  prefix: string,
  suffix: string,
): ParseResult {
  const regex = new RegExp(pattern, 's');
  const match = text.match(regex);
  if (!match || !match[1]) {
    return { reasoning: '', content: text };
  }

  const reasoning = stripDelimiters(match[1], prefix, suffix);
  return {
    reasoning,
    content: (match[2] ?? '').trim(),
  };
}

/**
 * Reconstruct message content with reasoning included, using the template format.
 * Used when `addToPrompts` is enabled to include past reasoning in context.
 */
export function reconstructWithReasoning(
  content: string,
  reasoning: string,
  prefix: string,
  suffix: string,
  separator: string,
): string {
  if (!reasoning) return content;
  return prefix + reasoning + suffix + separator + content;
}

function stripDelimiters(text: string, prefix: string, suffix: string): string {
  let result = text.trim();

  if (suffix) {
    const suffixRe = new RegExp(escapeRegex(suffix) + '\\s*$');
    result = result.replace(suffixRe, '').trim();
  }

  if (prefix) {
    const prefixRe = new RegExp('^\\s*' + escapeRegex(prefix));
    result = result.replace(prefixRe, '').trim();
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
