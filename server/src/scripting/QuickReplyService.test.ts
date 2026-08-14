import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { TrivialBackendAdapter } from '../backends/TrivialBackendAdapter.js';
import { QuickReplyAutoExecute } from '@tamari/types';

describe('QuickReplyService', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    h = new TestHarness({
      backendFactory: {
        create: async () => new TrivialBackendAdapter([[{ type: 'content', content: 'Generated text' }]]),
      },
    });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function setupChat() {
    await h.send(client, {
      type: 'character.create',
      data: { name: 'TestBot', description: 'A test bot.', firstMes: 'Hello!' },
    });
    const created = h.expectBroadcast('character.created');
    const charId = created.character.id;

    await h.deps.settings.setValue('model', 'trivial-model');
    await h.deps.settings.setValue('apiKey', 'fake-key');
    await h.deps.settings.setValue('backendProvider', 'openai');
    await h.deps.settings.setValue('maxResponseTokens', 100);

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: charId, name: 'Test Chat' },
    });
    const chatCreated = h.expectBroadcast('chat.created');
    const chatId = chatCreated.chat.id;

    await h.send(client, {
      type: 'chat.materialize',
      chatId,
      selectedIndex: 0,
    });
    h.expectBroadcast('chat.snapshot');

    return { charId, chatId };
  }

  it('executeById runs a Lua script that calls st.send', async () => {
    const { chatId } = await setupChat();

    const qr = await h.deps.quickReplies.create('qr-1', {
      scope: 'chat',
      scopeId: chatId,
      label: 'Greet',
      script: 'st.send("Hello from QR")',
      icon: '',
      color: '',
      language: 'lua',
      autoExecute: 0,
      orderIndex: 0,
    });

    await h.deps.quickReplyService.executeById(qr.id, chatId, client.connection.id);

    const userMessages = client.messages.filter(
      (m: any) => m.type === 'message.appended' && m.message.role === 'user',
    ) as any[];
    expect(userMessages.length).toBe(1);
    expect(userMessages[0].message.extra.parts[0].text).toBe('Hello from QR');
  });

  it('executeById rejects legacy STScript QRs', async () => {
    const { chatId } = await setupChat();

    const qr = await h.deps.quickReplies.create('qr-2', {
      scope: 'chat',
      scopeId: chatId,
      label: 'Legacy',
      script: '/send hello',
      icon: '',
      color: '',
      language: 'stscript',
      autoExecute: 0,
      orderIndex: 0,
    });

    await h.deps.quickReplyService.executeById(qr.id, chatId, client.connection.id);

    const error = h.expectBroadcast('script.error');
    expect(error.message).toContain('legacy STScript');
  });

  it('execute respects chat lock and reports busy', async () => {
    const { chatId } = await setupChat();

    const qr = await h.deps.quickReplies.create('qr-3', {
      scope: 'chat',
      scopeId: chatId,
      label: 'Slow',
      script: 'st.sleep(0.2)',
      icon: '',
      color: '',
      language: 'lua',
      autoExecute: 0,
      orderIndex: 0,
    });

    // Acquire the lock externally to simulate a busy chat
    h.deps.generationService.tryLockChat(chatId);

    await h.deps.quickReplyService.executeById(qr.id, chatId, client.connection.id);

    const error = h.expectBroadcast('script.error');
    expect(error.message).toContain('busy');

    h.deps.generationService.unlockChat(chatId);
  });

  it('st.sleep pauses the script without blocking event loop', async () => {
    const { chatId } = await setupChat();

    const qr = await h.deps.quickReplies.create('qr-4', {
      scope: 'chat',
      scopeId: chatId,
      label: 'Sleep',
      script: 'st.sleep(0.05) st.send("after sleep")',
      icon: '',
      color: '',
      language: 'lua',
      autoExecute: 0,
      orderIndex: 0,
    });

    await h.deps.quickReplyService.executeById(qr.id, chatId, client.connection.id);

    const userMessages = client.messages.filter(
      (m: any) => m.type === 'message.appended' && m.message.role === 'user',
    ) as any[];
    expect(userMessages.length).toBe(1);
    expect(userMessages[0].message.extra.parts[0].text).toBe('after sleep');
  });

  it('st.generate returns generated text', async () => {
    const { chatId } = await setupChat();

    const qr = await h.deps.quickReplies.create('qr-5', {
      scope: 'chat',
      scopeId: chatId,
      label: 'Gen',
      script: 'local text = st.generate("prompt") st.send(text)',
      icon: '',
      color: '',
      language: 'lua',
      autoExecute: 0,
      orderIndex: 0,
    });

    await h.deps.quickReplyService.executeById(qr.id, chatId, client.connection.id);

    const userMessages = client.messages.filter(
      (m: any) => m.type === 'message.appended' && m.message.role === 'user',
    ) as any[];
    expect(userMessages.length).toBe(1);
    expect(userMessages[0].message.extra.parts[0].text).toBe('Generated text');
  });

  it('runAutoExecute runs matching QRs on trigger', async () => {
    const { chatId } = await setupChat();

    await h.deps.quickReplies.create('qr-6', {
      scope: 'chat',
      scopeId: chatId,
      label: 'Auto',
      script: 'st.toast("auto fired", "info")',
      icon: '',
      color: '',
      language: 'lua',
      autoExecute: QuickReplyAutoExecute.USER_MESSAGE,
      orderIndex: 0,
    });

    await h.deps.quickReplyService.runAutoExecute(chatId, QuickReplyAutoExecute.USER_MESSAGE, client.connection.id);

    const toasts = client.messages.filter((m: any) => m.type === 'script.toast') as any[];
    expect(toasts.length).toBe(1);
    expect(toasts[0].message).toBe('auto fired');
  });

  it('abortChat aborts a running script', async () => {
    const { chatId } = await setupChat();

    const qr = await h.deps.quickReplies.create('qr-7', {
      scope: 'chat',
      scopeId: chatId,
      label: 'Long',
      script: 'st.sleep(2) st.send("should not send")',
      icon: '',
      color: '',
      language: 'lua',
      autoExecute: 0,
      orderIndex: 0,
    });

    const execPromise = h.deps.quickReplyService.executeById(qr.id, chatId, client.connection.id);

    // Give the script a moment to start, then abort
    await new Promise((resolve) => setTimeout(resolve, 100));
    h.deps.quickReplyService.abortChat(chatId);

    await execPromise;

    const userMessages = client.messages.filter(
      (m: any) => m.type === 'message.appended' && m.message.role === 'user',
    ) as any[];
    expect(userMessages.length).toBe(0);
  });
});
