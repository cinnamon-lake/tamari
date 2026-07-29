import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import type { ClientMessage } from '@tamari/types';
import { existsSync } from 'node:fs';

describe('dispatcher error and edge-case paths', () => {
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

  async function createCharacter(name: string) {
    await h.send(client, {
      type: 'character.create',
      data: { name, description: 'A helpful AI.', firstMes: 'Hello!' },
    } as ClientMessage);
    return h.expectBroadcast('character.created');
  }

  async function createChat(characterId: string) {
    await h.send(client, {
      type: 'chat.create',
      data: { characterId, name: 'Test Chat' },
    } as ClientMessage);
    return h.expectBroadcast('chat.created');
  }

  describe('action.send / action.generate', () => {
    it('returns a validation error when the chat does not exist', async () => {
      await h.send(client, {
        type: 'action.send',
        chatId: 'non-existent-chat',
        content: 'Hello',
      } as ClientMessage);

      const error = h.expectBroadcast('error');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toContain('Chat not found');
    });

    it('returns a validation error when generating in a non-existent chat', async () => {
      await h.send(client, {
        type: 'action.generate',
        chatId: 'non-existent-chat',
      } as ClientMessage);

      const error = h.expectBroadcast('error');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toContain('Chat not found');
    });
  });

  describe('chat.materialize', () => {
    it('is a no-op when the chat is already materialized', async () => {
      const char = await createCharacter('Seraphina');
      const chat = await createChat(char.character.id);

      await h.send(client, {
        type: 'chat.materialize',
        chatId: chat.chat.id,
        selectedIndex: 0,
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const beforeCount = (await h.deps.chats.getActiveBranch(chat.chat.id, { limit: 10 })).length;
      expect(beforeCount).toBeGreaterThan(0);

      // Second materialize should not append another greeting
      await h.send(client, {
        type: 'chat.materialize',
        chatId: chat.chat.id,
        selectedIndex: 0,
      } as ClientMessage);

      const afterCount = (await h.deps.chats.getActiveBranch(chat.chat.id, { limit: 10 })).length;
      expect(afterCount).toBe(beforeCount);
    });

    it('is a no-op when the chat has no character', async () => {
      await h.send(client, {
        type: 'chat.create',
        data: { name: 'Group Chat Stub' },
      } as ClientMessage);
      const chat = h.expectBroadcast('chat.created');

      await h.send(client, {
        type: 'chat.materialize',
        chatId: chat.chat.id,
        selectedIndex: 0,
      } as ClientMessage);

      const branch = await h.deps.chats.getActiveBranch(chat.chat.id, { limit: 10 });
      expect(branch.length).toBe(0);
    });
  });

  describe('action.delete', () => {
    it('rejects deleting a message that has replies or swipes', async () => {
      const char = await createCharacter('Seraphina');
      const chat = await createChat(char.character.id);

      // U1 -> A1 -> U2; deleting A1 (non-head with children) must fail
      await h.send(client, {
        type: 'action.send',
        chatId: chat.chat.id,
        content: 'Hello!',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      const assistant = await h.deps.chats.appendMessage(chat.chat.id, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Hi!' }] },
      });

      await h.send(client, {
        type: 'action.send',
        chatId: chat.chat.id,
        content: 'How are you?',
      } as ClientMessage);
      h.expectBroadcast('chat.snapshot');

      await h.send(client, {
        type: 'action.delete',
        chatId: chat.chat.id,
        messageId: assistant.id,
      } as ClientMessage);

      const error = h.expectBroadcast('error');
      expect(error.code).toBe('HAS_CHILDREN');
      expect(error.message).toContain('has replies or swipes');
    });
  });

  describe('settings.set with userName', () => {
    it('rebroadcasts greeting snapshots for unmaterialized chats', async () => {
      const char = await createCharacter('Seraphina');
      const chat = await createChat(char.character.id);

      await h.send(client, {
        type: 'settings.set',
        key: 'userName',
        value: 'CustomUser',
      } as ClientMessage);

      h.expectBroadcast('settings.changed');
      const snapshot = h.expectBroadcast('chat.snapshot');
      expect(snapshot.chat.id).toBe(chat.chat.id);
    });
  });

  describe('chat.update with selectedGreetingIndex', () => {
    it('rebroadcasts a greeting snapshot for unmaterialized chats', async () => {
      const char = await createCharacter('Seraphina');
      const chat = await createChat(char.character.id);

      await h.send(client, {
        type: 'chat.update',
        chatId: chat.chat.id,
        patch: { metadata: { selectedGreetingIndex: 0 } },
      } as ClientMessage);

      h.expectBroadcast('chat.updated');
      const snapshot = h.expectBroadcast('chat.snapshot');
      expect(snapshot.chat.id).toBe(chat.chat.id);
    });
  });

  describe('character.delete', () => {
    it('cleans up avatar and asset files when deleting a character', async () => {
      const char = await createCharacter('Seraphina');

      // Create avatar and asset files in storage
      const avatarPath = h.deps.storage.write('avatars', `${char.character.id}.png`, new Uint8Array([1, 2, 3]));
      const thumbnailPath = h.deps.storage.write('avatars', `${char.character.id}_thumb.png`, new Uint8Array([4, 5, 6]));
      const assetPath = h.deps.storage.write('character_assets', `${char.character.id}_asset.png`, new Uint8Array([7, 8, 9]));

      expect(existsSync(h.deps.storage.resolve(avatarPath))).toBe(true);
      expect(existsSync(h.deps.storage.resolve(thumbnailPath))).toBe(true);
      expect(existsSync(h.deps.storage.resolve(assetPath))).toBe(true);

      // Update character and create an asset record pointing at the files
      await h.deps.characters.update(char.character.id, {
        avatarPath,
        avatarThumbnailPath: thumbnailPath,
      });
      await h.deps.characterAssets.create(char.character.id, {
        id: `${char.character.id}:asset`,
        name: 'Test Asset',
        type: 'image',
        ext: 'png',
        filePath: assetPath,
        meta: {},
      });

      await h.send(client, {
        type: 'character.delete',
        characterId: char.character.id,
      } as ClientMessage);

      h.expectBroadcast('character.deleted');
      h.expectBroadcast('character.listed');

      expect(existsSync(h.deps.storage.resolve(avatarPath))).toBe(false);
      expect(existsSync(h.deps.storage.resolve(thumbnailPath))).toBe(false);
      expect(existsSync(h.deps.storage.resolve(assetPath))).toBe(false);
    });
  });
});
