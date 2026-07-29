import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

describe('dispatcher integration', () => {
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

  // ---------- Character CRUD ----------

  describe('character.create', () => {
    it('creates a character and broadcasts character.created', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const broadcast = h.expectBroadcast('character.created');
      expect(broadcast.character.name).toBe('Seraphina');
      expect(broadcast.character.description).toBe('A helpful AI.');
    });
  });

  describe('character.update', () => {
    it('updates a character and broadcasts character.updated + character.snapshot', async () => {
      // Create first
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const created = h.expectBroadcast('character.created');
      const charId = created.character.id;

      // Update
      await h.send(client, {
        type: 'character.update',
        characterId: charId,
        patch: { description: 'An even more helpful AI.' },
      } as ClientMessage);

      const updated = h.expectBroadcast('character.updated');
      expect(updated.character.description).toBe('An even more helpful AI.');

      const snapshot = h.expectBroadcast('character.snapshot');
      expect(snapshot.character.description).toBe('An even more helpful AI.');
    });
  });

  describe('character.delete', () => {
    it('deletes a character and broadcasts character.deleted', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const created = h.expectBroadcast('character.created');
      const charId = created.character.id;

      await h.send(client, {
        type: 'character.delete',
        characterId: charId,
      } as ClientMessage);

      const deleted = h.expectBroadcast('character.deleted');
      expect(deleted.characterId).toBe(charId);

      // Verify it's gone
      const fetched = await h.deps.characters.getById(charId);
      expect(fetched).toBeUndefined();
    });
  });

  // ---------- Chat CRUD ----------

  describe('chat.create', () => {
    it('creates a chat linked to a character', async () => {
      // Need a character first
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const created = h.expectBroadcast('character.created');
      const charId = created.character.id;

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: charId, name: 'Test Chat' },
      } as ClientMessage);

      const broadcast = h.expectBroadcast('chat.created');
      expect(broadcast.chat.name).toBe('Test Chat');
      expect(broadcast.chat.characterId).toBe(charId);
    });
  });

  describe('chat.select', () => {
    it('returns chat.snapshot with messages and character', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);

      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'chat.select',
        chatId,
        limit: 30,
      } as ClientMessage);

      const snapshot = h.expectBroadcast('chat.snapshot', client);
      expect(snapshot.chat.id).toBe(chatId);
      expect(snapshot.character?.id).toBe(char.character.id);
    });
  });

  // ---------- chat.hardFork ----------

  describe('chat.hardFork', () => {
    it('creates a forked chat with copied messages and broadcasts chat.forked', async () => {
      // Setup: character + chat + message
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);

      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);

      const chatAfterSend = await h.deps.chats.getChatById(chatId);
      const messageId = chatAfterSend!.headMessageId!;

      // Fork
      await h.send(client, {
        type: 'chat.hardFork',
        chatId,
        messageId,
        name: 'Fork of Test Chat',
      } as ClientMessage);

      const forked = h.expectBroadcast('chat.forked');
      expect(forked.chat.name).toBe('Fork of Test Chat');
      expect(forked.chat.characterId).toBe(char.character.id);
      expect(forked.chat.forkedFromChatId).toBe(chatId);
      expect(forked.chat.forkedAtMessageId).toBe(messageId);
      // Forking at a user message: head = copied message, active_child = null
      expect(forked.chat.headMessageId).not.toBeNull();
      expect(forked.chat.headMessageId).not.toBe(messageId); // hard fork copies messages
      expect(forked.chat.activeChildId).toBeNull();

      // Verify it appears in listChats
      const list = await h.deps.chats.listChats({ characterId: char.character.id });
      expect(list.items.some((c) => c.id === forked.chat.id)).toBe(true);

      // Verify messages were copied (not shared)
      const forkedMessages = await h.deps.chats.getActiveBranch(forked.chat.id, { limit: 10 });
      expect(forkedMessages.some((m) => getMessageText(m.extra.parts) === 'Hello!')).toBe(true);
    });
  });

  // ---------- chat.softFork ----------

  describe('chat.softFork', () => {
    it('creates a soft fork linking existing messages and broadcasts chat.forked', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);

      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);

      const chatAfterSend = await h.deps.chats.getChatById(chatId);
      const messageId = chatAfterSend!.headMessageId!;

      await h.send(client, {
        type: 'chat.softFork',
        chatId,
        messageId,
        name: 'Soft Fork of Test Chat',
      } as ClientMessage);

      const forked = h.expectBroadcast('chat.forked');
      expect(forked.chat.name).toBe('Soft Fork of Test Chat');
      expect(forked.chat.characterId).toBe(char.character.id);
      expect(forked.chat.forkedFromChatId).toBe(chatId);
      expect(forked.chat.forkedAtMessageId).toBe(messageId);
      // Forking at a user message: head = message, active_child = null
      expect(forked.chat.headMessageId).toBe(messageId);
      expect(forked.chat.activeChildId).toBeNull();

      // Verify it appears in listChats
      const list = await h.deps.chats.listChats({ characterId: char.character.id });
      expect(list.items.some((c) => c.id === forked.chat.id)).toBe(true);
    });
  });

  // ---------- action.send ----------

  describe('action.send', () => {
    it('appends a user message to the chat', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);

      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);

      // The chat should now have a head message
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat?.headMessageId).not.toBeNull();

      const messages = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
      expect(messages.some((m) => getMessageText(m.extra.parts) === 'Hello!')).toBe(true);
    });

    it('stores a full macroVars snapshot in the user message', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.', firstMes: 'Hey! {{setvar::mood::happy}}' },
      } as ClientMessage);

      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);

      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      // Materialize greeting so it sets mood=happy
      await h.send(client, {
        type: 'chat.materialize',
        chatId,
        selectedIndex: 0,
      } as ClientMessage);

      const greetingMsg = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
      expect(greetingMsg[0]!.extra.macroVars).toEqual({ mood: 'happy' });

      // User message adds a new var
      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Nice {{setvar::topic::weather}}',
      } as ClientMessage);

      const messages = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
      const userMsg = messages.find((m) => m.role === 'user');
      expect(getMessageText(userMsg?.extra.parts)).toBe('Nice ');
      expect(userMsg?.extra.macroVars).toEqual({ mood: 'happy', topic: 'weather' });
    });

    it('broadcasts chat.snapshot with character and persona after send', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'persona.create',
        data: { name: 'John', description: 'A user.' },
      } as ClientMessage);

      const persona = h.expectBroadcast('persona.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, personaId: persona.persona.id, name: 'Test Chat' },
      } as ClientMessage);

      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);

      const snapshot = h.expectBroadcast('chat.snapshot');
      expect(snapshot.character?.name).toBe('Seraphina');
      expect(snapshot.persona?.name).toBe('John');
    });

    it('includes the active swipe in messages after appending an assistant message', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);

      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const chatAfterUser = await h.deps.chats.getChatById(chatId);
      const userMsgId = chatAfterUser!.headMessageId!;

      // Simulate generation starting: append an assistant message
      const assistant = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Hi!' }] },
        parentId: userMsgId,
      });

      // Use getChatSnapshotMessages to verify the active swipe is in messages
      const { getChatSnapshotMessages } = await import('../../../server/src/lib/swipeInfo.js');
      const { messages, swipes } = await getChatSnapshotMessages(h.deps.chats, chatId, 100);

      expect(messages.some((m) => m.id === assistant.id)).toBe(true);
      expect(swipes.some((s) => s.id === assistant.id)).toBe(true);
    });
  });

  // ---------- action.cut ----------

  describe('action.cut', () => {
    it('deletes messages and updates head atomically', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);

      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      // Send a message so there's something to cut
      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);

      const chatBefore = await h.deps.chats.getChatById(chatId);
      const headId = chatBefore!.headMessageId!;

      // Cut the message
      await h.send(client, {
        type: 'action.cut',
        chatId,
        count: 1,
      } as ClientMessage);

      // Message should be gone
      const msg = await h.deps.chats.getMessageById(headId);
      expect(msg).toBeUndefined();

      // Head pointer should be null (no messages left)
      const chatAfter = await h.deps.chats.getChatById(chatId);
      expect(chatAfter?.headMessageId).toBeNull();
    });
  });

  // ---------- action.delete ----------

  describe('action.delete', () => {
    it('rejects deleting a non-head message that has children', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);
      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);
      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      // Build a linear chain: U1 → A1 → U2 → A2
      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Hi there!' }] },
      });

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'How are you?',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Doing great!' }] },
      });

      const chat = await h.deps.chats.getChatById(chatId);
      const headId = chat!.headMessageId!;
      // head is U2; A1 is not head but has child U2
      const a1 = (await h.deps.chats.getActiveBranch(chatId, { limit: 100 }))[1]!;
      expect(a1.role).toBe('assistant');
      expect(a1.id).not.toBe(headId);

      // Try to delete A1 (non-head with children)
      await h.send(client, {
        type: 'action.delete',
        chatId,
        messageId: a1.id,
      } as ClientMessage);

      const error = h.expectBroadcast('error');
      expect(error.code).toBe('HAS_CHILDREN');
    });

    it('Rule A: deletes active_child and switches to another swipe', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);
      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);
      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const chatAfterUser = await h.deps.chats.getChatById(chatId);
      const userMsgId = chatAfterUser!.headMessageId!;

      // Create two swipes (assistant replies to the user message)
      const swipe1 = await h.deps.chats.insertMessage({
        role: 'assistant',
        parentId: userMsgId,
        extra: { parts: [{ type: 'text', text: 'Reply one' }] },
      });
      const swipe2 = await h.deps.chats.insertMessage({
        role: 'assistant',
        parentId: userMsgId,
        extra: { parts: [{ type: 'text', text: 'Reply two' }] },
      });

      // Set active_child to swipe1
      await h.deps.chats.updateChat(chatId, { activeChildId: swipe1.id });

      // Delete swipe1 (active_child)
      await h.send(client, {
        type: 'action.delete',
        chatId,
        messageId: swipe1.id,
      } as ClientMessage);

      h.expectBroadcast('message.deleted');
      const snapshot = h.expectBroadcast('chat.snapshot');
      const chatAfter = snapshot.chat;
      expect(chatAfter.activeChildId).toBe(swipe2.id);
      expect(chatAfter.headMessageId).toBe(userMsgId);
    });

    it('Rule B (user parent): deletes active_child with no swipes, leaves pointers null', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);
      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);
      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const chatAfterUser = await h.deps.chats.getChatById(chatId);
      const userMsgId = chatAfterUser!.headMessageId!;

      // Single assistant reply
      const assistant = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Hi!' }] },
      });

      expect((await h.deps.chats.getChatById(chatId))!.activeChildId).toBe(assistant.id);

      // Delete the assistant (active_child)
      await h.send(client, {
        type: 'action.delete',
        chatId,
        messageId: assistant.id,
      } as ClientMessage);

      h.expectBroadcast('message.deleted');
      const snapshot = h.expectBroadcast('chat.snapshot');
      const chatAfter = snapshot.chat;
      expect(chatAfter.activeChildId).toBeNull();
      expect(chatAfter.headMessageId).toBe(userMsgId);
    });

    it('Rule B (non-user parent): deletes active_child and rolls up to parent', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);
      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);
      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const chatAfterUser = await h.deps.chats.getChatById(chatId);
      const userMsgId = chatAfterUser!.headMessageId!;

      // Sequential assistant messages: user → A1 → A2
      const a1 = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'First reply' }] },
      });
      const a2 = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Second reply' }] },
      });

      const chatBeforeDelete = await h.deps.chats.getChatById(chatId);
      expect(chatBeforeDelete!.headMessageId).toBe(a1.id);
      expect(chatBeforeDelete!.activeChildId).toBe(a2.id);

      // Delete A2 (active_child)
      await h.send(client, {
        type: 'action.delete',
        chatId,
        messageId: a2.id,
      } as ClientMessage);

      h.expectBroadcast('message.deleted');
      const snapshot = h.expectBroadcast('chat.snapshot');
      const chatAfter = snapshot.chat;
      expect(chatAfter.activeChildId).toBe(a1.id);
      expect(chatAfter.headMessageId).toBe(userMsgId);
    });

    it('Rule C: deletes head with children and reparents them', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);
      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);
      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const chatAfterUser = await h.deps.chats.getChatById(chatId);
      const userMsgId = chatAfterUser!.headMessageId!;

      // Assistant reply
      const assistant = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Hi!' }] },
      });

      // Delete the user message (head) which has the assistant as child
      await h.send(client, {
        type: 'action.delete',
        chatId,
        messageId: userMsgId,
      } as ClientMessage);

      h.expectBroadcast('message.deleted');

      const chatAfter = await h.deps.chats.getChatById(chatId);
      expect(chatAfter!.headMessageId).toBeNull();
      expect(chatAfter!.activeChildId).toBe(assistant.id);

      // Assistant should now be a root message
      const assistantAfter = await h.deps.chats.getMessageById(assistant.id);
      expect(assistantAfter!.parentId).toBeNull();
    });

    it('chat.reset deletes all messages without FK errors', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);
      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);
      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'Hello!',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Hi!' }] },
      });

      await h.send(client, {
        type: 'action.send',
        chatId,
        content: 'How are you?',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Doing great!' }] },
      });

      const msgsBefore = await h.deps.chats.getActiveBranch(chatId, { limit: 100 });
      expect(msgsBefore.length).toBeGreaterThan(0);

      // Reset should succeed without FK violations
      await h.send(client, {
        type: 'chat.reset',
        chatId,
      } as ClientMessage);

      h.expectBroadcast('messages.loaded');
      const chatUpdated = h.expectBroadcast('chat.updated');
      expect(chatUpdated.chat.headMessageId).toBeNull();
      expect(chatUpdated.chat.activeChildId).toBeNull();

      const msgsAfter = await h.deps.chats.getActiveBranch(chatId, { limit: 100 });
      expect(msgsAfter.length).toBe(0);
    });
  });

  // ---------- persona.delete ----------

  describe('persona.delete', () => {
    it('cascades to chats and broadcasts persona.deleted', async () => {
      // Create two personas (can't delete the last one)
      await h.deps.personas.create('persona-1', { name: 'Tester' });
      await h.deps.personas.create('persona-2', { name: 'Backup' });

      // Create a character and chat linked to the persona
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);

      const char = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'chat.create',
        data: { characterId: char.character.id, name: 'Test Chat' },
      } as ClientMessage);

      const chatBroadcast = h.expectBroadcast('chat.created');
      const chatId = chatBroadcast.chat.id;

      // Link persona to chat
      await h.deps.chats.updateChat(chatId, { personaId: 'persona-1' });

      // Delete persona
      await h.send(client, {
        type: 'persona.delete',
        personaId: 'persona-1',
      } as ClientMessage);

      const deleted = h.expectBroadcast('persona.deleted');
      expect(deleted.personaId).toBe('persona-1');

      // Chat should be reassigned to the fallback persona
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat?.personaId).toBe('persona-2');
    });
  });
});
