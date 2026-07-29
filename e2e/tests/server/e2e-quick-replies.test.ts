import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

describe('e2e quick replies', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('creates, lists, updates, and deletes a quick reply', async () => {
    // Create a quick reply
    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'global',
        scopeId: 'global',
        label: 'Greet',
        script: 'st.send("Hello!")',
        language: 'lua',
      },
    } as ClientMessage);

    const created = h.expectBroadcast('quickreply.created');
    expect(created.item.label).toBe('Greet');
    expect(created.item.scope).toBe('global');
    const qrId = created.item.id;

    // List quick replies
    await h.send(client, {
      type: 'quickreply.list',
      scope: 'global',
      scopeId: 'global',
    } as ClientMessage);

    const listed = client.messages.find((m) => m.type === 'quickreply.listed') as any;
    expect(listed).toBeDefined();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].label).toBe('Greet');

    // Update the quick reply
    await h.send(client, {
      type: 'quickreply.update',
      id: qrId,
      patch: { label: 'Greet Updated' },
    } as ClientMessage);

    const updated = h.expectBroadcast('quickreply.updated');
    expect(updated.item.label).toBe('Greet Updated');

    // Delete the quick reply
    await h.send(client, {
      type: 'quickreply.delete',
      id: qrId,
    } as ClientMessage);

    const deleted = h.expectBroadcast('quickreply.deleted');
    expect(deleted.id).toBe(qrId);
  });

  it('rebroadcasts quickreply.listed (full table) after create, update, and delete', async () => {
    // The rebroadcast carries every scope — clients wholesale-replace and filter
    // by their own view at render time (AGENTS.md §5).
    await h.send(client, {
      type: 'quickreply.create',
      data: { scope: 'global', scopeId: '', label: 'G1', script: 'return 1', language: 'lua' },
    } as ClientMessage);
    const createdGlobal = h.expectBroadcast('quickreply.created');
    let listed = h.expectBroadcast('quickreply.listed');
    expect(listed.items.map((i) => i.id)).toContain(createdGlobal.item.id);

    await h.send(client, {
      type: 'quickreply.create',
      data: { scope: 'chat', scopeId: 'chat-1', label: 'C1', script: 'return 1', language: 'lua' },
    } as ClientMessage);
    const createdChat = h.expectBroadcast('quickreply.created');
    listed = h.expectBroadcast('quickreply.listed');
    expect(listed.items).toHaveLength(2);

    await h.send(client, {
      type: 'quickreply.update',
      id: createdChat.item.id,
      patch: { label: 'C1 renamed' },
    } as ClientMessage);
    h.expectBroadcast('quickreply.updated');
    listed = h.expectBroadcast('quickreply.listed');
    expect(listed.items).toHaveLength(2);
    expect(listed.items.find((i) => i.id === createdChat.item.id)?.label).toBe('C1 renamed');

    await h.send(client, { type: 'quickreply.delete', id: createdGlobal.item.id } as ClientMessage);
    h.expectBroadcast('quickreply.deleted');
    listed = h.expectBroadcast('quickreply.listed');
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.id).toBe(createdChat.item.id);
  });

  it('executes a quick reply that sends a message', async () => {
    // Set up a basic chat
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

    // Create a chat-scoped quick reply
    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'chat',
        scopeId: chat.chat.id,
        label: 'Send Greeting',
        script: 'st.send("Greetings from QR!")',
        language: 'lua',
      },
    } as ClientMessage);

    const created = h.expectBroadcast('quickreply.created');
    const qrId = created.item.id;

    // Execute the quick reply
    await h.send(client, {
      type: 'quickreply.execute',
      id: qrId,
      chatId: chat.chat.id,
    } as ClientMessage);

    // The script sends a message via st.send — verify it appears
    const snapshot = h.expectBroadcast('chat.snapshot');
    const userMsgs = snapshot.messages.filter((m) => m.role === 'user');
    expect(userMsgs.length).toBe(1);
    expect(getMessageText(userMsgs[0]!.extra.parts)).toBe('Greetings from QR!');
  });

  it('executes a quick reply that continues generation', async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'Hello!' }],
      [{ type: 'content', content: ' How are you?' }],
    ]);

    await h.teardown();
    h = new TestHarness({
      backendFactory: { create: async () => backend },
    });
    await h.initSchema();
    client = h.connectClient();

    // Set up a basic chat
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

    // Send a message and generate once
    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hi!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Create a quick reply that calls st.continue()
    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'chat',
        scopeId: chat.chat.id,
        label: 'Continue',
        script: 'st.continue()',
        language: 'lua',
      },
    } as ClientMessage);

    const created = h.expectBroadcast('quickreply.created');

    // Execute the quick reply
    await h.send(client, {
      type: 'quickreply.execute',
      id: created.item.id,
      chatId: chat.chat.id,
    } as ClientMessage);

    // Verify continue happened (new generation + patched message)
    const continueStarted = h.expectBroadcast('generation.started');
    expect(continueStarted.chatId).toBe(chat.chat.id);

    const continuePatched = h.expectBroadcast('message.snapshot');
    expect(getMessageText(continuePatched.message.extra!.parts)).toBe('Hello! How are you?');

    h.expectBroadcast('generation.done');
  });
});
