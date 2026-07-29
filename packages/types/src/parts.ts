import type { ContentPart, TextPart } from './pipeline.js';

/** Extract all text from a message's parts array.
 *  Backward-compatible: also handles legacy string content. */
export function getMessageText(parts: unknown): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p): p is TextPart => {
      if (!p || typeof p !== 'object') return false;
      return (p as Record<string, unknown>).type === 'text';
    })
    .map((p) => p.text)
    .join('');
}

/** Get the last text part from a message's parts array. */
export function getLastTextPart(parts: unknown): TextPart | undefined {
  if (!Array.isArray(parts)) return undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = (parts as unknown[])[i];
    if (p && typeof p === 'object' && (p as Record<string, unknown>).type === 'text') {
      return p as TextPart;
    }
  }
  return undefined;
}

/** Wrap plain text into a parts array. */
export function textToParts(text: string): ContentPart[] {
  return [{ type: 'text', text }];
}
