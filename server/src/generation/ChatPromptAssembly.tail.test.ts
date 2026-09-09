import { describe, it, expect, vi } from 'vitest';
import { AppSettingsSchema, type Message, type SettingsMap } from '@tamari/types';
import { ChatPromptAssembly, type ChatPromptAssemblyDeps, type ChatPromptBuildArgs } from './ChatPromptAssembly.js';

/**
 * Protected-tail semantics: the anchored generation target and the synthetic
 * trailing seeds (impersonate/quiet) are NOT part of chatHistory — they ride
 * BuildOptions.tailMessages, rendered after the requestTransformers stage and
 * invisible to WI/RAG/macros/regex/depth injection/transformers.
 */
describe('ChatPromptAssembly generation tail', () => {
  function makeMsg(
    id: number,
    parentId: number | null,
    role: Message['role'],
    text: string,
    macroVars?: Record<string, string>,
  ): Message {
    return {
      id,
      parentId,
      role,
      extra: { parts: [{ type: 'text', text }], macroVars },
      createdAt: id,
      updatedAt: id,
    };
  }

  function makeAssembly(repo: {
    getActiveBranch?: Message[];
    getBulkOfMessages?: Message[];
    getMessageById?: Message | undefined;
  }) {
    const build = vi.fn(async () => ({ messages: [] }));
    const chats = {
      getActiveBranch: vi.fn(async () => repo.getActiveBranch ?? []),
      getBulkOfMessages: vi.fn(async () => repo.getBulkOfMessages ?? []),
      getMessageById: vi.fn(async () => repo.getMessageById),
    };

    const deps = {
      chats,
      personas: { getById: vi.fn(async () => null) },
      attachments: { getByIds: vi.fn(async () => []) },
      storage: {},
      promptBuilder: { build },
      worldInfo: { getById: vi.fn(async () => null) },
      characterAssets: { listForCharacter: vi.fn(async () => []) },
    } as unknown as ChatPromptAssemblyDeps;

    const assembly = new ChatPromptAssembly(deps);
    const args: ChatPromptBuildArgs = {
      chatId: 'chat-1',
      chat: null,
      character: null,
      resolved: {
        allSettings: AppSettingsSchema.parse({}) as SettingsMap,
        backendConfig: null,
        promptList: null,
        backendSettings: {},
      },
    };
    return { assembly, args, build, chats };
  }

  function buildOpts(build: ReturnType<typeof vi.fn>): { chatHistory: Message[]; tailMessages?: Message[] } {
    return build.mock.calls[0]![0] as { chatHistory: Message[]; tailMessages?: Message[] };
  }

  it('anchored build excludes the target from chatHistory and passes it as the tail', async () => {
    const target = makeMsg(3, 2, 'assistant', '');
    const { assembly, args, build, chats } = makeAssembly({
      getMessageById: target,
      getBulkOfMessages: [makeMsg(1, null, 'user', 'hi'), makeMsg(2, 1, 'assistant', 'hello')],
    });

    const result = await assembly.build({ ...args, anchorMessageId: 3 });

    // The history walk starts at the target's PARENT (exclusive of the target).
    expect(chats.getBulkOfMessages).toHaveBeenCalledWith('chat-1', { limit: expect.any(Number), beforeId: 2 });
    const opts = buildOpts(build);
    expect(opts.chatHistory.map((m) => m.id)).toEqual([1, 2]);
    expect(opts.tailMessages?.map((m) => m.id)).toEqual([3]);
    expect(result.chatHistory.map((m) => m.id)).toEqual([1, 2]);
  });

  it('anchored target with a null parent yields empty history and a lone tail', async () => {
    const target = makeMsg(1, null, 'assistant', '');
    const { assembly, args, build, chats } = makeAssembly({ getMessageById: target });

    await assembly.build({ ...args, anchorMessageId: 1 });

    expect(chats.getBulkOfMessages).not.toHaveBeenCalled();
    const opts = buildOpts(build);
    expect(opts.chatHistory).toEqual([]);
    expect(opts.tailMessages?.map((m) => m.id)).toEqual([1]);
  });

  it('falls back to the legacy inclusive walk when the target has vanished', async () => {
    const history = [makeMsg(1, null, 'user', 'hi'), makeMsg(99, 1, 'assistant', '')];
    const { assembly, args, build, chats } = makeAssembly({
      getMessageById: undefined,
      getBulkOfMessages: history,
    });

    await assembly.build({ ...args, anchorMessageId: 99 });

    // Inclusive walk on the anchor itself, and no tail — today's behavior.
    expect(chats.getBulkOfMessages).toHaveBeenCalledWith('chat-1', { limit: expect.any(Number), beforeId: 99 });
    const opts = buildOpts(build);
    expect(opts.chatHistory.map((m) => m.id)).toEqual([1, 99]);
    expect(opts.tailMessages).toEqual([]);
  });

  it('trailingMessages ride the tail, with macroVars chained from the last real history message', async () => {
    const last = makeMsg(2, 1, 'assistant', 'hello', { mood: 'warm' });
    const { assembly, args, build } = makeAssembly({ getActiveBranch: [makeMsg(1, null, 'user', 'hi'), last] });

    await assembly.build({
      ...args,
      trailingMessages: [{ role: 'system', parts: [{ type: 'text', text: 'SEED' }] }],
    });

    const opts = buildOpts(build);
    expect(opts.chatHistory.map((m) => m.id)).toEqual([1, 2]);
    expect(opts.tailMessages).toHaveLength(1);
    const seed = opts.tailMessages![0]!;
    expect(seed.role).toBe('system');
    expect(seed.extra.macroVars).toEqual({ mood: 'warm' });
  });

  it('anchored build with trailingMessages chains macroVars from the target', async () => {
    const target = makeMsg(3, 2, 'assistant', 'partial', { mood: 'cold' });
    const { assembly, args, build } = makeAssembly({
      getMessageById: target,
      getBulkOfMessages: [makeMsg(2, null, 'user', 'hi', { mood: 'warm' })],
    });

    await assembly.build({
      ...args,
      anchorMessageId: 3,
      trailingMessages: [{ role: 'user', parts: [{ type: 'text', text: 'SEED' }] }],
    });

    const opts = buildOpts(build);
    expect(opts.chatHistory.map((m) => m.id)).toEqual([2]);
    expect(opts.tailMessages?.map((m) => m.id)).toEqual([3, 0]);
    expect(opts.tailMessages![1]!.extra.macroVars).toEqual({ mood: 'cold' });
  });
});
