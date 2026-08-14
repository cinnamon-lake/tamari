import { describe, it, expect, vi } from 'vitest';
import { AppSettingsSchema, type SettingsMap } from '@tamari/types';
import { ChatPromptAssembly, type ChatPromptAssemblyDeps } from './ChatPromptAssembly.js';

/**
 * Append-only lock regression: a rolling memory summary prepended before the
 * chat history mutates already-sent bytes on every update interval, breaking
 * the byte-prefix invariant. With appendOnlyPromptLayout on, the assembly must
 * not even ask MemoryService for a summary.
 */
describe('ChatPromptAssembly memory locking', () => {
  function makeAssembly(settings: SettingsMap) {
    const ensureSummaryUpdated = vi.fn(async () => 'SUMMARY');
    const build = vi.fn(async () => ({ messages: [] }));

    const deps = {
      chats: {
        getActiveBranch: vi.fn(async () => []),
        getBulkOfMessages: vi.fn(async () => []),
      },
      personas: { getById: vi.fn(async () => null) },
      attachments: { getByIds: vi.fn(async () => []) },
      storage: {},
      promptBuilder: { build },
      worldInfo: { getById: vi.fn(async () => null) },
      characterAssets: { listForCharacter: vi.fn(async () => []) },
      memoryService: { ensureSummaryUpdated },
    } as unknown as ChatPromptAssemblyDeps;

    const assembly = new ChatPromptAssembly(deps);
    const args = {
      chatId: 'chat-1',
      chat: null,
      character: null,
      resolved: {
        allSettings: settings,
        backendConfig: null,
        promptList: null,
        backendSettings: {},
      },
    };
    return { assembly, args, ensureSummaryUpdated, build };
  }

  function settingsWithMemory(overrides: Record<string, unknown>): SettingsMap {
    return {
      ...AppSettingsSchema.parse({}),
      memory: {
        enabled: true,
        updateInterval: 5,
        depth: 10,
        backendConfigId: '',
        systemPrompt: 'Summarize.',
        maxSummaryTokens: 512,
      },
      ...overrides,
    } as SettingsMap;
  }

  it('requests a memory summary when append-only is off', async () => {
    const { assembly, args, ensureSummaryUpdated, build } = makeAssembly(
      settingsWithMemory({ appendOnlyPromptLayout: false }),
    );
    await assembly.build(args);

    expect(ensureSummaryUpdated).toHaveBeenCalledWith('chat-1');
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ memorySummary: 'SUMMARY' }));
  });

  it('skips the memory summary entirely when append-only is on', async () => {
    const { assembly, args, ensureSummaryUpdated, build } = makeAssembly(
      settingsWithMemory({ appendOnlyPromptLayout: true }),
    );
    await assembly.build(args);

    expect(ensureSummaryUpdated).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ memorySummary: null }));
  });
});
