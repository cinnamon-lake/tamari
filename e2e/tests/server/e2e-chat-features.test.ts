import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

describe('e2e chat features', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  async function setupFullChat() {
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

    return { chatId: chat.chat.id, charId: char.character.id, personaId: persona.persona.id };
  }

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'Hello!' }],
      [{ type: 'content', content: 'How can I help?' }],
      [{ type: 'content', content: 'Nice to meet you!' }],
      [{ type: 'content', content: 'I am impersonating you.' }],
      [{ type: 'content', content: 'Continued thought.' }],
    ]);

    h = new TestHarness({ backendFactory: { create: async () => backend } });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('edits a message', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.send', chatId, content: 'Hi' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    const patched = h.expectBroadcast('message.snapshot');
    const msgId = patched.message.id;

    await h.send(client, { type: 'action.edit', chatId, messageId: msgId, content: 'Edited content' } as ClientMessage);
    const edited = h.expectBroadcast('message.snapshot');
    expect(edited.message.id).toBe(msgId);
    expect(getMessageText(edited.message.extra!.parts)).toBe('Edited content');
    expect(edited.message.extra!.editedAt).toBeDefined();
  });

  it('edits a single text part by index', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.send', chatId, content: 'Hi' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    const patched = h.expectBroadcast('message.snapshot');
    const msgId = patched.message.id;

    // Give the message a multi-part shape: text / reasoning / text.
    const existing = await h.deps.chats.getMessageById(msgId);
    await h.deps.chats.updateMessage(msgId, {
      extra: {
        ...existing!.extra,
        parts: [
          { type: 'text', text: 'first half' },
          { type: 'reasoning', text: 'some thinking' },
          { type: 'text', text: 'second half' },
        ],
      },
    });

    // Edit only the second text part (index 2).
    await h.send(client, {
      type: 'action.edit',
      chatId,
      messageId: msgId,
      content: 'edited second half',
      partIndex: 2,
    } as ClientMessage);
    const edited = h.expectBroadcast('message.snapshot');
    const parts = edited.message.extra!.parts!;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: 'first half' });
    expect(parts[1]).toEqual({ type: 'reasoning', text: 'some thinking' });
    expect(parts[2]).toEqual({ type: 'text', text: 'edited second half' });
    expect(edited.message.renderedHtml?.[2]).toContain('edited second half');

    // Editing a non-text part is rejected.
    await h.send(client, {
      type: 'action.edit',
      chatId,
      messageId: msgId,
      content: 'nope',
      partIndex: 1,
    } as ClientMessage);
    const err = h.expectBroadcast('error');
    expect(err.code).toBe('BAD_REQUEST');
  });

  it('hides and unhides a message', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.send', chatId, content: 'Hi' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    const patched = h.expectBroadcast('message.snapshot');
    const msgId = patched.message.id;

    await h.send(client, { type: 'action.hide', chatId, messageId: msgId } as ClientMessage);
    const hidden = h.expectBroadcast('message.snapshot');
    expect(hidden.message.id).toBe(msgId);
    expect(hidden.message.extra!.hidden).toBe(true);

    await h.send(client, { type: 'action.unhide', chatId, messageId: msgId } as ClientMessage);
    const unhidden = h.expectBroadcast('message.snapshot');
    expect(unhidden.message.id).toBe(msgId);
    expect(unhidden.message.extra!.hidden).toBe(false);
  });

  it('deletes a message', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.send', chatId, content: 'Hi' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    const patched = h.expectBroadcast('message.snapshot');
    const msgId = patched.message.id;

    await h.send(client, { type: 'action.delete', chatId, messageId: msgId } as ClientMessage);
    const deleted = h.expectBroadcast('message.deleted');
    expect(deleted.messageId).toBe(msgId);

    const snapshot = h.expectBroadcast('chat.snapshot');
    expect(snapshot.messages.some((m: any) => m.id === msgId)).toBe(false);
  });

  it('cuts messages', async () => {
    const { chatId } = await setupFullChat();

    // Generate 1 turn (materialize already consumed greeting)
    await h.send(client, { type: 'action.send', chatId, content: 'Turn 1' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    h.expectBroadcast('message.snapshot');

    const beforeCut = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const beforeCount = beforeCut.length;

    await h.send(client, { type: 'action.cut', chatId, count: 1 } as ClientMessage);
    const cutDeleted = h.expectBroadcast('message.deleted');
    expect(cutDeleted.chatId).toBe(chatId);

    const cutUpdated = h.expectBroadcast('chat.updated');
    expect(cutUpdated.chat.id).toBe(chatId);

    const afterCut = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    expect(afterCut.length).toBe(beforeCount - 1);
  });

  it('continues generation', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.send', chatId, content: 'Continue test' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    h.expectBroadcast('message.snapshot');

    await h.send(client, { type: 'action.continue', chatId } as ClientMessage);
    const continued = h.expectBroadcast('generation.started');
    expect(continued.chatId).toBe(chatId);

    const patched = h.expectBroadcast('message.snapshot');
    expect(patched.chatId).toBe(chatId);
    expect(getMessageText(patched.message.extra!.parts)).toBeDefined();
  });

  it('impersonates a user message', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.impersonate', chatId } as ClientMessage);
    const started = h.expectBroadcast('generation.started');
    expect(started.chatId).toBe(chatId);

    const complete = h.expectBroadcast('impersonation.complete');
    expect(complete.text).toBeDefined();

    h.expectBroadcast('generation.done');
  });

  it('stops generation', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.send', chatId, content: 'Stop test' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    // Start generation and capture its id
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    const started = h.expectBroadcast('generation.started');

    // Stop the specific generation
    await h.send(client, { type: 'action.stop', generationId: started.generationId } as ClientMessage);
    // With the trivial backend the generation may finish before stop is processed,
    // so we just assert that no error is broadcast.
    const types = client.messages.slice(-3).map((m: any) => m.type);
    expect(types).not.toContain('error');
  });

  it('swipes left and right', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.send', chatId, content: 'Swipe test' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    h.expectBroadcast('message.snapshot');

    await h.send(client, { type: 'action.swipe', chatId, direction: 'left' } as ClientMessage);
    const swiped = h.expectBroadcast('chat.snapshot');
    expect(swiped.chat.id).toBe(chatId);
  });

  it('soft forks a chat', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.send', chatId, content: 'Fork test' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    const patched = h.expectBroadcast('message.snapshot');

    await h.send(client, { type: 'chat.softFork', chatId, messageId: patched.message.id, name: 'Forked Chat' } as ClientMessage);
    const forked = h.expectBroadcast('chat.forked');
    expect(forked.chat.name).toBe('Forked Chat');
    expect(forked.chat.forkedFromChatId).toBe(chatId);
  });

  it('hard forks a chat', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.send', chatId, content: 'Hard fork test' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
    await h.send(client, { type: 'action.generate', chatId } as ClientMessage);
    const patched = h.expectBroadcast('message.snapshot');

    await h.send(client, { type: 'chat.hardFork', chatId, messageId: patched.message.id, name: 'Hard Forked Chat' } as ClientMessage);
    const forked = h.expectBroadcast('chat.forked');
    expect(forked.chat.name).toBe('Hard Forked Chat');
    expect(forked.chat.forkedFromChatId).toBe(chatId);
  });

  it('resets a chat', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, { type: 'action.send', chatId, content: 'Reset test' } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, { type: 'chat.reset', chatId } as ClientMessage);
    const updated = h.expectBroadcast('chat.updated');
    expect(updated.chat.headMessageId).toBeNull();
    expect(updated.chat.activeChildId).toBeNull();

    const loaded = h.expectBroadcast('messages.loaded');
    expect(loaded.messages.length).toBe(0);
  });

  it('switches persona in a chat', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, {
      type: 'persona.create',
      data: { name: 'New Persona', description: 'Another persona.' },
    } as ClientMessage);
    const newPersona = h.expectBroadcast('persona.created');

    await h.send(client, {
      type: 'chat.update',
      chatId,
      patch: { personaId: newPersona.persona.id },
    } as ClientMessage);
    const updated = h.expectBroadcast('chat.updated');
    expect(updated.chat.personaId).toBe(newPersona.persona.id);
  });
});
