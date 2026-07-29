/**
 * Docs tool template.
 *
 * Serves detailed markdown references for tamari features, addressed by
 * a fixed topic enum. Companion to the workbench templates: the model fetches
 * the relevant doc BEFORE editing configs, cards, or Lua scripts so it works
 * from the real field names and contracts instead of guessing.
 *
 * Stateless: no config, no serialize/deserialize protocol, and deliberately
 * no endsTurn — the model must get a follow-up round to use what it read.
 */

import { z } from 'zod';
import type { ToolContext, ToolExecuteResult, ToolTemplate, ToolTemplateDefinition } from '../ToolTemplate.js';
import { DOCS_CONTENT, DOCS_TOPICS } from './docs/index.js';

const DocsArgs = z.object({
  topic: z.enum(DOCS_TOPICS).describe('Which feature reference to fetch.'),
});

export function registerDocsTemplate(registry: { registerTemplate(template: ToolTemplate): void }): void {
  registry.registerTemplate(new DocsTemplate());
}

export class DocsTemplate implements ToolTemplate {
  id = 'docs';
  name = 'Docs';
  source = 'builtin' as const;

  getDefinition(): ToolTemplateDefinition {
    return {
      stateKey: 'docs',
      configSchema: { type: 'object', properties: {} },
      tools: [
        {
          name: 'docs',
          description: `Fetch the detailed markdown reference for a tamari feature. Call this BEFORE using a workbench or writing Lua when you are unsure of field names, tool semantics, or scripting contracts. Topics: ${DOCS_TOPICS.join(', ')}.`,
          parameters: z.toJSONSchema(DocsArgs),
        },
      ],
    };
  }

  async execute(_toolName: string, args: Record<string, unknown>, _context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = DocsArgs.safeParse(args);
    if (!parsed.success) {
      return { content: `Error: unknown topic. Valid topics: ${DOCS_TOPICS.join(', ')}` };
    }
    return { content: DOCS_CONTENT[parsed.data.topic] };
  }

  serialize(): string {
    return '';
  }

  deserialize(_raw: string): void {
    // no-op
  }
}
