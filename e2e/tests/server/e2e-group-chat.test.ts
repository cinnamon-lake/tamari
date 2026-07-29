import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

describe('e2e group chat', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'Hello from charA!' }],
      [{ type: 'content', content: 'Hello from charB!' }],
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

  async function setupGroupChat() {
    // 1. Create two characters
    await h.send(client, {
      type: 'character.create',
      data: { name: 'CharA', description: 'First character.', firstMes: 'Hi!' },
    } as ClientMessage);
    const charA = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'CharB', description: 'Second character.', firstMes: 'Hey!' },
    } as ClientMessage);
    const charB = h.expectBroadcast('character.created');

    // 2. Create a persona
    await h.send(client, {
      type: 'persona.create',
      data: { name: 'Tester', description: 'A human user.' },
    } as ClientMessage);
    const persona = h.expectBroadcast('persona.created');

    // 3. Create preset
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

    // 4. Create group chat (characterId: null)
    await h.send(client, {
      type: 'chat.create',
      data: {
        characterId: null,
        personaId: persona.persona.id,
        name: 'Group Chat',
      },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');
    expect(chat.chat.characterId).toBeNull();

    // 6. Add members
    await h.send(client, {
      type: 'group.member.add',
      chatId: chat.chat.id,
      characterId: charA.character.id,
    } as ClientMessage);
    h.expectBroadcast('group.member.added');

    await h.send(client, {
      type: 'group.member.add',
      chatId: chat.chat.id,
      characterId: charB.character.id,
    } as ClientMessage);
    h.expectBroadcast('group.member.added');

    return {
      charAId: charA.character.id,
      charBId: charB.character.id,
      chatId: chat.chat.id,
    };
  }

  it('creates a group chat and generates responses from all members', async () => {
    const { charAId, charBId, chatId } = await setupGroupChat();

    // Send a user message
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello everyone!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    // Trigger generation — NATURAL strategy means both members respond
    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    // We should see two generation cycles
    const generationsStarted = client.messages.filter((m) => m.type === 'generation.started');
    expect(generationsStarted.length).toBe(2);

    const patchedMessages = client.messages.filter((m) => m.type === 'message.snapshot');
    // The streaming flusher may emit an extra snapshot after rendering.
    expect(patchedMessages.length).toBeGreaterThanOrEqual(2);

    const doneMessages = client.messages.filter((m) => m.type === 'generation.done');
    expect(doneMessages.length).toBe(2);

    // Verify DB state
    const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const assistantMsgs = branch.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(2);

    // Verify each message is attributed to the correct character
    const contents = assistantMsgs.map((m) => getMessageText(m.extra.parts));
    expect(contents).toContain('Hello from charA!');
    expect(contents).toContain('Hello from charB!');

    const charIds = assistantMsgs.map((m) => m.extra.characterId);
    expect(charIds).toContain(charAId);
    expect(charIds).toContain(charBId);
  });

  it('rejects adding members to a single-character chat', async () => {
    // Create a single-character chat
    await h.send(client, {
      type: 'character.create',
      data: { name: 'Solo', description: 'A solo character.' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Solo Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    // Try to add a member
    await h.send(client, {
      type: 'group.member.add',
      chatId: chat.chat.id,
      characterId: char.character.id,
    } as ClientMessage);

    const error = h.expectBroadcast('error');
    expect(error.code).toBe('NOT_GROUP_CHAT');
  });

  it('selects a group chat and receives member list', async () => {
    const { charAId, charBId, chatId } = await setupGroupChat();

    await h.send(client, {
      type: 'chat.select',
      chatId,
      limit: 30,
    } as ClientMessage);

    const snapshot = h.expectBroadcast('chat.snapshot');
    expect(snapshot.chat.id).toBe(chatId);

    const members = h.expectBroadcast('group.members');
    expect(members.chatId).toBe(chatId);
    expect(members.members.length).toBe(2);
    expect(members.members.some((m: any) => m.characterId === charAId)).toBe(true);
    expect(members.members.some((m: any) => m.characterId === charBId)).toBe(true);
  });

  it('updates a group member', async () => {
    const { charAId, chatId } = await setupGroupChat();

    await h.send(client, {
      type: 'group.member.update',
      chatId,
      characterId: charAId,
      patch: { talkativeness: 0.5 },
    } as ClientMessage);

    const updated = h.expectBroadcast('group.member.updated');
    expect(updated.chatId).toBe(chatId);
    expect(updated.member.characterId).toBe(charAId);
    expect(updated.member.talkativeness).toBe(0.5);
  });

  it('trims lines spoken by other group members', async () => {
    // Use a backend that inspects the prompt to know which character is generating
    const charAName = 'Alpha';
    const charBName = 'Beta';

    const backend = {
      id: 'group-trim-backend',
      supportsStreaming: true,
      supportsTools: false,
      callIndex: 0,
      async *stream(prompt: any, _signal: any) {
        const system = prompt.messages.find((m: any) => m.role === 'system')?.content ?? '';
        const isAlpha = system.includes(charAName);
        const content = isAlpha
          ? `Hello from ${charAName}!\n${charBName}: I should not appear.\nMore from ${charAName}.`
          : `Hello from ${charBName}!`;
        for (const char of content) {
          yield { type: 'text', token: char };
          await new Promise((r) => setTimeout(r, 1));
        }
        return {
          finishReason: 'stop',
          usage: { promptTokens: prompt.tokenUsage.prompt, completionTokens: content.length },
        };
      },
      async listModels() {
        return [{ id: 'trivial-model', name: 'Trivial Model' }];
      },
    };

    await h.teardown();
    h = new TestHarness({
      backendFactory: { create: async () => backend as any },
    });
    await h.initSchema();
    client = h.connectClient();

    // Create characters
    await h.send(client, {
      type: 'character.create',
      data: { name: charAName, description: 'First character.', firstMes: 'Hi!' },
    } as ClientMessage);
    const charA = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'character.create',
      data: { name: charBName, description: 'Second character.', firstMes: 'Hey!' },
    } as ClientMessage);
    const charB = h.expectBroadcast('character.created');

    // Set up the group chat
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
      data: {
        characterId: null,
        personaId: persona.persona.id,
        name: 'Group Chat',
      },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'group.member.add',
      chatId: chat.chat.id,
      characterId: charA.character.id,
    } as ClientMessage);
    h.expectBroadcast('group.member.added');

    await h.send(client, {
      type: 'group.member.add',
      chatId: chat.chat.id,
      characterId: charB.character.id,
    } as ClientMessage);
    h.expectBroadcast('group.member.added');

    const chatId = chat.chat.id;

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello everyone!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    // Wait for both generations to complete
    const doneEvents = client.messages.filter((m) => m.type === 'generation.done');
    expect(doneEvents.length).toBe(2);

    const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const assistantMsgs = branch.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(2);

    // Find Alpha's message (should have been trimmed)
    const alphaMsg = assistantMsgs.find((m) => m.extra.characterId === charA.character.id);
    expect(alphaMsg).toBeDefined();

    // The line "Beta: I should not appear." should have been stripped
    expect(getMessageText(alphaMsg!.extra.parts)).toContain('Hello from Alpha!');
    expect(getMessageText(alphaMsg!.extra.parts)).toContain('More from Alpha.');
    expect(getMessageText(alphaMsg!.extra.parts)).not.toContain('I should not appear.');
  });
});
