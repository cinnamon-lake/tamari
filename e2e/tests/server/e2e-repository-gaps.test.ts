import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { CachedSettings } from '../../../server/src/repos/SettingsRepository.js';
import { createClient } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('repository coverage gaps', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
  });

  afterEach(async () => {
    await h.teardown();
  });

  describe('ChatRepository', () => {
    it('softFork links existing messages and preserves the source chat', async () => {
      // Seed a chat with a user message and an assistant reply
      const chatId = crypto.randomUUID();
      const chat = await h.deps.chats.createChat(chatId, {
        characterId: null,
        personaId: null,
        name: 'Source Chat',
        headMessageId: null,
        metadata: {},
      });

      const userMsg = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'Hello' }] },
      });
      const assistantMsg = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Hi' }] },
      });

      const forked = await h.deps.chats.softFork(chatId, assistantMsg.id, 'Soft Fork');
      expect(forked.name).toBe('Soft Fork');
      expect(forked.forkedFromChatId).toBe(chatId);
      expect(forked.forkedAtMessageId).toBe(assistantMsg.id);
      // Assistant message in soft fork stays linked to original user message
      expect(forked.headMessageId).toBe(userMsg.id);
      expect(forked.activeChildId).toBe(assistantMsg.id);

      // Source chat still exists
      const source = await h.deps.chats.getChatById(chatId);
      expect(source).toBeDefined();
      expect(source!.id).toBe(chatId);
    });

    it('hardFork copies messages into a new chat', async () => {
      const chatId = crypto.randomUUID();
      await h.deps.chats.createChat(chatId, {
        characterId: null,
        personaId: null,
        name: 'Source Chat',
        headMessageId: null,
        metadata: {},
      });

      const userMsg = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'Hello' }] },
      });
      const assistantMsg = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'Hi' }] },
      });

      const forked = await h.deps.chats.hardFork(chatId, assistantMsg.id, 'Hard Fork');
      expect(forked.name).toBe('Hard Fork');
      expect(forked.forkedFromChatId).toBe(chatId);
      expect(forked.forkedAtMessageId).toBe(assistantMsg.id);

      // Copied messages have new IDs
      const branch = await h.deps.chats.getActiveBranch(forked.id, { limit: 10 });
      expect(branch.length).toBe(2);
      expect(branch.some((m) => m.id === userMsg.id)).toBe(false);
      expect(branch.some((m) => m.id === assistantMsg.id)).toBe(false);
      expect(branch[0]!.role).toBe('user');
      expect(branch[1]!.role).toBe('assistant');
    });

    it('deleteChat removes the chat and throws on missing id', async () => {
      const chatId = crypto.randomUUID();
      await h.deps.chats.createChat(chatId, {
        characterId: null,
        personaId: null,
        name: 'To Delete',
        headMessageId: null,
        metadata: {},
      });

      await h.deps.chats.deleteChat(chatId);
      const gone = await h.deps.chats.getChatById(chatId);
      expect(gone).toBeUndefined();

      await expect(h.deps.chats.deleteChat('missing-id')).rejects.toThrow('Chat not found');
    });
  });

  describe('SettingsRepository and CachedSettings', () => {
    it('supports full-blob get/set/delete and list', async () => {
      const settings = h.deps.settings;

      await settings.set({ userName: 'Alice' });
      await settings.setValue('debugPrompts', true);
      const blob = await settings.get();
      expect(blob.userName).toBe('Alice');
      expect(blob.debugPrompts).toBe(true);

      expect(await settings.get('userName')).toBe('Alice');
      expect((await settings.getMany()).userName).toBe('Alice');
      expect(await settings.list()).toEqual(blob);

      await settings.delete('debugPrompts');
      const afterDelete = await settings.get();
      expect(afterDelete.debugPrompts).toBeUndefined();
    });

    it('CachedSettings caches reads and writes', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'st-cached-settings-'));
      const db = createClient({ url: `file:${join(tmpDir, 'test.db')}` });

      // Match the schema used by TestHarness
      await db.execute(`
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY CHECK (id = 0),
          blob TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);

      const cached = new CachedSettings(db);

      await cached.setValue('userName', 'Bob');
      expect(await cached.get('userName')).toBe('Bob');

      // Verify cache is used: mutate DB directly and cached read should not see it
      await db.execute({
        sql: `INSERT INTO settings (id, blob, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET blob = excluded.blob`,
        args: [0, JSON.stringify({ userName: 'Eve' }), Math.floor(Date.now() / 1000)],
      });
      expect(await cached.get('userName')).toBe('Bob');

      // A write through CachedSettings should invalidate and persist the new value
      await cached.setValue('userName', 'Carol');
      expect(await cached.get('userName')).toBe('Carol');

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('BackendConfigRepository', () => {
    it('lists, counts, and deletes backend configs', async () => {
      const repo = h.deps.backendConfigs;

      const idA = crypto.randomUUID();
      const idB = crypto.randomUUID();
      await repo.create(idA, {
        name: 'Config A',
        description: '',
        backendProvider: 'openai',
        generationMode: 'chat',
        model: 'gpt-4',
        instructTemplate: '',
        providerParams: {},
      });
      await repo.create(idB, {
        name: 'Config B',
        description: '',
        backendProvider: 'openrouter',
        generationMode: 'chat',
        model: 'claude',
        instructTemplate: '',
        providerParams: {},
      });

      const list = await repo.list();
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.some((c) => c.id === idA)).toBe(true);
      expect(list.some((c) => c.id === idB)).toBe(true);

      expect(await repo.count()).toBeGreaterThanOrEqual(2);

      await repo.delete(idB);
      expect((await repo.list()).some((c) => c.id === idB)).toBe(false);
      expect(await repo.count()).toBeGreaterThanOrEqual(1);
    });
  });
});
