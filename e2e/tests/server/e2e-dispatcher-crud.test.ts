import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import type { ClientMessage } from '@tamari/types';

describe('dispatcher CRUD integration', () => {
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

  // ---------- BackendConfig CRUD ----------

  describe('backendConfig.create', () => {
    it('creates a backend config and broadcasts backendConfig.created + snapshot + listed', async () => {
      await h.send(client, {
        type: 'backendConfig.create',
        data: {
          name: 'Test Config',
          description: '',
          backendProvider: 'openai',
          generationMode: 'chat',
          model: 'gpt-4',
          apiKey: 'fake-key',
          contextLength: 4096,
          maxTokens: 100,
          instructTemplate: '',
          providerParams: {},
        },
      } as ClientMessage);

      const created = h.expectBroadcast('backendConfig.created');
      expect(created.backendConfig.name).toBe('Test Config');
      expect(created.backendConfig.backendProvider).toBe('openai');
      expect(created.backendConfig.model).toBe('gpt-4');

      const snapshot = h.expectBroadcast('backendConfig.snapshot');
      expect(snapshot.backendConfig.id).toBe(created.backendConfig.id);

      const listed = h.expectBroadcast('backendConfig.listed');
      expect(listed.backendConfigs).toHaveLength(1);
      expect(listed.backendConfigs[0]!.name).toBe('Test Config');
    });
  });

  describe('backendConfig.update', () => {
    it('updates a backend config and broadcasts backendConfig.updated + snapshot + listed', async () => {
      await h.send(client, {
        type: 'backendConfig.create',
        data: { name: 'Original', description: '', backendProvider: 'openai', generationMode: 'chat', model: 'gpt-3', instructTemplate: '', providerParams: {} },
      } as ClientMessage);

      const created = h.expectBroadcast('backendConfig.created');
      const backendConfigId = created.backendConfig.id;

      await h.send(client, {
        type: 'backendConfig.update',
        backendConfigId,
        patch: { name: 'Updated', model: 'gpt-4' },
      } as ClientMessage);

      const updated = h.expectBroadcast('backendConfig.updated');
      expect(updated.backendConfig.name).toBe('Updated');
      expect(updated.backendConfig.model).toBe('gpt-4');

      const snapshot = h.expectBroadcast('backendConfig.snapshot');
      expect(snapshot.backendConfig.name).toBe('Updated');

      const listed = h.expectBroadcast('backendConfig.listed');
      expect(listed.backendConfigs[0]!.name).toBe('Updated');
    });
  });

  describe('backendConfig.delete', () => {
    it('deletes a backend config and broadcasts backendConfig.deleted + listed', async () => {
      // Need two backend configs because you cannot delete the last one
      await h.send(client, {
        type: 'backendConfig.create',
        data: { name: 'Config A', description: '', backendProvider: 'openai', generationMode: 'chat', model: 'gpt-3', instructTemplate: '', providerParams: {} },
      } as ClientMessage);
      h.expectBroadcast('backendConfig.created');

      await h.send(client, {
        type: 'backendConfig.create',
        data: { name: 'Config B', description: '', backendProvider: 'openai', generationMode: 'chat', model: 'gpt-4', instructTemplate: '', providerParams: {} },
      } as ClientMessage);
      const createdB = h.expectBroadcast('backendConfig.created');
      const backendConfigIdB = createdB.backendConfig.id;

      await h.send(client, {
        type: 'backendConfig.delete',
        backendConfigId: backendConfigIdB,
      } as ClientMessage);

      const deleted = h.expectBroadcast('backendConfig.deleted');
      expect(deleted.backendConfigId).toBe(backendConfigIdB);

      const listed = h.expectBroadcast('backendConfig.listed');
      expect(listed.backendConfigs).toHaveLength(1);
      expect(listed.backendConfigs[0]!.name).toBe('Config A');
    });

    it('falls back to another backend config when deleting the active one', async () => {
      await h.send(client, {
        type: 'backendConfig.create',
        data: { name: 'Config A', description: '', backendProvider: 'openai', generationMode: 'chat', model: 'gpt-3', instructTemplate: '', providerParams: {} },
      } as ClientMessage);
      const createdA = h.expectBroadcast('backendConfig.created');

      await h.send(client, {
        type: 'backendConfig.create',
        data: { name: 'Config B', description: '', backendProvider: 'openai', generationMode: 'chat', model: 'gpt-4', instructTemplate: '', providerParams: {} },
      } as ClientMessage);
      const createdB = h.expectBroadcast('backendConfig.created');

      // Activate Config A via settings
      await h.send(client, {
        type: 'settings.set',
        key: 'activeBackendConfigId',
        value: createdA.backendConfig.id,
      } as ClientMessage);
      h.expectBroadcast('settings.changed');

      // Delete Config A — should fall back to Config B
      await h.send(client, {
        type: 'backendConfig.delete',
        backendConfigId: createdA.backendConfig.id,
      } as ClientMessage);

      h.expectBroadcast('backendConfig.deleted');
      const settingsChanged = h.expectBroadcast('settings.changed');
      expect(settingsChanged.key).toBe('activeBackendConfigId');
      expect(settingsChanged.value).toBe(createdB.backendConfig.id);
    });

    it('rejects deleting the last backend config', async () => {
      await h.send(client, {
        type: 'backendConfig.create',
        data: { name: 'Only Config', description: '', backendProvider: 'openai', generationMode: 'chat', model: 'gpt-3', instructTemplate: '', providerParams: {} },
      } as ClientMessage);
      const created = h.expectBroadcast('backendConfig.created');

      await h.send(client, {
        type: 'backendConfig.delete',
        backendConfigId: created.backendConfig.id,
      } as ClientMessage);

      const error = h.expectBroadcast('error');
      expect(error.code).toBe('LAST_BACKEND_CONFIG');
    });
  });

  describe('backendConfig.select', () => {
    it('returns backendConfig.snapshot for the selected backend config', async () => {
      await h.send(client, {
        type: 'backendConfig.create',
        data: { name: 'My Config', description: '', backendProvider: 'openai', generationMode: 'chat', model: 'gpt-4', instructTemplate: '', providerParams: {} },
      } as ClientMessage);
      const created = h.expectBroadcast('backendConfig.created');

      await h.send(client, {
        type: 'backendConfig.select',
        backendConfigId: created.backendConfig.id,
      } as ClientMessage);

      const snapshot = h.expectBroadcast('backendConfig.snapshot');
      expect(snapshot.backendConfig.id).toBe(created.backendConfig.id);
      expect(snapshot.backendConfig.name).toBe('My Config');
    });

    it('returns error for missing backend config', async () => {
      await h.send(client, {
        type: 'backendConfig.select',
        backendConfigId: 'non-existent-id',
      } as ClientMessage);

      const error = h.expectBroadcast('error');
      expect(error.code).toBe('NOT_FOUND');
    });
  });

  // ---------- Persona CRUD ----------

  describe('persona.create', () => {
    it('creates a persona and broadcasts persona.created + snapshot + listed', async () => {
      await h.send(client, {
        type: 'persona.create',
        data: { name: 'Tester', description: 'A test user.' },
      } as ClientMessage);

      const created = h.expectBroadcast('persona.created');
      expect(created.persona.name).toBe('Tester');
      expect(created.persona.description).toBe('A test user.');

      const snapshot = h.expectBroadcast('persona.snapshot');
      expect(snapshot.persona.id).toBe(created.persona.id);

      const listed = h.expectBroadcast('persona.listed');
      expect(listed.personas).toHaveLength(1);
      expect(listed.personas[0]!.name).toBe('Tester');
    });
  });

  describe('persona.update', () => {
    it('updates a persona and broadcasts persona.updated + snapshot + listed', async () => {
      await h.send(client, {
        type: 'persona.create',
        data: { name: 'Tester', description: 'Original desc.' },
      } as ClientMessage);

      const created = h.expectBroadcast('persona.created');
      const personaId = created.persona.id;

      await h.send(client, {
        type: 'persona.update',
        personaId,
        patch: { description: 'Updated desc.' },
      } as ClientMessage);

      const updated = h.expectBroadcast('persona.updated');
      expect(updated.persona.description).toBe('Updated desc.');

      const snapshot = h.expectBroadcast('persona.snapshot');
      expect(snapshot.persona.description).toBe('Updated desc.');

      const listed = h.expectBroadcast('persona.listed');
      expect(listed.personas[0]!.description).toBe('Updated desc.');
    });
  });

  describe('persona.delete', () => {
    it('deletes a persona and broadcasts persona.deleted + listed', async () => {
      // Need two personas because you cannot delete the last one
      await h.send(client, {
        type: 'persona.create',
        data: { name: 'Persona A', description: 'First' },
      } as ClientMessage);
      h.expectBroadcast('persona.created');

      await h.send(client, {
        type: 'persona.create',
        data: { name: 'Persona B', description: 'Second' },
      } as ClientMessage);
      const createdB = h.expectBroadcast('persona.created');
      const personaIdB = createdB.persona.id;

      await h.send(client, {
        type: 'persona.delete',
        personaId: personaIdB,
      } as ClientMessage);

      const deleted = h.expectBroadcast('persona.deleted');
      expect(deleted.personaId).toBe(personaIdB);

      const listed = h.expectBroadcast('persona.listed');
      expect(listed.personas).toHaveLength(1);
      expect(listed.personas[0]!.name).toBe('Persona A');
    });

    it('cascades to chats and reassigns fallback persona', async () => {
      // Create two personas
      await h.send(client, {
        type: 'persona.create',
        data: { name: 'Persona A', description: 'First' },
      } as ClientMessage);
      const personaA = h.expectBroadcast('persona.created');

      await h.send(client, {
        type: 'persona.create',
        data: { name: 'Persona B', description: 'Second' },
      } as ClientMessage);
      const personaB = h.expectBroadcast('persona.created');

      // Create a character
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Seraphina', description: 'A helpful AI.' },
      } as ClientMessage);
      const char = h.expectBroadcast('character.created');

      // Create a chat linked to Persona A
      await h.send(client, {
        type: 'chat.create',
        data: {
          characterId: char.character.id,
          personaId: personaA.persona.id,
          name: 'Test Chat',
        },
      } as ClientMessage);
      const chat = h.expectBroadcast('chat.created');
      const chatId = chat.chat.id;

      // Delete Persona A
      await h.send(client, {
        type: 'persona.delete',
        personaId: personaA.persona.id,
      } as ClientMessage);

      h.expectBroadcast('persona.deleted');
      const chatUpdated = h.expectBroadcast('chat.updated');
      expect(chatUpdated.chat.id).toBe(chatId);
      expect(chatUpdated.chat.personaId).toBe(personaB.persona.id);

      // Verify DB
      const chatAfter = await h.deps.chats.getChatById(chatId);
      expect(chatAfter?.personaId).toBe(personaB.persona.id);
    });

    it('rejects deleting the last persona', async () => {
      await h.send(client, {
        type: 'persona.create',
        data: { name: 'Only Persona', description: 'Only one.' },
      } as ClientMessage);
      const created = h.expectBroadcast('persona.created');

      await h.send(client, {
        type: 'persona.delete',
        personaId: created.persona.id,
      } as ClientMessage);

      const error = h.expectBroadcast('error');
      expect(error.code).toBe('FORBIDDEN');
    });
  });

  // ---------- World Info Entry CRUD ----------

  describe('worldinfo.entry.create/update/delete', () => {
    it('creates, updates, and deletes a world info entry', async () => {
      // Create a world info book first
      await h.send(client, {
        type: 'worldinfo.create',
        data: {
          name: 'Test Book',
          entries: [],
        },
      } as ClientMessage);
      const book = h.expectBroadcast('worldinfo.created');
      const bookId = book.book.id;

      // Create an entry
      await h.send(client, {
        type: 'worldinfo.entry.create',
        bookId,
        data: {
          keys: ['magic'],
          content: 'Magic is real.',
          comment: '',
          position: 'before_char',
          role: 'system',
          order: 100,
          probability: 100,
          constant: false,
          recursive: false,
          selective: false,
          secondaryKeys: [],
          addMemo: false,
          regex: false,
          disable: false,
          retrievalMode: 'keyword',
          depth: 0,
        },
      } as ClientMessage);

      const updatedAfterCreate = h.expectBroadcast('worldinfo.updated');
      expect(updatedAfterCreate.book.entries.length).toBe(1);
      expect(updatedAfterCreate.book.entries[0]!.content).toBe('Magic is real.');
      const entryId = updatedAfterCreate.book.entries[0]!.id;

      // Update the entry
      await h.send(client, {
        type: 'worldinfo.entry.update',
        bookId,
        entryId,
        patch: { content: 'Magic is very real.' },
      } as ClientMessage);

      const updatedAfterPatch = h.expectBroadcast('worldinfo.updated');
      expect(updatedAfterPatch.book.entries[0]!.content).toBe('Magic is very real.');

      // Delete the entry
      await h.send(client, {
        type: 'worldinfo.entry.delete',
        bookId,
        entryId,
      } as ClientMessage);

      const updatedAfterDelete = h.expectBroadcast('worldinfo.updated');
      expect(updatedAfterDelete.book.entries).toHaveLength(0);
    });
  });

  // ---------- Character delete ----------

  describe('character.delete', () => {
    it('deletes a character and broadcasts character.deleted + listed', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'ToDelete', description: 'Will be deleted.' },
      } as ClientMessage);
      const created = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'character.delete',
        characterId: created.character.id,
      } as ClientMessage);

      const deleted = h.expectBroadcast('character.deleted');
      expect(deleted.characterId).toBe(created.character.id);

      const listed = h.expectBroadcast('character.listed');
      expect(listed.characters).toHaveLength(0);

      // Verify DB
      const char = await h.deps.characters.getById(created.character.id);
      expect(char).toBeUndefined();
    });
  });
});
