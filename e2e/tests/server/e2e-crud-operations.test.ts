import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import type { ClientMessage } from '@tamari/types';

describe('e2e CRUD operations via bus', () => {
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

  describe('characters', () => {
    it('creates, updates, and deletes a character', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Alice', description: 'A curious girl.', firstMes: 'Hello!' },
      } as ClientMessage);
      const created = h.expectBroadcast('character.created');
      expect(created.character.name).toBe('Alice');

      const listed = h.expectBroadcast('character.listed');
      expect(listed.characters.some((c: any) => c.id === created.character.id)).toBe(true);

      await h.send(client, {
        type: 'character.update',
        characterId: created.character.id,
        patch: { name: 'Alice Updated' },
      } as ClientMessage);
      const updated = h.expectBroadcast('character.updated');
      expect(updated.character.name).toBe('Alice Updated');

      await h.send(client, {
        type: 'character.delete',
        characterId: created.character.id,
      } as ClientMessage);
      const deleted = h.expectBroadcast('character.deleted');
      expect(deleted.characterId).toBe(created.character.id);

      const listedAfter = h.expectBroadcast('character.listed');
      expect(listedAfter.characters.some((c: any) => c.id === created.character.id)).toBe(false);
    });

    it('selects a character and receives a snapshot', async () => {
      await h.send(client, {
        type: 'character.create',
        data: { name: 'Selectable', description: 'A selectable character.', firstMes: 'Hi!' },
      } as ClientMessage);
      const created = h.expectBroadcast('character.created');

      await h.send(client, {
        type: 'character.select',
        characterId: created.character.id,
      } as ClientMessage);
      const snapshot = h.expectBroadcast('character.snapshot');
      expect(snapshot.character.id).toBe(created.character.id);
    });
  });

  describe('personas', () => {
    it('creates, updates, and deletes a persona', async () => {
      // Create a second persona so deletion of the first doesn't violate "last persona" rule
      await h.send(client, {
        type: 'persona.create',
        data: { name: 'Keep', description: 'Keep this persona.' },
      } as ClientMessage);
      h.expectBroadcast('persona.created');
      h.expectBroadcast('persona.listed');

      await h.send(client, {
        type: 'persona.create',
        data: { name: 'User', description: 'Default user persona.' },
      } as ClientMessage);
      const created = h.expectBroadcast('persona.created');
      expect(created.persona.name).toBe('User');

      const listed = h.expectBroadcast('persona.listed');
      expect(listed.personas.some((p: any) => p.id === created.persona.id)).toBe(true);

      await h.send(client, {
        type: 'persona.update',
        personaId: created.persona.id,
        patch: { name: 'User Updated' },
      } as ClientMessage);
      const updated = h.expectBroadcast('persona.updated');
      expect(updated.persona.name).toBe('User Updated');

      await h.send(client, {
        type: 'persona.delete',
        personaId: created.persona.id,
      } as ClientMessage);
      const deleted = h.expectBroadcast('persona.deleted');
      expect(deleted.personaId).toBe(created.persona.id);

      const listedAfter = h.expectBroadcast('persona.listed');
      expect(listedAfter.personas.some((p: any) => p.id === created.persona.id)).toBe(false);
    });

    it('selects a persona and receives a snapshot', async () => {
      await h.send(client, {
        type: 'persona.create',
        data: { name: 'Selectable', description: 'A selectable persona.' },
      } as ClientMessage);
      const created = h.expectBroadcast('persona.created');

      await h.send(client, {
        type: 'persona.select',
        personaId: created.persona.id,
      } as ClientMessage);
      const snapshot = h.expectBroadcast('persona.snapshot');
      expect(snapshot.persona.id).toBe(created.persona.id);
    });
  });

  describe('backend configs', () => {
    it('creates, updates, and deletes a backend config', async () => {
      // Create a second config so deletion doesn't violate "last config" rule
      await h.send(client, {
        type: 'backendConfig.create',
        data: {
          name: 'Keep Config',
          description: '',
          backendProvider: 'openai',
          generationMode: 'chat',
          model: 'gpt-4',
          apiKey: 'keep-key',
          contextLength: 4096,
          maxTokens: 100,
          instructTemplate: '',
          providerParams: {},
        },
      } as ClientMessage);
      h.expectBroadcast('backendConfig.created');
      h.expectBroadcast('backendConfig.listed');

      await h.send(client, {
        type: 'backendConfig.create',
        data: {
          name: 'Test Config',
          description: '',
          backendProvider: 'openai',
          generationMode: 'chat',
          model: 'gpt-4',
          apiKey: 'test-key',
          contextLength: 4096,
          maxTokens: 100,
          instructTemplate: '',
          providerParams: {},
        },
      } as ClientMessage);
      const created = h.expectBroadcast('backendConfig.created');
      expect(created.backendConfig.name).toBe('Test Config');

      const listed = h.expectBroadcast('backendConfig.listed');
      expect(listed.backendConfigs.some((b: any) => b.id === created.backendConfig.id)).toBe(true);

      await h.send(client, {
        type: 'backendConfig.update',
        backendConfigId: created.backendConfig.id,
        patch: { name: 'Test Config Updated' },
      } as ClientMessage);
      const updated = h.expectBroadcast('backendConfig.updated');
      expect(updated.backendConfig.name).toBe('Test Config Updated');

      await h.send(client, {
        type: 'backendConfig.delete',
        backendConfigId: created.backendConfig.id,
      } as ClientMessage);
      const deleted = h.expectBroadcast('backendConfig.deleted');
      expect(deleted.backendConfigId).toBe(created.backendConfig.id);

      const listedAfter = h.expectBroadcast('backendConfig.listed');
      expect(listedAfter.backendConfigs.some((b: any) => b.id === created.backendConfig.id)).toBe(false);
    });

    it('selects and lists backend configs', async () => {
      await h.send(client, {
        type: 'backendConfig.create',
        data: {
          name: 'Selectable Config',
          description: '',
          backendProvider: 'openai',
          generationMode: 'chat',
          model: 'gpt-4',
          apiKey: 'key',
          contextLength: 4096,
          maxTokens: 100,
          instructTemplate: '',
          providerParams: {},
        },
      } as ClientMessage);
      const created = h.expectBroadcast('backendConfig.created');
      h.expectBroadcast('backendConfig.listed');

      await h.send(client, {
        type: 'backendConfig.select',
        backendConfigId: created.backendConfig.id,
      } as ClientMessage);
      const snapshot = h.expectBroadcast('backendConfig.snapshot');
      expect(snapshot.backendConfig.id).toBe(created.backendConfig.id);

      await h.send(client, {
        type: 'backendConfig.list',
      } as ClientMessage);
      const listed = h.expectBroadcast('backendConfig.listed');
      expect(listed.backendConfigs.some((b: any) => b.id === created.backendConfig.id)).toBe(true);
    });
  });

  describe('prompt lists', () => {
    it('creates, updates, and deletes a prompt list', async () => {
      // Create a second list so deletion doesn't violate "last list" rule
      await h.send(client, {
        type: 'promptList.create',
        data: {
          name: 'Keep List',
          description: 'Keep this list.',
          prompts: [],
          promptOrder: [],
        },
      } as ClientMessage);
      h.expectBroadcast('promptList.created');
      h.expectBroadcast('promptList.listed');

      await h.send(client, {
        type: 'promptList.create',
        data: {
          name: 'Test List',
          description: 'A test prompt list.',
          prompts: [{ identifier: 'main', content: 'Hello!', enabled: true, marker: false }],
          promptOrder: [{ identifier: 'main', enabled: true }],
        },
      } as ClientMessage);
      const created = h.expectBroadcast('promptList.created');
      expect(created.promptList.name).toBe('Test List');

      const listed = h.expectBroadcast('promptList.listed');
      expect(listed.promptLists.some((p: any) => p.id === created.promptList.id)).toBe(true);

      await h.send(client, {
        type: 'promptList.update',
        promptListId: created.promptList.id,
        patch: { name: 'Test List Updated' },
      } as ClientMessage);
      const updated = h.expectBroadcast('promptList.updated');
      expect(updated.promptList.name).toBe('Test List Updated');

      await h.send(client, {
        type: 'promptList.delete',
        promptListId: created.promptList.id,
      } as ClientMessage);
      const deleted = h.expectBroadcast('promptList.deleted');
      expect(deleted.promptListId).toBe(created.promptList.id);

      const listedAfter = h.expectBroadcast('promptList.listed');
      expect(listedAfter.promptLists.some((p: any) => p.id === created.promptList.id)).toBe(false);
    });

    it('selects and lists prompt lists', async () => {
      await h.send(client, {
        type: 'promptList.create',
        data: {
          name: 'Selectable List',
          description: 'A list to select.',
          prompts: [],
          promptOrder: [],
        },
      } as ClientMessage);
      const created = h.expectBroadcast('promptList.created');
      h.expectBroadcast('promptList.listed');

      await h.send(client, {
        type: 'promptList.select',
        promptListId: created.promptList.id,
      } as ClientMessage);
      const snapshot = h.expectBroadcast('promptList.snapshot');
      expect(snapshot.promptList.id).toBe(created.promptList.id);

      await h.send(client, {
        type: 'promptList.list',
      } as ClientMessage);
      const listed = h.expectBroadcast('promptList.listed');
      expect(listed.promptLists.some((p: any) => p.id === created.promptList.id)).toBe(true);
    });
  });

  describe('world info', () => {
    it('creates, updates, and deletes a world info book with entries', async () => {
      await h.send(client, {
        type: 'worldinfo.create',
        data: { name: 'Lorebook' },
      } as ClientMessage);
      const created = h.expectBroadcast('worldinfo.created');
      expect(created.book.name).toBe('Lorebook');

      const listed = h.expectBroadcast('worldinfo.listed');
      expect(listed.books.some((b: any) => b.id === created.book.id)).toBe(true);

      // Add entry
      await h.send(client, {
        type: 'worldinfo.entry.create',
        bookId: created.book.id,
        data: {
          keys: ['magic'],
          content: 'Magic is real.',
          comment: '',
          position: 'before_char',
          order: 0,
          probability: 100,
          constant: false,
          selective: false,
          secondaryKeys: [],
          addMemo: false,
          disable: false,
          regex: false,
          recursive: false,
          depth: 0,
          role: 'system',
          retrievalMode: 'keyword',
        },
      } as ClientMessage);
      const entryCreated = h.expectBroadcast('worldinfo.updated');
      expect(entryCreated.book.entries.length).toBe(1);

      // Update entry
      const entryId = entryCreated.book.entries[0]!.id;
      await h.send(client, {
        type: 'worldinfo.entry.update',
        bookId: created.book.id,
        entryId,
        patch: { content: 'Magic is very real.' },
      } as ClientMessage);
      const entryUpdated = h.expectBroadcast('worldinfo.updated');
      expect(entryUpdated.book.entries[0]!.content).toBe('Magic is very real.');

      // Delete entry
      await h.send(client, {
        type: 'worldinfo.entry.delete',
        bookId: created.book.id,
        entryId,
      } as ClientMessage);
      const entryDeleted = h.expectBroadcast('worldinfo.updated');
      expect(entryDeleted.book.entries.length).toBe(0);

      // Delete book
      await h.send(client, {
        type: 'worldinfo.delete',
        bookId: created.book.id,
      } as ClientMessage);
      const deleted = h.expectBroadcast('worldinfo.deleted');
      expect(deleted.bookId).toBe(created.book.id);

      const listedAfter = h.expectBroadcast('worldinfo.listed');
      expect(listedAfter.books.some((b: any) => b.id === created.book.id)).toBe(false);
    });

    it('selects, lists, and tests a world info book', async () => {
      await h.send(client, {
        type: 'worldinfo.create',
        data: { name: 'Testable Lorebook' },
      } as ClientMessage);
      const created = h.expectBroadcast('worldinfo.created');
      h.expectBroadcast('worldinfo.listed');

      await h.send(client, {
        type: 'worldinfo.select',
        bookId: created.book.id,
      } as ClientMessage);
      const snapshot = h.expectBroadcast('worldinfo.snapshot');
      expect(snapshot.book.id).toBe(created.book.id);

      await h.send(client, {
        type: 'worldinfo.list',
      } as ClientMessage);
      const listed = h.expectBroadcast('worldinfo.listed');
      expect(listed.books.some((b: any) => b.id === created.book.id)).toBe(true);

      await h.send(client, {
        type: 'worldinfo.test',
        entries: [
          {
            id: 'test-entry-1',
            keys: ['magic'],
            content: 'Magic is real.',
            comment: '',
            position: 'before_char',
            order: 0,
            probability: 100,
            constant: false,
            selective: false,
            secondaryKeys: [],
            addMemo: false,
            disable: false,
            regex: false,
            recursive: false,
            depth: 0,
            role: 'system',
            retrievalMode: 'keyword',
          },
        ],
        text: 'I cast a magic spell.',
      } as unknown as ClientMessage);
      const tested = h.expectBroadcast('worldinfo.tested');
      expect(tested.activated.length).toBe(1);
      expect(tested.activated[0]!.entry.content).toBe('Magic is real.');
    });
  });

  describe('quick replies', () => {
    it('creates, updates, executes, and deletes a quick reply', async () => {
      await h.send(client, {
        type: 'quickreply.create',
        data: {
          scope: 'global',
          scopeId: '',
          label: 'Greet',
          script: 'st.toast("Hello!", "info")',
          language: 'lua',
          color: '#4f46e5',
          icon: '',
          autoExecute: 0,
        },
      } as ClientMessage);
      const created = h.expectBroadcast('quickreply.created');
      expect(created.item.label).toBe('Greet');

      await h.send(client, {
        type: 'quickreply.list',
        scope: 'global',
        scopeId: '',
      } as ClientMessage);
      const listed = h.expectBroadcast('quickreply.listed');
      expect(listed.items.some((qr: any) => qr.id === created.item.id)).toBe(true);

      await h.send(client, {
        type: 'quickreply.update',
        id: created.item.id,
        patch: { label: 'Greet Updated' },
      } as ClientMessage);
      const updated = h.expectBroadcast('quickreply.updated');
      expect(updated.item.label).toBe('Greet Updated');

      // Execute
      await h.send(client, {
        type: 'quickreply.execute',
        id: created.item.id,
        chatId: 'dummy',
      } as ClientMessage);
      const scriptToast = client.messages.find((m: any) => m.type === 'script.toast');
      expect(scriptToast).toBeDefined();
      expect((scriptToast as any).message).toBe('Hello!');

      await h.send(client, {
        type: 'quickreply.delete',
        id: created.item.id,
      } as ClientMessage);
      const deleted = h.expectBroadcast('quickreply.deleted');
      expect(deleted.id).toBe(created.item.id);

      // Explicitly list to verify deletion
      await h.send(client, {
        type: 'quickreply.list',
        scope: 'global',
        scopeId: '',
      } as ClientMessage);
      const listedAfter = h.expectBroadcast('quickreply.listed');
      expect(listedAfter.items.some((qr: any) => qr.id === created.item.id)).toBe(false);
    });
  });

  describe('toolsets and templates', () => {
    it('creates, updates, and deletes a toolset', async () => {
      // First create a template
      await h.send(client, {
        type: 'toolTemplate.create',
        data: { name: 'Test Template', code: 'return {}', configSchema: {} },
      } as ClientMessage);
      const tmpl = h.expectBroadcast('toolTemplate.created');

      await h.send(client, {
        type: 'toolset.create',
        data: { templateId: tmpl.toolTemplate.id, name: 'Test Toolset', config: {}, toolOverrides: {}, enabled: true },
      } as ClientMessage);
      const created = h.expectBroadcast('toolset.created');
      expect(created.toolset.name).toBe('Test Toolset');

      const listed = h.expectBroadcast('toolset.listed');
      expect(listed.toolsets.some((t: any) => t.id === created.toolset.id)).toBe(true);

      await h.send(client, {
        type: 'toolset.update',
        toolsetId: created.toolset.id,
        patch: { name: 'Updated Toolset' },
      } as ClientMessage);
      const updated = h.expectBroadcast('toolset.updated');
      expect(updated.toolset.name).toBe('Updated Toolset');

      await h.send(client, {
        type: 'toolset.delete',
        toolsetId: created.toolset.id,
      } as ClientMessage);
      const deleted = h.expectBroadcast('toolset.deleted');
      expect(deleted.toolsetId).toBe(created.toolset.id);

      const listedAfter = h.expectBroadcast('toolset.listed');
      expect(listedAfter.toolsets.some((t: any) => t.id === created.toolset.id)).toBe(false);
    });

    it('creates, updates, and deletes a Lua tool template', async () => {
      await h.send(client, {
        type: 'toolTemplate.create',
        data: { name: 'Lua Template', code: 'Tool = {}\nreturn Tool', configSchema: {} },
      } as ClientMessage);
      const created = h.expectBroadcast('toolTemplate.created');
      expect(created.toolTemplate.name).toBe('Lua Template');

      const listed = h.expectBroadcast('toolTemplate.listed');
      expect(listed.toolTemplates.some((t: any) => t.id === created.toolTemplate.id)).toBe(true);

      await h.send(client, {
        type: 'toolTemplate.update',
        toolTemplateId: created.toolTemplate.id,
        patch: { name: 'Updated Lua Template' },
      } as ClientMessage);
      const updated = h.expectBroadcast('toolTemplate.updated');
      expect(updated.toolTemplate.name).toBe('Updated Lua Template');

      await h.send(client, {
        type: 'toolTemplate.delete',
        toolTemplateId: created.toolTemplate.id,
      } as ClientMessage);
      const deleted = h.expectBroadcast('toolTemplate.deleted');
      expect(deleted.toolTemplateId).toBe(created.toolTemplate.id);

      const listedAfter = h.expectBroadcast('toolTemplate.listed');
      expect(listedAfter.toolTemplates.some((t: any) => t.id === created.toolTemplate.id)).toBe(false);
    });
  });
});
