/**
 * ExampleBuilder — parses character card mesExample into PipelineMessages.
 *
 * Format (per Character Card Spec V1/V2):
 *   <START>                     → system message (content from same line or empty)
 *   {{user}}: message text      → user message
 *   {{char}}: message text      → assistant message
 *
 * Multi-line messages are supported. Messages are separated by speaker prefixes.
 * Macros in message content are left unresolved for the renderer.
 */

import type { ExampleMessage } from './renderers/Renderer.js';

export type { ExampleMessage };

export class ExampleBuilder {
  /**
   * Parse a mesExample string into an array of example messages.
   */
  build(mesExample: string): ExampleMessage[] {
    if (!mesExample.trim()) return [];

    // Normalise line endings
    const normalized = mesExample.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');

    const messages: ExampleMessage[] = [];
    let currentRole: 'system' | 'user' | 'assistant' | null = null;
    let currentLines: string[] = [];

    const flush = () => {
      if (!currentRole || currentLines.length === 0) return;
      const content = currentLines.join('\n').trim();
      messages.push({ role: currentRole, content });
      currentLines = [];
    };

    for (const line of lines) {
      const startMatch = /^<START>(.*)$/i.exec(line);
      if (startMatch) {
        flush();
        currentRole = 'system';
        currentLines.push(startMatch[1] ?? '');
        continue;
      }

      const userMatch = /^\{\{user\}\}:\s?(.*)$/i.exec(line);
      const charMatch = /^\{\{char\}\}:\s?(.*)$/i.exec(line);

      if (userMatch) {
        flush();
        currentRole = 'user';
        currentLines.push(userMatch[1] ?? '');
      } else if (charMatch) {
        flush();
        currentRole = 'assistant';
        currentLines.push(charMatch[1] ?? '');
      } else if (currentRole) {
        currentLines.push(line);
      }
      // Lines before any <START> or speaker prefix are ignored
    }

    flush();
    return messages;
  }
}
