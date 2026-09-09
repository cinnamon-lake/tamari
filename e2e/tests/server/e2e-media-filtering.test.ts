import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import type { BackendStreamItem, GenerationResult, Prompt } from '../../../server/src/backends/BackendAdapter.js';
import { ToolRegistry } from '../../../server/src/services/ToolRegistry.js';
import { LuaToolExecutor } from '../../../server/src/services/LuaToolExecutor.js';
import { LuaRuntime } from '../../../server/src/scripting/LuaRuntime.js';
import type { ClientMessage } from '@tamari/types';

/**
 * Media-capability filtering of tool results, end to end through the bus:
 * a Lua tool returns text + an inline image part; the follow-up round's prompt
 * must carry that tool_result with the image dropped (or placeholdered) when
 * the backend config declares supportsImages: false.
 */

// Minimal 1x1 transparent PNG as a data URL — inline, so the Lua tool needs
// no sandbox flags (no fetch / attachments.create).
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const imgLuaCode = `Tool = {}
function Tool.getDefinition()
  return {
    stateKey = "img",
    configSchema = {},
    tools = {
      { name = "img_test", description = "Return an inline image.", parameters = { type = "object", properties = {} } }
    }
  }
end
function Tool.execute()
  return { content = {
    { type = "text", text = "generated image" },
    { type = "image", source = "${PNG_DATA_URL}", mimeType = "image/png" }
  } }
end
return Tool
`;

/** Records every prompt it receives so tests can inspect what would go on the wire. */
class CapturingBackend extends TrivialBackendAdapter {
  readonly prompts: Prompt[] = [];

  override async *stream(prompt: Prompt, signal: AbortSignal): AsyncGenerator<BackendStreamItem, GenerationResult> {
    this.prompts.push(prompt);
    return yield* super.stream(prompt, signal);
  }
}

describe('e2e media filtering of tool results', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;
  let backend: CapturingBackend;

  beforeEach(async () => {
    backend = new CapturingBackend([
      // Round 1: the model calls the image tool.
      [{ type: 'tool_use', id: 'call_1', name: 'img_test', input: {} }],
      // Round 2 (after the tool result lands): a plain-text follow-up.
      [{ type: 'content', content: 'Here is the image.' }],
    ]);

    const toolRegistry = new ToolRegistry();
    h = new TestHarness({
      backendFactory: { create: async () => backend },
      toolRegistry,
    });
    await h.initSchema();
    toolRegistry.setLuaToolExecutor(new LuaToolExecutor(new LuaRuntime()));

    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function setupChat(mediaVerboseMode: boolean) {
    await h.send(client, {
      type: 'toolTemplate.create',
      data: { name: 'Image Lua', code: imgLuaCode, configSchema: {} },
    } as ClientMessage);
    const tmpl = h.expectBroadcast('toolTemplate.created');

    await h.send(client, {
      type: 'toolset.create',
      data: { templateId: tmpl.toolTemplate.id, name: 'Image Toolset', config: {}, toolOverrides: {}, enabled: true },
    } as ClientMessage);
    h.expectBroadcast('toolset.created');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Imogen', description: 'An artist.', firstMes: 'Hello!' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'No-Images Config',
        description: '',
        backendProvider: 'openai',
        generationMode: 'chat',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
        instructTemplate: '',
        providerParams: {},
        supportsImages: false,
      },
    } as ClientMessage);
    const preset = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: preset.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, { type: 'settings.set', key: 'mediaVerboseMode', value: mediaVerboseMode } as ClientMessage);
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

    return { chatId: chat.chat.id as string };
  }

  /** The tool_result part carried in the round-2 prompt's assistant message. */
  function roundTwoToolResult() {
    expect(backend.prompts.length).toBe(2);
    // Content is always a parts array now, so match the assistant message
    // that actually carries a tool_result part (not e.g. the firstMes).
    const isToolResultPart = (p: unknown) =>
      typeof p === 'object' && p !== null && (p as { type?: string }).type === 'tool_result';
    const assistant = backend.prompts[1]!.messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(isToolResultPart),
    );
    expect(assistant).toBeDefined();
    const parts = assistant!.content as Array<{ type: string; content?: unknown }>;
    const toolResult = parts.find((p) => p.type === 'tool_result');
    expect(toolResult).toBeDefined();
    return toolResult!;
  }

  it('replaces the tool result image with a placeholder in verbose mode', async () => {
    const { chatId } = await setupChat(true);

    await h.send(client, { type: 'action.send', chatId, content: 'Draw something' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');
    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');

    const content = roundTwoToolResult().content;
    expect(Array.isArray(content)).toBe(true);
    const payload = JSON.stringify(content);
    expect(payload).toContain('generated image');
    expect(payload).toContain('[Attached image]');
    expect(payload).not.toContain(PNG_DATA_URL);
  });

  it('drops the tool result image entirely when verbose mode is off', async () => {
    const { chatId } = await setupChat(false);

    await h.send(client, { type: 'action.send', chatId, content: 'Draw something' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');
    h.expectBroadcast('generation.started');
    h.expectBroadcast('generation.done');

    const content = roundTwoToolResult().content;
    expect(content).toEqual([{ type: 'text', text: 'generated image' }]);
  });
});
