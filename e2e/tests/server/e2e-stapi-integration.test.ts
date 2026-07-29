import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import { createStApi } from '../../../server/src/scripting/StApi.js';
import { ScriptContext } from '../../../server/src/scripting/ScriptContext.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

describe('e2e StApi integration', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;
  let chatId: string;
  let characterId: string;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.', firstMes: 'Hello!' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');
    characterId = char.character.id;

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
      data: { characterId, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');
    chatId = chat.chat.id;

    await h.send(client, {
      type: 'chat.materialize',
      chatId,
      selectedIndex: 0,
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function createQuickReply(label: string, script: string) {
    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'chat',
        scopeId: chatId,
        label,
        script,
        language: 'lua',
      },
    } as ClientMessage);
    const created = h.expectBroadcast('quickreply.created');
    return created.item.id;
  }

  async function executeQuickReply(id: string) {
    await h.send(client, {
      type: 'quickreply.execute',
      id,
      chatId,
    } as ClientMessage);
  }

  function makeStApi(ctx: ScriptContext) {
    return createStApi(ctx, {
      generationService: h.deps.generationService,
      chats: h.deps.chats,
      characters: h.deps.characters,
      personas: h.deps.personas,
      settings: h.deps.settings,
      backendConfigs: h.deps.backendConfigs,
      worldInfo: h.deps.worldInfo,
      chatMembers: h.deps.chatMembers,
      extensionData: h.extensionData,
      bus: h.deps.bus,
      clientId: client.connection.id,
      chatBroadcast: h.deps.chatBroadcast,
      chatMetaBroadcast: h.deps.chatMetaBroadcast,
    });
  }

  describe('via quick replies', () => {
    it('st.send appends a user message', async () => {
      const id = await createQuickReply('Send', 'st.send("From QR")');
      await executeQuickReply(id);

      const snapshot = h.expectBroadcast('chat.snapshot');
      const userMsgs = snapshot.messages.filter((m) => m.role === 'user');
      expect(userMsgs.length).toBe(1);
      expect(getMessageText(userMsgs[0]!.extra.parts)).toBe('From QR');
    });

    it('st.cut removes the last message', async () => {
      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Cut me',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const id = await createQuickReply('Cut', 'st.cut(1)');
      await executeQuickReply(id);

      h.expectBroadcast('message.deleted');
      const updated = h.expectBroadcast('chat.updated');
      expect(updated.chat.headMessageId).toBeNull();
    });

    it('st.edit updates a message', async () => {
      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Original',
      } as ClientMessage);
      const snapshot = h.expectBroadcast('chat.snapshot');
      const msgId = snapshot.messages.find((m) => m.role === 'user')!.id;

      const id = await createQuickReply('Edit', `st.edit(${msgId}, "Edited")`);
      await executeQuickReply(id);

      const updated = h.expectBroadcast('message.snapshot');
      expect(getMessageText(updated.message.extra.parts)).toBe('Edited');
    });

    it('st.delete removes a message', async () => {
      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Delete me',
      } as ClientMessage);
      const snapshot = h.expectBroadcast('chat.snapshot');
      const msgId = snapshot.messages.find((m) => m.role === 'user')!.id;

      const id = await createQuickReply('Delete', `st.delete(${msgId})`);
      await executeQuickReply(id);

      const deleted = h.expectBroadcast('message.deleted');
      expect(deleted.messageId).toBe(msgId);
    });

    it('st.rename_chat updates the chat name', async () => {
      const id = await createQuickReply('Rename', 'st.rename_chat("RenamedQR")');
      await executeQuickReply(id);

      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat!.name).toBe('RenamedQR');

      const updated = h.expectBroadcast('chat.updated');
      expect(updated.chat.name).toBe('RenamedQR');
    });

    it('st.set_author_note writes author note metadata', async () => {
      const id = await createQuickReply('AuthorNote', 'st.set_author_note("Think carefully", { depth = 3, position = "before_prompt" })');
      await executeQuickReply(id);

      const updated = h.expectBroadcast('chat.updated');
      expect(updated.chat.metadata).toBeDefined();
      expect((updated.chat.metadata as any).authorsNote.content).toBe('Think carefully');
    });

    it('st.set_chat_metadata writes custom metadata', async () => {
      const id = await createQuickReply('Metadata', 'st.set_chat_metadata("scenario", "space station")');
      await executeQuickReply(id);

      const updated = h.expectBroadcast('chat.updated');
      expect((updated.chat.metadata as any).scenario).toBe('space station');
    });

    it('st.setvar persists chat-scoped variables', async () => {
      const id = await createQuickReply('SetVar', 'st.setvar("mood", "happy")');
      await executeQuickReply(id);

      // Read directly from DB to verify persistence
      const value = await h.deps.settings.get(`lua.var.${chatId}.mood`);
      expect(value).toBe('happy');
    });

    it('st.send_as appends a message as another character', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Raven', description: 'A dark mage.', firstMes: 'Greetings.' },
      } as ClientMessage);
      h.expectBroadcast('character.created');

      const id = await createQuickReply('SendAs', 'st.send_as("Raven", "I am Raven")');
      await executeQuickReply(id);

      const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
      const sentAs = branch.find((m) => getMessageText(m.extra.parts) === 'I am Raven');
      expect(sentAs).toBeDefined();
      expect(sentAs!.role).toBe('assistant');
    });

    it('st.send_narrator appends a narrator message', async () => {
      const id = await createQuickReply('Narrator', 'st.send_narrator("Narrator", "The wind howls.")');
      await executeQuickReply(id);

      const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
      const narrator = branch.find((m) => getMessageText(m.extra.parts) === 'The wind howls.');
      expect(narrator).toBeDefined();
      expect(narrator!.role).toBe('system');
    });

    it('st.comment appends a hidden comment', async () => {
      const id = await createQuickReply('Comment', 'st.comment("DM note")');
      await executeQuickReply(id);

      const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
      const comment = branch.find((m) => getMessageText(m.extra.parts) === 'DM note');
      expect(comment).toBeDefined();
      expect(comment!.role).toBe('system');
      expect((comment!.extra as any).hidden).toBe(true);
    });

    it('st.trigger runs a generation', async () => {
      const backend = new TrivialBackendAdapter([[{ type: 'content', content: 'Triggered!' }]]);
      await h.teardown();
      h = new TestHarness({ backendFactory: { create: async () => backend } });
      await h.initSchema();
      client = h.connectClient();

      // Recreate common setup
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.', firstMes: 'Hello!' },
      } as ClientMessage);
      const char = h.expectBroadcast('character.created');
      characterId = char.character.id;

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
        data: { characterId, name: 'Test Chat' },
      } as ClientMessage);
      const chat = h.expectBroadcast('chat.created');
      chatId = chat.chat.id;

      await h.send(client, {
        type: 'chat.materialize',
        chatId,
        selectedIndex: 0,
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Generate please',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const id = await createQuickReply('Trigger', 'st.trigger()');
      await executeQuickReply(id);

      h.expectBroadcast('generation.started');
      const patched = h.expectBroadcast('message.snapshot');
      expect(getMessageText(patched.message.extra.parts)).toBe('Triggered!');
      h.expectBroadcast('generation.done');
    });

    it('st.branch creates a soft fork from a message', async () => {
      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Branch point',
      } as ClientMessage);
      const snapshot = h.expectBroadcast('chat.snapshot');
      const msgId = snapshot.messages.find((m) => m.role === 'user')!.id;

      const id = await createQuickReply('Branch', `st.branch(${msgId}, "Branched")`);
      await executeQuickReply(id);

      const created = h.expectBroadcast('chat.created');
      expect(created.chat.name).toBe('Branched');
      expect(created.chat.forkedFromChatId).toBe(chatId);
    });

    it('st.checkpoint creates a soft fork from the current head', async () => {
      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Checkpoint base',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const id = await createQuickReply('Checkpoint', 'st.checkpoint("Saved")');
      await executeQuickReply(id);

      const created = h.expectBroadcast('chat.created');
      expect(created.chat.name).toBe('Saved');
      expect(created.chat.forkedFromChatId).toBe(chatId);
    });
  });

  describe('direct StApi queries', () => {
    it('returns the current chat', async () => {
      const ctx = new ScriptContext(chatId, h.deps.generationService);
      const api = makeStApi(ctx);
      const chat = await (api.get_chat as () => Promise<unknown>)();
      expect(chat).toMatchObject({ id: chatId, name: 'Test Chat', characterId });
    });

    it('returns the character name', async () => {
      const ctx = new ScriptContext(chatId, h.deps.generationService);
      const api = makeStApi(ctx);
      const name = await (api.get_characterName as () => Promise<unknown>)();
      expect(name).toBe('Seraphina');
    });

    it('returns messages in the active branch', async () => {
      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Query me',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const ctx = new ScriptContext(chatId, h.deps.generationService);
      const api = makeStApi(ctx);
      const msgs = await (api.get_messages as () => Promise<Array<{ content: string }>>)();
      expect(msgs.length).toBe(2); // greeting + user message
      expect(msgs[1]!.content).toBe('Query me');
    });

    it('reads a chat-scoped variable', async () => {
      await h.deps.settings.setValue(`lua.var.${chatId}.mood`, 'happy');
      const ctx = new ScriptContext(chatId, h.deps.generationService);
      const api = makeStApi(ctx);
      const value = await (api.getvar as (name: string) => Promise<unknown>)('mood');
      expect(value).toBe('happy');
    });

    it('returns author note metadata', async () => {
      await h.deps.chats.updateChat(chatId, {
        metadata: {
          authorsNote: { content: 'Think carefully', depth: 3, interval: 1, position: 'before_prompt', role: 'system' },
        },
      });
      const ctx = new ScriptContext(chatId, h.deps.generationService);
      const api = makeStApi(ctx);
      const an = await (api.get_author_note as () => Promise<unknown>)();
      expect(an).toMatchObject({ content: 'Think carefully', depth: 3 });
    });

    it('returns custom chat metadata', async () => {
      await h.deps.chats.updateChat(chatId, { metadata: { scenario: 'space station' } });
      const ctx = new ScriptContext(chatId, h.deps.generationService);
      const api = makeStApi(ctx);
      const value = await (api.get_chat_metadata as (key: string) => Promise<unknown>)('scenario');
      expect(value).toBe('space station');
    });
  });
});
