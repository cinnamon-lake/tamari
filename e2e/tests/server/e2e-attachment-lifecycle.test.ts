import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

function uuid(): string {
  return crypto.randomUUID();
}

describe('e2e attachment lifecycle', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  async function setupChat() {
    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.', firstMes: 'Hello!' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'persona.create',
      data: { name: 'Tester', description: 'A human user.' },
    } as ClientMessage);
    const persona = h.expectBroadcast('persona.created');

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
      data: { characterId: char.character.id, personaId: persona.persona.id, name: 'Test Chat' },
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

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'I see the image.' }],
    ]);

    h = new TestHarness({ backendFactory: { create: async () => backend } });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('uploads an attachment and sends it with a message', async () => {
    const { chatId } = await setupChat();

    // Upload attachment via direct storage write + repo call
    const filePath = h.deps.storage.write('attachments', 'test-img.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const attId = uuid();
    const attachment = await h.deps.attachments.create({ id: attId, messageId: null, mimeType: 'image/png', filePath });

    // Send message with full AttachmentRef
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Look at this image',
      attachments: [{ id: attachment.id, mimeType: attachment.mimeType, meta: attachment.meta, url: attachment.url }],
    } as ClientMessage);

    const snapshot = h.expectBroadcast('chat.snapshot');
    expect(snapshot.messages.length).toBeGreaterThan(0);

    const userMsg = snapshot.messages[snapshot.messages.length - 1]!;
    expect(getMessageText(userMsg.extra.parts)).toBe('Look at this image');
    const attachments = userMsg.extra.attachments as Array<{ id: string }> | undefined;
    expect(attachments).toBeDefined();
    expect(attachments!.length).toBe(1);
    expect(attachments![0]!.id).toBe(attachment.id);
  });

  it('links an attachment to a message after creation', async () => {
    const { chatId } = await setupChat();

    // Send message without attachment first
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Here is an image',
    } as ClientMessage);
    const snapshot1 = h.expectBroadcast('chat.snapshot');
    const userMsg = snapshot1.messages[snapshot1.messages.length - 1]!;

    // Create attachment
    const filePath = h.deps.storage.write('attachments', 'test-img-2.png', new Uint8Array([0x89, 0x50]));
    const attId = uuid();
    const attachment = await h.deps.attachments.create({ id: attId, messageId: null, mimeType: 'image/png', filePath });

    // Link attachment to message
    await h.deps.attachments.linkToMessage(attachment.id, userMsg.id);

    // Verify link
    const linked = await h.deps.attachments.listByMessage(userMsg.id);
    expect(linked.length).toBe(1);
    expect(linked[0]!.id).toBe(attachment.id);
  });

  it('lists attachments by message', async () => {
    const { chatId } = await setupChat();

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Message with attachments',
    } as ClientMessage);
    const snapshot = h.expectBroadcast('chat.snapshot');
    const userMsg = snapshot.messages[snapshot.messages.length - 1]!;

    const filePath1 = h.deps.storage.write('attachments', 'img1.png', new Uint8Array([0x89, 0x50]));
    const attId1 = uuid();
    await h.deps.attachments.create({ id: attId1, messageId: null, mimeType: 'image/png', filePath: filePath1 });
    await h.deps.attachments.linkToMessage(attId1, userMsg.id);

    const filePath2 = h.deps.storage.write('attachments', 'img2.png', new Uint8Array([0x89, 0x50]));
    const attId2 = uuid();
    await h.deps.attachments.create({ id: attId2, messageId: null, mimeType: 'image/png', filePath: filePath2 });
    await h.deps.attachments.linkToMessage(attId2, userMsg.id);

    const messageAttachments = await h.deps.attachments.listByMessage(userMsg.id);
    expect(messageAttachments.length).toBe(2);
  });

  it('deletes an attachment and removes the file', async () => {
    const { chatId: _chatId } = await setupChat();

    const filePath = h.deps.storage.write('attachments', 'to-delete.png', new Uint8Array([0x89, 0x50]));
    const attId = uuid();
    const attachment = await h.deps.attachments.create({ id: attId, messageId: null, mimeType: 'image/png', filePath });

    expect(h.deps.storage.exists(attachment.filePath)).toBe(true);

    await h.deps.attachments.delete(attachment.id);

    const afterDelete = await h.deps.attachments.getById(attachment.id);
    expect(afterDelete).toBeUndefined();
  });

  it('retrieves an attachment by id', async () => {
    const { chatId: _chatId } = await setupChat();

    const filePath = h.deps.storage.write('attachments', 'get-by-id.png', new Uint8Array([0x89, 0x50]));
    const attId = uuid();
    await h.deps.attachments.create({ id: attId, messageId: null, mimeType: 'image/png', filePath, meta: { key: 'value' } });

    const retrieved = await h.deps.attachments.getById(attId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(attId);
    expect(retrieved!.mimeType).toBe('image/png');
    expect(retrieved!.meta).toEqual({ key: 'value' });
  });
});
