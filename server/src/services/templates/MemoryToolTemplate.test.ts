import { describe, it, expect, vi } from 'vitest';
import { registerMemoryToolTemplate } from './MemoryToolTemplate.js';
import type { MemoryService } from '../MemoryService.js';
import type { ToolTemplate } from '../ToolTemplate.js';

function makeTemplate() {
  const getRawMessages = vi.fn(async (_chatId: string, _args: { messageIds: number[] }) => 'raw messages text');
  const summarizeRange = vi.fn(
    async (_chatId: string, _args: { startMessageId: number; endMessageId: number; focus?: string }) => 'range summary',
  );
  const memoryService = { getRawMessages, summarizeRange } as unknown as MemoryService;
  let template: ToolTemplate | undefined;
  registerMemoryToolTemplate(
    {
      registerTemplate: (t) => {
        template = t;
      },
    },
    { memoryService },
  );
  if (!template) throw new Error('memory template was not registered');
  return { template, getRawMessages, summarizeRange };
}

describe('MemoryToolTemplate', () => {
  describe('registration', () => {
    it('registers the memory template as builtin', () => {
      const { template } = makeTemplate();
      expect(template.id).toBe('memory');
      expect(template.name).toBe('Memory');
      expect(template.source).toBe('builtin');
    });
  });

  describe('getDefinition', () => {
    it('exposes memory_get_raw and memory_summarize_range with parameters', async () => {
      const { template } = makeTemplate();
      const def = await template.getDefinition();
      expect(def.stateKey).toBe('memory');
      expect(def.configSchema).toEqual({ type: 'object', properties: {} });
      expect(def.tools.map((t) => t.name).sort()).toEqual(['memory_get_raw', 'memory_summarize_range']);
      const raw = def.tools.find((t) => t.name === 'memory_get_raw')!;
      const rawProps = raw.parameters?.properties as Record<string, unknown> | undefined;
      expect(rawProps?.messageIds).toBeDefined();
      const range = def.tools.find((t) => t.name === 'memory_summarize_range')!;
      const rangeProps = range.parameters?.properties as Record<string, unknown> | undefined;
      expect(rangeProps?.startMessageId).toBeDefined();
      expect(rangeProps?.endMessageId).toBeDefined();
    });
  });

  describe('execute', () => {
    it('requires a chatId in the context', async () => {
      const { template } = makeTemplate();
      expect((await template.execute('memory_get_raw', { messageIds: [1] })).content).toBe('Error: chatId is required');
      expect((await template.execute('memory_get_raw', { messageIds: [1] }, {})).content).toBe(
        'Error: chatId is required',
      );
    });

    it('memory_get_raw delegates to MemoryService and returns its content', async () => {
      const { template, getRawMessages } = makeTemplate();
      const result = await template.execute('memory_get_raw', { messageIds: [1, 2, 3] }, { chatId: 'chat-1' });
      expect(result.content).toBe('raw messages text');
      expect(getRawMessages).toHaveBeenCalledWith('chat-1', { messageIds: [1, 2, 3] });
    });

    it('memory_get_raw rejects invalid arguments', async () => {
      const { template, getRawMessages } = makeTemplate();
      expect((await template.execute('memory_get_raw', { messageIds: 'nope' }, { chatId: 'c' })).content).toBe(
        'Error: invalid memory_get_raw arguments',
      );
      expect((await template.execute('memory_get_raw', { messageIds: [1.5] }, { chatId: 'c' })).content).toBe(
        'Error: invalid memory_get_raw arguments',
      );
      expect(getRawMessages).not.toHaveBeenCalled();
    });

    it('memory_summarize_range delegates to MemoryService with and without focus', async () => {
      const { template, summarizeRange } = makeTemplate();
      const withFocus = await template.execute(
        'memory_summarize_range',
        { startMessageId: 1, endMessageId: 5, focus: 'the battle' },
        { chatId: 'chat-1' },
      );
      expect(withFocus.content).toBe('range summary');
      expect(summarizeRange).toHaveBeenCalledWith('chat-1', { startMessageId: 1, endMessageId: 5, focus: 'the battle' });

      const noFocus = await template.execute(
        'memory_summarize_range',
        { startMessageId: 2, endMessageId: 4 },
        { chatId: 'chat-1' },
      );
      expect(noFocus.content).toBe('range summary');
      expect(summarizeRange).toHaveBeenCalledWith('chat-1', { startMessageId: 2, endMessageId: 4, focus: undefined });
    });

    it('memory_summarize_range rejects invalid arguments', async () => {
      const { template, summarizeRange } = makeTemplate();
      expect(
        (await template.execute('memory_summarize_range', { startMessageId: 'a', endMessageId: 2 }, { chatId: 'c' }))
          .content,
      ).toBe('Error: invalid memory_summarize_range arguments');
      expect(summarizeRange).not.toHaveBeenCalled();
    });

    it('rejects unknown tool names', async () => {
      const { template } = makeTemplate();
      const result = await template.execute('memory_nope', {}, { chatId: 'c' });
      expect(result.content).toBe('Error: unknown memory tool "memory_nope"');
    });

    it('wraps MemoryService failures', async () => {
      const { template, getRawMessages } = makeTemplate();
      getRawMessages.mockRejectedValueOnce(new Error('db down'));
      expect((await template.execute('memory_get_raw', { messageIds: [1] }, { chatId: 'c' })).content).toBe(
        'Memory tool error: db down',
      );
      getRawMessages.mockRejectedValueOnce('plain string');
      expect((await template.execute('memory_get_raw', { messageIds: [1] }, { chatId: 'c' })).content).toBe(
        'Memory tool error: plain string',
      );
    });
  });

  describe('serialize / deserialize', () => {
    it('is stateless', () => {
      const { template } = makeTemplate();
      expect(template.serialize()).toBe('');
      expect(() => template.deserialize('anything')).not.toThrow();
    });
  });
});
