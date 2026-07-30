import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import { ToolRegistry } from '../../../server/src/services/ToolRegistry.js';
import { LuaToolExecutor } from '../../../server/src/services/LuaToolExecutor.js';
import { LuaRuntime } from '../../../server/src/scripting/LuaRuntime.js';
import { registerAssetsTemplate } from '../../../server/src/services/templates/AssetsTemplate.js';
import { registerLuaRunnerTemplate } from '../../../server/src/services/templates/LuaRunnerTemplate.js';
import { registerAgentTemplate } from '../../../server/src/services/templates/AgentTemplate.js';
import { GenerationRepository } from '../../../server/src/repos/GenerationRepository.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

describe('e2e default built-in tools', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  async function setupChat() {
    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.', firstMes: 'Hello!' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Test Config',
        description: '',
        backendProvider: 'openai',
        generationMode: 'chat',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
        instructTemplate: '',
        providerParams: {},
      },
    } as ClientMessage);
    const preset = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: preset.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'chat.materialize',
      chatId: chat.chat.id,
      selectedIndex: 0,
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    return { chatId: chat.chat.id };
  }

  async function setupToolset(_toolRegistry: ToolRegistry, templateId: string, name: string) {
    await h.send(client, {
      type: 'toolset.create',
      data: { templateId, name, config: {}, toolOverrides: {}, enabled: true },
    } as ClientMessage);
    return h.expectBroadcast('toolset.created');
  }

  describe('AssetsTemplate', () => {
    beforeEach(async () => {
      const backend = new TrivialBackendAdapter([
        [{ type: 'tool_use', id: 'call_1', name: 'list_assets', input: { limit: 10 } }],
        [{ type: 'content', content: 'Assets listed.' }],
      ]);

      const toolRegistry = new ToolRegistry();
      h = new TestHarness({ backendFactory: { create: async () => backend }, toolRegistry });
      await h.initSchema();
      registerAssetsTemplate(toolRegistry, { assets: h.deps.characterAssets, chats: h.deps.chats });
      client = h.connectClient();
    });

    afterEach(async () => {
      await h.teardown();
    });

    it('lists character assets', async () => {
      const { chatId } = await setupChat();
      await setupToolset(h.deps.toolRegistry!, 'assets', 'Assets Toolset');

      await h.send(client, { type: 'action.send', chatId, content: 'List assets' } as ClientMessage);
      h.expectBroadcast('chat.snapshot');
      await h.send(client, { type: 'action.generate', chatId } as ClientMessage);

      h.expectBroadcast('generation.started');
      h.expectBroadcast('generation.done');
      h.expectBroadcast('generation.started');
      h.expectBroadcast('generation.done');

      const patched = client.messages
        .filter((m) => m.type === 'message.snapshot')
        .find((m: any) => getMessageText(m.message.extra.parts).includes('Assets listed.'));
      expect(patched).toBeDefined();
    });
  });

  describe('LuaRunnerTemplate', () => {
    beforeEach(async () => {
      const backend = new TrivialBackendAdapter([
        [{ type: 'tool_use', id: 'call_1', name: 'run_lua', input: { script: 'return 2 + 2' } }],
        [{ type: 'content', content: 'Result received.' }],
        [{ type: 'tool_use', id: 'call_2', name: 'run_lua', input: { script: 'return string.upper("hello")' } }],
        [{ type: 'content', content: 'Uppercased.' }],
      ]);

      const toolRegistry = new ToolRegistry();
      const luaRuntime = new LuaRuntime();
      h = new TestHarness({ backendFactory: { create: async () => backend }, toolRegistry });
      await h.initSchema();
      toolRegistry.setLuaToolExecutor(new LuaToolExecutor(luaRuntime));
      registerLuaRunnerTemplate(toolRegistry, { luaRuntime });
      client = h.connectClient();
    });

    afterEach(async () => {
      await h.teardown();
    });

    it('executes Lua scripts and returns results', async () => {
      const { chatId } = await setupChat();
      await setupToolset(h.deps.toolRegistry!, 'lua_runner', 'Lua Runner Toolset');

      // Turn 1: Calculate 2+2
      await h.send(client, { type: 'action.send', chatId, content: 'Calculate 2+2' } as ClientMessage);
      h.expectBroadcast('chat.snapshot');
      await h.send(client, { type: 'action.generate', chatId } as ClientMessage);

      h.expectBroadcast('generation.started');
      h.expectBroadcast('generation.done');
      h.expectBroadcast('generation.started');
      h.expectBroadcast('generation.done');

      const patched1 = client.messages
        .filter((m) => m.type === 'message.snapshot')
        .find((m: any) => getMessageText(m.message.extra.parts).includes('Result received.'));
      expect(patched1).toBeDefined();

      // Turn 2: Uppercase hello
      await h.send(client, { type: 'action.send', chatId, content: 'Uppercase hello' } as ClientMessage);
      h.expectBroadcast('chat.snapshot');
      await h.send(client, { type: 'action.generate', chatId } as ClientMessage);

      h.expectBroadcast('generation.started');
      h.expectBroadcast('generation.done');
      h.expectBroadcast('generation.started');
      h.expectBroadcast('generation.done');

      const patched2 = client.messages
        .filter((m) => m.type === 'message.snapshot')
        .find((m: any) => getMessageText(m.message.extra.parts).includes('Uppercased.'));
      expect(patched2).toBeDefined();
    });
  });

  describe('AgentTemplate', () => {
    beforeEach(async () => {
      const mainBackend = new TrivialBackendAdapter([
        [{ type: 'tool_use', id: 'call_1', name: 'run_agent', input: { prompt: 'Summarize quantum physics' } }],
        [{ type: 'content', content: 'Agent result received.' }],
      ]);

      const agentBackend = new TrivialBackendAdapter([
        [{ type: 'content', content: 'Quantum physics is the study of matter and energy at the smallest scales.' }],
      ]);

      let callCount = 0;
      const toolRegistry = new ToolRegistry();
      h = new TestHarness({
        backendFactory: {
          create: async () => {
            callCount++;
            return callCount === 2 ? agentBackend : mainBackend;
          },
        },
        toolRegistry,
      });
      await h.initSchema();
      registerAgentTemplate(toolRegistry, {
        runner: h.generationRunner,
        targetDeps: {
          chats: h.deps.chats,
          generationBroadcast: h.generationBroadcast,
          assembly: h.chatPromptAssembly,
          toolRegistry,
          toolsetRepo: h.deps.toolsets,
        },
        generations: new GenerationRepository(h.db),
        maxAgentDepth: 4,
      });
      client = h.connectClient();
    });

    afterEach(async () => {
      await h.teardown();
    });

    it('delegates a task to an agent and returns the result', async () => {
      const { chatId } = await setupChat();
      await setupToolset(h.deps.toolRegistry!, 'agent', 'Agent Toolset');

      await h.send(client, { type: 'action.send', chatId, content: 'Ask agent about quantum physics' } as ClientMessage);
      h.expectBroadcast('chat.snapshot');
      await h.send(client, { type: 'action.generate', chatId } as ClientMessage);

      h.expectBroadcast('generation.started');
      h.expectBroadcast('generation.done');
      h.expectBroadcast('generation.started');
      h.expectBroadcast('generation.done');

      const patched = client.messages
        .filter((m) => m.type === 'message.snapshot')
        .find((m: any) => getMessageText(m.message.extra.parts).includes('Agent result received.'));
      expect(patched).toBeDefined();
    });

    it('returns an error for an empty prompt', async () => {
      const agent = h.deps.toolRegistry!.getBuiltinTemplate('agent')!;
      const result = await agent.execute('run_agent', { prompt: '' });
      expect(result.content).toContain('prompt is required');
    });
  });

  describe('AgentTemplate error branches with isolated deps', () => {
    let isolatedH: TestHarness;
    let isolatedClient: ReturnType<TestHarness['connectClient']>;

    afterEach(async () => {
      await isolatedH.teardown();
    });

    async function setupIsolated(backendFactory: { create: () => Promise<unknown> }) {
      const toolRegistry = new ToolRegistry();
      isolatedH = new TestHarness({ backendFactory: backendFactory as never, toolRegistry });
      await isolatedH.initSchema();
      isolatedClient = isolatedH.connectClient();
      registerAgentTemplate(toolRegistry, {
        runner: isolatedH.generationRunner,
        targetDeps: {
          chats: isolatedH.deps.chats,
          generationBroadcast: isolatedH.generationBroadcast,
          assembly: isolatedH.chatPromptAssembly,
          toolRegistry,
          toolsetRepo: isolatedH.deps.toolsets,
        },
        generations: new GenerationRepository(isolatedH.db),
        maxAgentDepth: 4,
      });
      // The sub-agent's generation record needs a real chat row (FK).
      await isolatedH.send(isolatedClient, {
        type: 'chat.create',
        data: { characterId: null, name: 'Iso Chat' },
      } as ClientMessage);
      const chatId = isolatedH.expectBroadcast('chat.created').chat.id;
      return { toolRegistry, chatId };
    }

    it('returns an error when no backend is configured', async () => {
      const { toolRegistry, chatId } = await setupIsolated({ create: async () => null });
      const agent = toolRegistry.getBuiltinTemplate('agent')!;
      const result = await agent.execute('run_agent', { prompt: 'Hello' }, { chatId });
      expect(result.content).toContain('no backend configured');
    });

    it('returns an error when the backend stream fails', async () => {
      const failingBackend = {
        id: 'failing',
        supportsStreaming: true,
        supportsTools: false,
        async *stream() {
          throw new Error('Stream exploded');
        },
        listModels: async () => [],
      };
      const { toolRegistry, chatId } = await setupIsolated({ create: async () => failingBackend });
      const agent = toolRegistry.getBuiltinTemplate('agent')!;
      const result = await agent.execute('run_agent', { prompt: 'Fail me' }, { chatId });
      expect(result.content).toContain('Agent error');
      expect(result.content).toContain('Stream exploded');
    });
  });

  describe('LuaRunnerTemplate error branches', () => {
    beforeEach(async () => {
      const toolRegistry = new ToolRegistry();
      const luaRuntime = new LuaRuntime();
      h = new TestHarness({ toolRegistry });
      await h.initSchema();
      toolRegistry.setLuaToolExecutor(new LuaToolExecutor(luaRuntime));
      registerLuaRunnerTemplate(toolRegistry, { luaRuntime });
      client = h.connectClient();
    });

    afterEach(async () => {
      await h.teardown();
    });

    it('returns an error for an empty script', async () => {
      const luaRunner = h.deps.toolRegistry!.getBuiltinTemplate('lua_runner')!;
      const result = await luaRunner.execute('run_lua', { script: '' });
      expect(result.content).toContain('script is required');
    });

    it('returns an error for invalid Lua', async () => {
      const luaRunner = h.deps.toolRegistry!.getBuiltinTemplate('lua_runner')!;
      const result = await luaRunner.execute('run_lua', { script: 'this is not lua' });
      expect(result.content).toContain('Lua error');
    });
  });

  describe('AssetsTemplate error branches', () => {
    beforeEach(async () => {
      const toolRegistry = new ToolRegistry();
      h = new TestHarness({ toolRegistry });
      await h.initSchema();
      registerAssetsTemplate(toolRegistry, { assets: h.deps.characterAssets, chats: h.deps.chats });
      client = h.connectClient();
    });

    afterEach(async () => {
      await h.teardown();
    });

    it('returns an error when there is no active chat', async () => {
      const assets = h.deps.toolRegistry!.getBuiltinTemplate('assets')!;
      const result = await assets.execute('list_assets', {});
      expect(result.content).toContain('no active chat');
    });

    it('returns an error when the chat is not found', async () => {
      const assets = h.deps.toolRegistry!.getBuiltinTemplate('assets')!;
      const result = await assets.execute('list_assets', {}, { chatId: 'missing-chat' });
      expect(result.content).toContain('chat not found');
    });
  });
});
