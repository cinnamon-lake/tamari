/**
 * MemoryToolTemplate — exposes rolling-memory tools to the main model.
 *
 * - memory_get_raw: retrieve raw text of cited messages.
 * - memory_summarize_range: focused summary of a message range.
 */

import { z } from 'zod';
import type { ToolContext, ToolExecuteResult, ToolTemplate, ToolTemplateDefinition } from '../ToolTemplate.js';
import type { MemoryService } from '../MemoryService.js';

export interface MemoryToolTemplateDeps {
  memoryService: MemoryService;
}

export function registerMemoryToolTemplate(registry: { registerTemplate(template: ToolTemplate): void }, deps: MemoryToolTemplateDeps): void {
  registry.registerTemplate(new MemoryToolTemplate(deps));
}

/** Args for `memory_get_raw`. */
const MemoryGetRawArgs = z.object({
  messageIds: z.array(z.number().int()).describe('Message IDs to retrieve'),
});

/** Args for `memory_summarize_range`. */
const MemorySummarizeRangeArgs = z.object({
  startMessageId: z.number().int().describe('First message ID in the range'),
  endMessageId: z.number().int().describe('Last message ID in the range'),
  focus: z.string().optional().describe('Optional aspect to focus the summary on'),
});

class MemoryToolTemplate implements ToolTemplate {
  id = 'memory';
  name = 'Memory';
  source = 'builtin' as const;

  constructor(private deps: MemoryToolTemplateDeps) {}

  getDefinition(): ToolTemplateDefinition {
    return {
      stateKey: 'memory',
      configSchema: {
        type: 'object',
        properties: {},
      },
      tools: [
        {
          name: 'memory_get_raw',
          description:
            'Retrieve the raw text of specific past messages by their IDs. Use when the rolling summary references an event you need exact details on.',
          parameters: z.toJSONSchema(MemoryGetRawArgs),
        },
        {
          name: 'memory_summarize_range',
          description: 'Get a focused summary of a contiguous range of past messages.',
          parameters: z.toJSONSchema(MemorySummarizeRangeArgs),
        },
      ],
    };
  }

  async execute(toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const chatId = context?.chatId;
    if (!chatId) {
      return { content: 'Error: chatId is required' };
    }

    try {
      if (toolName === 'memory_get_raw') {
        const parsed = MemoryGetRawArgs.safeParse(args);
        if (!parsed.success) return { content: 'Error: invalid memory_get_raw arguments' };
        const content = await this.deps.memoryService.getRawMessages(chatId, { messageIds: parsed.data.messageIds });
        return { content };
      }

      if (toolName === 'memory_summarize_range') {
        const parsed = MemorySummarizeRangeArgs.safeParse(args);
        if (!parsed.success) return { content: 'Error: invalid memory_summarize_range arguments' };
        const { startMessageId, endMessageId, focus } = parsed.data;
        const content = await this.deps.memoryService.summarizeRange(chatId, { startMessageId, endMessageId, focus });
        return { content };
      }

      return { content: `Error: unknown memory tool "${toolName}"` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Memory tool error: ${message}` };
    }
  }

  serialize(): string {
    return '';
  }

  deserialize(_raw: string): void {}
}
