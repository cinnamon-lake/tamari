import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import { ToolRegistry } from '../../../server/src/services/ToolRegistry.js';
import { LuaToolExecutor } from '../../../server/src/services/LuaToolExecutor.js';
import { LuaRuntime } from '../../../server/src/scripting/LuaRuntime.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

describe('e2e Lua tools with branch-aware state', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  const memoryLuaCode = `Tool = {}
Tool.state = { memories = {} }
function Tool.getDefinition()
  return {
    stateKey = "memory",
    configSchema = {},
    tools = {
      { name = "lua_set_memory", description = "Store a memory.", parameters = { type = "object", properties = { key = { type = "string" }, value = { type = "string" } }, required = {"key", "value"} } },
      { name = "lua_recall_memory", description = "Recall memories.", parameters = { type = "object", properties = { query = { type = "string" } } } }
    }
  }
end
function Tool.execute(args, context, toolName)
  if toolName == "lua_set_memory" then
    Tool.state.memories[args.key] = args.value
    return { content = "Memory stored: " .. args.key }
  elseif toolName == "lua_recall_memory" then
    local query = args.query or ""
    local results = {}
    for key, value in pairs(Tool.state.memories) do
      if query == "" or string.find(key:lower(), query:lower()) or string.find(value:lower(), query:lower()) then
        table.insert(results, key .. ": " .. value)
      end
    end
    if #results == 0 then
      return { content = "No memories." }
    end
    return { content = table.concat(results, "\\n") }
  end
  return { content = "Unknown tool: " .. tostring(toolName) }
end
function Tool.serialize()
  return json.encode(Tool.state)
end
function Tool.deserialize(raw)
  Tool.state = json.decode(raw)
end
return Tool
`;

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      // Turn 1: set_memory
      [{ type: 'tool_use', id: 'call_1', name: 'lua_set_memory', input: { key: 'user_name', value: 'Alice' } }],
      [{ type: 'content', content: "I'll remember that." }],
      // Turn 2: recall_memory
      [{ type: 'tool_use', id: 'call_2', name: 'lua_recall_memory', input: { query: 'name' } }],
      [{ type: 'content', content: 'Your name is Alice.' }],
    ]);

    const toolRegistry = new ToolRegistry();
    h = new TestHarness({
      backendFactory: { create: async () => backend },
      toolRegistry,
    });
    await h.initSchema();

    const luaRuntime = new LuaRuntime();
    toolRegistry.setLuaToolExecutor(new LuaToolExecutor(luaRuntime));

    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function setupChatWithLuaTools() {
    await h.send(client, {
      type: 'toolTemplate.create',
      data: { name: 'Memory Lua', code: memoryLuaCode, configSchema: {} },
    } as ClientMessage);
    const tmpl = h.expectBroadcast('toolTemplate.created');

    await h.send(client, {
      type: 'toolset.create',
      data: { templateId: tmpl.toolTemplate.id, name: 'Memory Toolset', config: {}, toolOverrides: {}, enabled: true },
    } as ClientMessage);
    h.expectBroadcast('toolset.created');

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

  it('stores and recalls memories via Lua tool', async () => {
    const { chatId } = await setupChatWithLuaTools();

    // Turn 1: set_memory
    await h.send(client, { type: 'action.send', chatId, content: 'Remember my name is Alice' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);

    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');
    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');

    const patched1 = client.messages
      .filter((m) => m.type === 'message.snapshot')
      .find((m: any) => getMessageText(m.message.extra.parts).includes("I'll remember that."));
    expect(patched1).toBeDefined();

    // Turn 2: recall_memory
    await h.send(client, { type: 'action.send', chatId, content: 'What is my name?' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);

    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');
    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');

    const patched2 = client.messages
      .filter((m) => m.type === 'message.snapshot')
      .find((m: any) => getMessageText(m.message.extra.parts).includes('Your name is Alice.'));
    expect(patched2).toBeDefined();

    // Verify DB state
    const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const assistantMsgs = branch.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(3); // greeting + 2 turns

    const lastMsg = assistantMsgs[assistantMsgs.length - 1]!;
    const parts = lastMsg.extra.parts as Array<{ type: string }> | undefined;
    expect(parts).toBeDefined();
    expect(parts!.length).toBe(3);
    expect(parts![0]!.type).toBe('tool_use');
    expect(parts![1]!.type).toBe('tool_result');
    expect(parts![2]!.type).toBe('text');
  });
});
