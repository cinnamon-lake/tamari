import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import { ToolRegistry } from '../../../server/src/services/ToolRegistry.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

describe('e2e tool calling', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    // First response: model calls a tool
    // Second response: model answers with the tool result
    const backend = new TrivialBackendAdapter([
      [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }],
      [{ type: 'content', content: 'The weather in Paris is sunny.' }],
    ]);

    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTemplate({
      id: 'weather',
      name: 'Weather',
      source: 'builtin',
      getDefinition: () => ({
        stateKey: 'weather',
        configSchema: {},
        tools: [
          {
            name: 'get_weather',
            description: 'Get the current weather for a city',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string' },
              },
            },
          },
        ],
      }),
      execute: (_toolName, args) => Promise.resolve({ content: `Weather for ${args.city}: sunny, 25°C` }),
      serialize: () => '',
      deserialize: () => {},
    });

    h = new TestHarness({
      backendFactory: { create: async () => backend },
      toolRegistry,
    });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function setupChatWithTools() {
    // Enable tools
    // Create a toolset for the weather template
    await h.send(client, {
      type: 'toolset.create',
      data: { templateId: 'weather', name: 'Weather Toolset', config: {}, toolOverrides: {}, enabled: true },
    } as ClientMessage);
    h.expectBroadcast('toolset.created');

    // Create character
    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.', firstMes: 'Hello!' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    // Create preset
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

    // Create chat
    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    // Materialize greeting
    await h.send(client, {
      type: 'chat.materialize',
      chatId: chat.chat.id,
      selectedIndex: 0,
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    return { chatId: chat.chat.id };
  }

  it('executes a tool call and runs a follow-up generation', async () => {
    const { chatId } = await setupChatWithTools();

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'What is the weather in Paris?',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    // First generation starts
    const started1 = h.expectBroadcast('generation.started');
    expect(started1.chatId).toBe(chatId);

    // First generation completes with tool calls
    const done1 = h.expectBroadcast('generation.done');
    expect(done1.generationId).toBe(started1.generationId);

    // Message patched after first generation (with tool_use parts)
    const patched1 = client.messages
      .filter((m) => m.type === 'message.snapshot')
      .find((m: any) => m.message.extra!.parts?.some((p: any) => p.type === 'tool_use'));
    expect(patched1).toBeDefined();

    // Second generation starts (follow-up)
    const started2 = h.expectBroadcast('generation.started');
    expect(started2.chatId).toBe(chatId);

    // Second generation completes with text
    const done2 = h.expectBroadcast('generation.done');
    expect(done2.generationId).toBe(started2.generationId);

    // Final message patched with text
    const patched2 = client.messages
      .filter((m) => m.type === 'message.snapshot')
      .find((m: any) => getMessageText(m.message.extra!.parts).includes('The weather in Paris is sunny.'));
    expect(patched2).toBeDefined();

    // Verify DB state — message should have ordered parts: tool_use, tool_result, text
    const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const assistantMsgs = branch.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(2); // greeting + tool-calling response

    const toolMsg = assistantMsgs[assistantMsgs.length - 1]!;
    expect(getMessageText(toolMsg.extra.parts)).toBe('The weather in Paris is sunny.');

    const parts = toolMsg.extra.parts as Array<{ type: string }> | undefined;
    expect(parts).toBeDefined();
    expect(parts!.length).toBe(3);
    expect(parts![0]!.type).toBe('tool_use');
    expect(parts![1]!.type).toBe('tool_result');
    expect(parts![2]!.type).toBe('text');
  });

  it('includes tool definitions in the prompt when tools are enabled', async () => {
    const { chatId } = await setupChatWithTools();

    // Enable debug prompts so we can inspect the prompt
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    expect(announced.prompt.tools).toBeDefined();
    expect(announced.prompt.tools!.length).toBeGreaterThan(0);
    expect(announced.prompt.tools![0]!.function.name).toBe('get_weather');

    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');
  });

  it('executes multiple tool calls in a single generation', async () => {
    // First response: two tool calls
    // Second response: text answer
    const backend = new TrivialBackendAdapter([
      [
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
        { type: 'tool_use', id: 'call_2', name: 'get_weather', input: { city: 'London' } },
      ],
      [{ type: 'content', content: 'Paris is sunny, London is rainy.' }],
    ]);

    const freshToolRegistry = new ToolRegistry();
    freshToolRegistry.registerTemplate({
      id: 'weather',
      name: 'Weather',
      source: 'builtin',
      getDefinition: () => ({
        stateKey: 'weather',
        configSchema: {},
        tools: [
          {
            name: 'get_weather',
            description: 'Get the current weather for a city',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string' },
              },
            },
          },
        ],
      }),
      execute: (_toolName, args) => Promise.resolve({ content: `Weather for ${args.city}: sunny, 25°C` }),
      serialize: () => '',
      deserialize: () => {},
    });

    await h.teardown();
    h = new TestHarness({
      backendFactory: { create: async () => backend },
      toolRegistry: freshToolRegistry,
    });
    await h.initSchema();
    client = h.connectClient();

    const { chatId } = await setupChatWithTools();

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Weather in Paris and London?',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    // First generation completes with tool calls
    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');

    // Follow-up generation with text
    h.expectBroadcast('generation.started');
    const patched = h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    expect(getMessageText(patched.message.extra!.parts)).toBe('Paris is sunny, London is rainy.');

    // Verify both tool results are in the parts
    const parts = patched.message.extra!.parts as Array<{ type: string; name?: string }> | undefined;
    expect(parts).toBeDefined();
    const toolUses = parts!.filter((p) => p.type === 'tool_use');
    const toolResults = parts!.filter((p) => p.type === 'tool_result');
    expect(toolUses.length).toBe(2);
    expect(toolResults.length).toBe(2);
    expect(toolResults.some((p) => p.name === 'get_weather')).toBe(true);
  });

  it('propagates tool execution errors in the result', async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'tool_use', id: 'call_1', name: 'fail_tool', input: {} }],
      [{ type: 'content', content: 'The tool failed.' }],
    ]);

    const freshToolRegistry = new ToolRegistry();
    freshToolRegistry.registerTemplate({
      id: 'fails',
      name: 'Failing',
      source: 'builtin',
      getDefinition: () => ({
        stateKey: 'fails',
        configSchema: {},
        tools: [
          {
            name: 'fail_tool',
            description: 'A tool that always fails',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }),
      execute: () => { throw new Error('Intentional failure'); },
      serialize: () => '',
      deserialize: () => {},
    });

    await h.teardown();
    h = new TestHarness({
      backendFactory: { create: async () => backend },
      toolRegistry: freshToolRegistry,
    });
    await h.initSchema();
    client = h.connectClient();

    // Create a toolset for the fails template
    await h.send(client, {
      type: 'toolset.create',
      data: { templateId: 'fails', name: 'Failing Toolset', config: {}, toolOverrides: {}, enabled: true },
    } as ClientMessage);
    h.expectBroadcast('toolset.created');

    // Create character
    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.', firstMes: 'Hello!' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    // Create backend config
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

    // Create chat
    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');
    const chatId = chat.chat.id;

    await h.send(client, {
      type: 'chat.materialize',
      chatId,
      selectedIndex: 0,
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Trigger the failing tool.',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');
    h.expectBroadcast('generation.started');
    const patched = h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Verify the tool_result has isError=true
    const parts = patched.message.extra!.parts as Array<{ type: string; isError?: boolean; content?: string }> | undefined;
    expect(parts).toBeDefined();
    const toolResult = parts!.find((p) => p.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(true);
    expect(toolResult!.content).toContain('Intentional failure');
  });
});
