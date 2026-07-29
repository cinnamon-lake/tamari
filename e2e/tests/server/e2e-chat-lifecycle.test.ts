import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

describe('e2e chat lifecycle', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      [
        { type: 'thinking', content: 'Hmm...' },
        { type: 'content', content: 'Hello!' },
      ],
      [{ type: 'content', content: 'How can I help?' }],
      [{ type: 'content', content: 'Nice to meet you!' }],
    ]);

    h = new TestHarness({
      backendFactory: {
        create: async () => backend,
      },
    });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  /**
   * Helper: set up a complete chat through bus messages alone.
   * Returns { charId, personaId, presetId, chatId }
   */
  async function setupFullChat() {
    // 1. Create character
    await h.send(client, {
      type: 'character.create',
      data: {
        name: 'Seraphina',
        description: 'A helpful AI.',
        firstMes: 'Greetings!',
      },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    // 2. Create persona
    await h.send(client, {
      type: 'persona.create',
      data: { name: 'Tester', description: 'A human user.' },
    } as ClientMessage);
    const persona = h.expectBroadcast('persona.created');

    // 3. Create preset with all generation settings
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

    // 4. Activate preset via settings
    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: preset.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    // 5. Create chat
    await h.send(client, {
      type: 'chat.create',
      data: {
        characterId: char.character.id,
        personaId: persona.persona.id,
        name: 'Test Chat',
      },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    // 7. Materialize greeting
    await h.send(client, {
      type: 'chat.materialize',
      chatId: chat.chat.id,
      selectedIndex: 0,
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    return {
      charId: char.character.id,
      personaId: persona.persona.id,
      presetId: preset.backendConfig.id,
      chatId: chat.chat.id,
    };
  }

  it('creates a character, persona, preset, and carries out a chat through bus alone', async () => {
    const { chatId } = await setupFullChat();

    // 8. Send user message
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hi there!',
    } as ClientMessage);

    const snapshotAfterSend = h.expectBroadcast('chat.snapshot');
    expect(snapshotAfterSend.chat.headMessageId).not.toBeNull();

    // 9. Trigger generation
    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    // 10. Verify generation lifecycle broadcasts
    const started = h.expectBroadcast('generation.started');
    expect(started.chatId).toBe(chatId);

    const reasoningTokens = client.messages.filter(
      (m) => m.type === 'generation.reasoningToken',
    );
    expect(reasoningTokens.length).toBeGreaterThan(0);
    expect(reasoningTokens.map((m: any) => m.token).join('')).toBe('Hmm...');

    const contentTokens = client.messages.filter(
      (m) => m.type === 'generation.token',
    );
    expect(contentTokens.length).toBeGreaterThan(0);
    expect(contentTokens.map((m: any) => m.token).join('')).toBe('Hello!');

    const patched = h.expectBroadcast('message.snapshot');
    expect(patched.chatId).toBe(chatId);
    expect(getMessageText(patched.message.extra!.parts)).toBe('Hello!');

    const done = h.expectBroadcast('generation.done');
    expect(done.finishReason).toBe('stop');

    // 11. Verify DB state
    const chat = await h.deps.chats.getChatById(chatId);
    expect(chat?.headMessageId).not.toBeNull();
    expect(chat?.activeChildId).not.toBeNull();

    const messages = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(2); // greeting + generated
    const generatedMsg = assistantMsgs[assistantMsgs.length - 1]!;
    expect(getMessageText(generatedMsg.extra.parts)).toBe('Hello!');
  });

  it('carries out a multi-turn chat', async () => {
    const { chatId } = await setupFullChat();

    // Turn 1: send + generate
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'First message',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Turn 2: send + generate (backend cycles to second response)
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Second message',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);
    h.expectBroadcast('generation.started');

    const secondTokens = client.messages
      .filter((m) => m.type === 'generation.token')
      .slice(-'How can I help?'.length);
    expect(secondTokens.map((m: any) => m.token).join('')).toBe('How can I help?');

    const secondPatched = h.expectBroadcast('message.snapshot');
    expect(getMessageText(secondPatched.message.extra!.parts)).toBe('How can I help?');
    h.expectBroadcast('generation.done');

    // Verify message tree has 4 messages (greeting, user1, assistant1, user2, assistant2)
    // Actually greeting was materialized, so: greeting + user1 + assistant1 + user2 + assistant2
    const messages = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    expect(messages.length).toBe(5);
    expect(messages.filter((m) => m.role === 'user').length).toBe(2);
    expect(messages.filter((m) => m.role === 'assistant').length).toBe(3); // greeting + 2 responses
  });

  it('regenerates the last assistant message', async () => {
    const { chatId } = await setupFullChat();

    // Send and generate first response
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
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Regenerate (backend cycles to second response)
    await h.send(client, {
      type: 'action.regenerate',
      chatId,
    } as ClientMessage);

    const regenStarted = h.expectBroadcast('generation.started');
    expect(regenStarted.chatId).toBe(chatId);

    const regenPatched = h.expectBroadcast('message.snapshot');
    expect(getMessageText(regenPatched.message.extra!.parts)).toBe('How can I help?');

    h.expectBroadcast('generation.done');

    // Verify there are now two assistant siblings for the user message
    const chat = await h.deps.chats.getChatById(chatId);
    const userMsgId = chat!.headMessageId;
    const siblings = await h.deps.chats.getSiblings(userMsgId);
    expect(siblings.length).toBe(2);
    expect(siblings.map((s) => getMessageText(s.extra.parts))).toContain('Hello!');
    expect(siblings.map((s) => getMessageText(s.extra.parts))).toContain('How can I help?');
  });

  it('continues the assistant message', async () => {
    const { chatId } = await setupFullChat();

    // Send and generate first response
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
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Continue (backend cycles to second response and appends)
    await h.send(client, {
      type: 'action.continue',
      chatId,
    } as ClientMessage);

    const continueStarted = h.expectBroadcast('generation.started');
    expect(continueStarted.chatId).toBe(chatId);

    const continuePatched = h.expectBroadcast('message.snapshot');
    // Continue appends to the existing message
    expect(getMessageText(continuePatched.message.extra!.parts)).toBe('Hello!How can I help?');

    h.expectBroadcast('generation.done');

    // Verify only one assistant message exists (not a sibling)
    const messages = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(2); // greeting + continued response
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1]!;
    expect(getMessageText(lastAssistant.extra.parts)).toBe('Hello!How can I help?');
  });

  it('impersonates the user', async () => {
    const { chatId } = await setupFullChat();

    // Need at least one message to impersonate from
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
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Trigger impersonation (backend cycles to next response)
    await h.send(client, {
      type: 'action.impersonate',
      chatId,
    } as ClientMessage);

    const impStarted = h.expectBroadcast('generation.started');
    expect(impStarted.chatId).toBe(chatId);

    const impTokens = client.messages.filter((m) => m.type === 'generation.token');
    expect(impTokens.length).toBeGreaterThan(0);

    const impersonation = h.expectBroadcast('impersonation.complete');
    expect(impersonation.text).toBe('How can I help?');

    h.expectBroadcast('generation.done');

    // Verify no new message was appended to the chat
    const messagesBefore = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });

    // After impersonate, message count should still be 3 (greeting + user + assistant)
    expect(messagesBefore.length).toBe(3);
  });

  it('impersonates with reasoning tokens', async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'Hello!' }],
      [
        { type: 'thinking', content: 'Pretending to be user...' },
        { type: 'content', content: 'I am the user now.' },
      ],
    ]);

    await h.teardown();
    h = new TestHarness({
      backendFactory: { create: async () => backend },
    });
    await h.initSchema();
    client = h.connectClient();

    const { chatId } = await setupFullChat();

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
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Trigger impersonation
    await h.send(client, {
      type: 'action.impersonate',
      chatId,
    } as ClientMessage);

    h.expectBroadcast('generation.started');

    const reasoningTokens = client.messages.filter(
      (m) => m.type === 'generation.reasoningToken',
    );
    expect(reasoningTokens.length).toBeGreaterThan(0);
    expect(reasoningTokens.map((m: any) => m.token).join('')).toBe('Pretending to be user...');

    const impersonation = h.expectBroadcast('impersonation.complete');
    expect(impersonation.text).toBe('I am the user now.');

    h.expectBroadcast('generation.done');
  });

  it('edits a message', async () => {
    const { chatId } = await setupFullChat();

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
    h.expectBroadcast('generation.started');

    const patched = h.expectBroadcast('message.snapshot');
    const messageId = patched.message.id;
    h.expectBroadcast('generation.done');

    // Edit the generated message
    await h.send(client, {
      type: 'action.edit',
      chatId,
      messageId,
      content: 'Edited response!',
    } as ClientMessage);

    const editPatched = h.expectBroadcast('message.snapshot');
    expect(editPatched.message.id).toBe(messageId);
    expect(getMessageText(editPatched.message.extra!.parts)).toBe('Edited response!');

    // Verify DB state
    const msg = await h.deps.chats.getMessageById(messageId);
    expect(getMessageText(msg?.extra.parts)).toBe('Edited response!');
  });

  it('deletes a message', async () => {
    const { chatId } = await setupFullChat();

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
    h.expectBroadcast('generation.started');
    const patched = h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    const messageId = patched.message.id;

    // Delete the generated message
    await h.send(client, {
      type: 'action.delete',
      chatId,
      messageId,
    } as ClientMessage);

    const deleted = h.expectBroadcast('message.deleted');
    expect(deleted.messageId).toBe(messageId);

    // Verify the message is gone from the active branch
    const messages = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    expect(messages.some((m) => m.id === messageId)).toBe(false);
  });

  it('navigates between swipes', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    // Generate first response
    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);
    h.expectBroadcast('generation.started');
    const firstPatched = h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Regenerate to create a second swipe
    await h.send(client, {
      type: 'action.regenerate',
      chatId,
    } as ClientMessage);
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Verify two swipes exist
    const firstMsg = await h.deps.chats.getMessageById(firstPatched.message.id);
    const siblings = await h.deps.chats.getSiblings(firstMsg?.parentId ?? null);
    expect(siblings.length).toBe(2);

    // Swipe left (to first)
    await h.send(client, {
      type: 'action.swipe',
      chatId,
      messageId: firstPatched.message.id,
      direction: 'left',
    } as ClientMessage);

    const swipeLeft = h.expectBroadcast('chat.updated');
    expect(swipeLeft.chat.activeChildId).toBeDefined();

    // Swipe right (back to second)
    await h.send(client, {
      type: 'action.swipe',
      chatId,
      messageId: firstPatched.message.id,
      direction: 'right',
    } as ClientMessage);

    const swipeRight = h.expectBroadcast('chat.updated');
    expect(swipeRight.chat.activeChildId).toBeDefined();
  });

  it('soft forks a chat', async () => {
    const { chatId } = await setupFullChat();

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
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Get the user message id to fork at
    const messages = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();

    await h.send(client, {
      type: 'chat.softFork',
      chatId,
      messageId: userMsg!.id,
      name: 'Forked Chat',
    } as ClientMessage);

    const forked = h.expectBroadcast('chat.forked');
    expect(forked.chat.name).toBe('Forked Chat');
    expect(forked.chat.forkedFromChatId).toBe(chatId);
  });

  it('hard forks a chat', async () => {
    const { chatId } = await setupFullChat();

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
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    const messages = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();

    await h.send(client, {
      type: 'chat.hardFork',
      chatId,
      messageId: userMsg!.id,
      name: 'Hard Forked Chat',
    } as ClientMessage);

    const forked = h.expectBroadcast('chat.forked');
    expect(forked.chat.name).toBe('Hard Forked Chat');
    expect(forked.chat.forkedFromChatId).toBe(chatId);
  });

  it('cuts the last N messages from the active branch', async () => {
    const { chatId } = await setupFullChat();

    // Build up some history: greeting + user + assistant
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
    h.expectBroadcast('generation.started');
    const patched = h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    const beforeCut = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    expect(beforeCut.length).toBe(3); // greeting + user + assistant

    // Cut the last message (the assistant response)
    await h.send(client, {
      type: 'action.cut',
      chatId,
      count: 1,
    } as ClientMessage);

    const deleted = h.expectBroadcast('message.deleted');
    expect(deleted.messageId).toBe(patched.message.id);

    const updated = h.expectBroadcast('chat.updated');
    expect(updated.chat.headMessageId).not.toBeNull();

    h.expectBroadcast('chat.snapshot');

    // Verify the assistant message is gone
    const afterCut = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    expect(afterCut.length).toBe(2); // greeting + user
    expect(afterCut.some((m) => m.id === patched.message.id)).toBe(false);
  });

  it('resets a chat and clears all messages', async () => {
    const { chatId } = await setupFullChat();

    // Build up history
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
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    const beforeReset = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    expect(beforeReset.length).toBeGreaterThan(0);

    // Reset the chat
    await h.send(client, {
      type: 'chat.reset',
      chatId,
    } as ClientMessage);

    const loaded = h.expectBroadcast('messages.loaded');
    expect(loaded.messages).toHaveLength(0);

    const updated = h.expectBroadcast('chat.updated');
    expect(updated.chat.headMessageId).toBeNull();
    expect(updated.chat.activeChildId).toBeNull();

    // Verify DB state
    const afterReset = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    expect(afterReset).toHaveLength(0);

    const chat = await h.deps.chats.getChatById(chatId);
    expect(chat?.headMessageId).toBeNull();
    expect(chat?.activeChildId).toBeNull();
  });

  it('hides and unhides a message', async () => {
    const { chatId } = await setupFullChat();

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
    h.expectBroadcast('generation.started');
    const patched = h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Hide the generated message
    await h.send(client, {
      type: 'action.hide',
      chatId,
      messageId: patched.message.id,
    } as ClientMessage);

    const hidePatched = h.expectBroadcast('message.snapshot');
    expect(hidePatched.message.id).toBe(patched.message.id);
    expect(hidePatched.message.extra!.hidden).toBe(true);

    // Unhide the message
    await h.send(client, {
      type: 'action.unhide',
      chatId,
      messageId: patched.message.id,
    } as ClientMessage);

    const unhidePatched = h.expectBroadcast('message.snapshot');
    expect(unhidePatched.message.id).toBe(patched.message.id);
    expect(unhidePatched.message.extra!.hidden).toBe(false);

    // Verify DB
    const msg = await h.deps.chats.getMessageById(patched.message.id);
    expect(msg?.extra.hidden).toBe(false);
  });

  it('continues a message that has reasoning parts', async () => {
    // Backend emits reasoning on first generation, then more content on continue
    const backend = new TrivialBackendAdapter([
      [
        { type: 'thinking', content: 'Let me think...' },
        { type: 'content', content: 'Hello!' },
      ],
      [{ type: 'content', content: ' How are you?' }],
    ]);

    await h.teardown();
    h = new TestHarness({
      backendFactory: { create: async () => backend },
    });
    await h.initSchema();
    client = h.connectClient();

    const { chatId } = await setupFullChat();

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hi!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Continue the assistant message
    await h.send(client, {
      type: 'action.continue',
      chatId,
    } as ClientMessage);

    h.expectBroadcast('generation.started');
    const continuePatched = h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    expect(getMessageText(continuePatched.message.extra!.parts)).toBe('Hello! How are you?');

    // Verify reasoning parts were preserved
    const parts = continuePatched.message.extra!.parts as Array<{ type: string; text: string }> | undefined;
    expect(parts).toBeDefined();
    expect(parts!.some((p) => p.type === 'reasoning' && p.text.includes('Let me think...'))).toBe(true);
    expect(parts!.some((p) => p.type === 'text' && p.text.includes('Hello! How are you?'))).toBe(true);
  });

  it('deletes a chat and broadcasts chat.deleted', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, {
      type: 'chat.delete',
      chatId,
    } as ClientMessage);

    const deleted = h.expectBroadcast('chat.deleted');
    expect(deleted.chatId).toBe(chatId);

    // Verify the chat is gone
    const chat = await h.deps.chats.getChatById(chatId);
    expect(chat).toBeUndefined();
  });

  it('stops an in-flight generation', async () => {
    // Use a backend with very long content so we can stop mid-stream
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'This is a very long message that will take a while to stream.' }],
    ]);

    await h.teardown();
    h = new TestHarness({
      backendFactory: { create: async () => backend },
    });
    await h.initSchema();
    client = h.connectClient();

    const { chatId } = await setupFullChat();

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    // Fire generation without awaiting — it will stream for ~60ms
    const generatePromise = h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    // Poll until generation.started arrives
    let started: any;
    for (let i = 0; i < 50; i++) {
      started = client.messages.find((m) => m.type === 'generation.started');
      if (started) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(started).toBeDefined();

    // Stop the generation while it's still streaming
    await h.send(client, {
      type: 'action.stop',
      generationId: (started as any).generationId,
    } as ClientMessage);

    // Wait for the original generation promise to settle
    await generatePromise;

    // The generation should error or finish abnormally
    const done = h.lastBroadcast('generation.done');
    const error = h.lastBroadcast('generation.error');
    expect(done?.finishReason === 'error' || error !== undefined).toBe(true);
  });

  it('rejects cutting a message that has swipe children', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    // Generate first response
    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Regenerate to create a swipe sibling
    await h.send(client, {
      type: 'action.regenerate',
      chatId,
    } as ClientMessage);
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Try to cut the user message (which now has swipe children)
    const chat = await h.deps.chats.getChatById(chatId);
    const userMsgId = chat!.headMessageId;
    expect(userMsgId).not.toBeNull();

    await h.send(client, {
      type: 'action.cut',
      chatId,
      count: 2,
    } as ClientMessage);

    const error = h.expectBroadcast('error');
    expect(error.message).toContain('Cannot cut');
  });

  it('injects a system message via action.system', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, {
      type: 'action.system',
      chatId,
      content: 'System instruction injected.',
    } as ClientMessage);

    const snapshot = h.expectBroadcast('chat.snapshot');
    const allMsgs = [...snapshot.messages, ...(snapshot.swipes ?? [])];
    const systemMsgs = allMsgs.filter((m) => m.role === 'system');
    expect(systemMsgs.length).toBe(1);
    expect(getMessageText(systemMsgs[0]!.extra.parts)).toBe('System instruction injected.');
  });

  it('updates chat metadata via chat.update', async () => {
    const { chatId } = await setupFullChat();

    await h.send(client, {
      type: 'chat.update',
      chatId,
      patch: { metadata: { customField: 'customValue' } },
    } as ClientMessage);

    const updated = h.expectBroadcast('chat.updated');
    expect(updated.chat.metadata).toEqual({ customField: 'customValue' });

    const chat = await h.deps.chats.getChatById(chatId);
    expect(chat?.metadata).toEqual({ customField: 'customValue' });
  });
});
