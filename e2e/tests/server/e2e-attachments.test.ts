import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import type { ClientMessage } from '@tamari/types';

describe('e2e attachments / multimodal', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'I see the image!' }],
    ]);

    h = new TestHarness({
      backendFactory: { create: async () => backend },
    });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function setupChatWithDebug() {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

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

  it('resolves attachments to image parts in the prompt', async () => {
    const { chatId } = await setupChatWithDebug();

    // Create a fake image file in storage
    const filePath = h.deps.storage.write('attachments', 'test-img.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    // Create attachment record
    const attachment = await h.deps.attachments.create({ id: 'att-test-1', messageId: null, mimeType: 'image/png', filePath });
    expect(attachment.id).toBe('att-test-1');

    // Send a message with the attachment reference
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Look at this image',
      attachments: [
        {
          id: 'att-test-1',
          mimeType: 'image/png',
          meta: {},
          url: '/api/attachments/att-test-1',
        },
      ],
    } as ClientMessage);

    h.expectBroadcast('chat.snapshot');

    // Generate and inspect the prompt
    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const userMessages = announced.prompt.messages.filter((m: any) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThan(0);

    // The user message should have content as an array with text + image parts
    const userMsg = userMessages[userMessages.length - 1]!;
    expect(Array.isArray(userMsg.content)).toBe(true);

    const parts = userMsg.content as Array<{ type: string; source?: string; mimeType?: string }>;
    expect(parts.length).toBe(2); // text + image

    const textPart = parts.find((p) => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart!.source ?? (textPart as any).text).toContain('Look at this image');

    const imagePart = parts.find((p) => p.type === 'image');
    expect(imagePart).toBeDefined();
    expect(imagePart!.mimeType).toBe('image/png');
    expect(imagePart!.source).toContain('data:image/png;base64');

    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');
  });

  it('persists attachment references on the user message', async () => {
    const { chatId } = await setupChatWithDebug();

    const filePath = h.deps.storage.write('attachments', 'test-img-2.png', new Uint8Array([0x89, 0x50]));
    await h.deps.attachments.create({ id: 'att-test-2', messageId: null, mimeType: 'image/png', filePath });

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Here is another image',
      attachments: [
        {
          id: 'att-test-2',
          mimeType: 'image/png',
          meta: {},
          url: '/api/attachments/att-test-2',
        },
      ],
    } as ClientMessage);

    h.expectBroadcast('chat.snapshot');

    const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const userMsg = branch.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();

    const attachments = userMsg!.extra.attachments as Array<{ id: string }> | undefined;
    expect(attachments).toBeDefined();
    expect(attachments!.length).toBe(1);
    expect(attachments![0]!.id).toBe('att-test-2');

    // Verify the attachment is linked in the DB
    const linked = await h.deps.attachments.listByMessage(userMsg!.id);
    expect(linked.length).toBe(1);
    expect(linked[0]!.id).toBe('att-test-2');
  });
});
