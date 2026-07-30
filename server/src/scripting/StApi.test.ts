import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { ScriptContext } from './ScriptContext.js';
import { createStApi, createToolStApi, TOOL_ST_WHITELIST, type StApiDeps } from './StApi.js';
import type { ScriptGenerationApi } from './ScriptGenerationApi.js';

class FakeLockable {
  tryLockChat() {
    return true;
  }
  unlockChat() {}
}

describe('StApi', () => {
  let h: TestHarness;
  let ctx: ScriptContext;
  let generationService: ScriptGenerationApi;
  let st: any;
  let toolSt: any;
  let deps: StApiDeps;
  let chatId: string;
  let characterId: string;
  let personaId: string;
  let backendConfigId: string;
  let worldInfoId: string;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();

    generationService = {
      heldLockFor: vi.fn((id: string) => ({ chatId: id })),
      handleSend: vi.fn(),
      handleContinue: vi.fn(),
      handleImpersonate: vi.fn(),
      handleRegenerate: vi.fn(),
      handleGenerate: vi.fn(),
      handleStop: vi.fn(),
      getActiveGeneration: vi.fn(),
    } as unknown as ScriptGenerationApi;

    characterId = crypto.randomUUID();
    worldInfoId = crypto.randomUUID();
    // Lorebook first — characters.world_info_id is FK-referenced under the
    // real (migration-applied) schema.
    await h.deps.worldInfo.create(worldInfoId, {
      name: 'Test Lorebook',
      entries: [
        {
          id: crypto.randomUUID(),
          keys: ['magic'],
          content: 'Magic exists.',
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
    });

    await h.deps.characters.create(characterId, {
      name: 'Test Character',
      description: 'A test character',
      personality: 'Friendly',
      scenario: 'Test scenario',
      firstMes: 'Hello!',
      systemPrompt: 'Be helpful.',
      tags: ['test'],
      worldInfoId,
    });

    personaId = crypto.randomUUID();
    await h.deps.personas.create(personaId, {
      name: 'Test Persona',
      description: 'A test persona',
    });

    backendConfigId = crypto.randomUUID();
    await h.deps.backendConfigs.create(backendConfigId, {
      name: 'Test Backend',
      description: '',
      backendProvider: 'openai',
      model: 'gpt-test',
      generationMode: 'chat',
      instructTemplate: '',
      providerParams: {},
      temperature: 0.7,
      maxTokens: 100,
      contextLength: 4096,
      apiUrl: 'http://localhost:5000',
      stopStrings: [],
    });

    chatId = crypto.randomUUID();
    await h.deps.chats.createChat(chatId, {
      characterId,
      personaId,
      name: 'Test Chat',
      headMessageId: null,
      metadata: {},
    });

    ctx = new ScriptContext(chatId, new FakeLockable());

    deps = {
      generationService,
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
    };

    st = createStApi(ctx, deps);
    toolSt = createToolStApi(ctx, deps);
  });

  afterEach(async () => {
    await h.teardown();
  });

  describe('chat actions', () => {
    it('send delegates to generationService', async () => {
      await st.send('Hello');
      expect(generationService.handleSend).toHaveBeenCalledWith(chatId, 'Hello', undefined, { chatId });
    });

    it('continue delegates to generationService', async () => {
      await st.continue();
      expect(generationService.handleContinue).toHaveBeenCalledWith(chatId, { chatId });
    });

    it('impersonate delegates to generationService', async () => {
      await st.impersonate();
      expect(generationService.handleImpersonate).toHaveBeenCalledWith(chatId, { chatId });
    });

    it('regenerate delegates to generationService', async () => {
      await st.regenerate();
      expect(generationService.handleRegenerate).toHaveBeenCalledWith(chatId, undefined, { chatId });
    });

    it('trigger delegates to generationService', async () => {
      await st.trigger();
      expect(generationService.handleGenerate).toHaveBeenCalledWith(chatId, { chatId }, client.connection.id);
    });

    it('stop delegates to generationService when active generation matches chat', async () => {
      vi.mocked(generationService.getActiveGeneration).mockReturnValue({ id: 'gen-1', chatId } as any);
      await st.stop();
      expect(generationService.handleStop).toHaveBeenCalledWith('gen-1');
    });

    it('stop does nothing when no active generation', async () => {
      vi.mocked(generationService.getActiveGeneration).mockReturnValue(undefined);
      await st.stop();
      expect(generationService.handleStop).not.toHaveBeenCalled();
    });

    it('edit updates a message text part', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'old' }] },
      });
      await st.edit(msg.id, 'new');
      const updated = await h.deps.chats.getMessageById(msg.id);
      expect(updated!.extra.parts).toEqual([{ type: 'text', text: 'new' }]);
    });

    it('delete removes a message', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'bye' }] },
      });
      await st.delete(msg.id);
      expect(await h.deps.chats.getMessageById(msg.id)).toBeUndefined();
    });

    it('hide and unhide toggle hidden flag', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'system',
        extra: { parts: [{ type: 'text', text: 'secret' }] },
      });
      await st.hide(msg.id);
      expect((await h.deps.chats.getMessageById(msg.id))!.extra.hidden).toBe(true);
      await st.unhide(msg.id);
      expect((await h.deps.chats.getMessageById(msg.id))!.extra.hidden).toBe(false);
    });

    it('reset_chat deletes all active branch messages', async () => {
      await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'hi' }] },
      });
      await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'hello' }] },
      });
      await st.reset_chat();
      expect(await h.deps.chats.getMessageCount(chatId)).toBe(0);
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat!.headMessageId).toBeNull();
      expect(chat!.activeChildId).toBeNull();
    });
  });

  describe('queries', () => {
    it('get_messages returns active branch messages', async () => {
      await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'one' }] },
      });
      const msgs = await st.get_messages(10);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.content).toBe('one');
    });

    it('get_chat returns chat summary', async () => {
      const chat = await st.get_chat();
      expect(chat).toMatchObject({ id: chatId, name: 'Test Chat', characterId });
    });

    it('get_characters lists characters', async () => {
      const chars = await st.get_characters();
      expect(chars).toHaveLength(1);
      expect(chars[0]!.name).toBe('Test Character');
    });

    it('find_character finds by name', async () => {
      const c = await st.find_character('Test Character');
      expect(c!.name).toBe('Test Character');
      expect(await st.find_character('Missing')).toBeNull();
    });

    it('get_character returns details', async () => {
      const c = await st.get_character(characterId);
      expect(c!.systemPrompt).toBe('Be helpful.');
    });

    it('get_personas and get_persona work', async () => {
      const list = await st.get_personas();
      expect(list).toHaveLength(1);
      const p = await st.get_persona(personaId);
      expect(p!.name).toBe('Test Persona');
    });

    it('set_persona updates chat persona', async () => {
      await st.set_persona(personaId);
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat!.personaId).toBe(personaId);
    });

    it('set_character updates chat character', async () => {
      const otherId = crypto.randomUUID();
      await h.deps.characters.create(otherId, {
        name: 'Other',
        description: '',
      });
      await st.set_character(otherId);
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat!.characterId).toBe(otherId);
    });

    it('get_character_id and get_persona_id return ids (deprecated aliases kept)', async () => {
      expect(await st.get_character_id()).toBe(characterId);
      expect(await st.get_persona_id()).toBe(personaId);
      // Deprecated camelCase aliases resolve to the same implementations.
      expect(st.get_characterId).toBe(st.get_character_id);
      expect(st.get_personaId).toBe(st.get_persona_id);
      expect(await st.get_characterId()).toBe(characterId);
      expect(await st.get_personaId()).toBe(personaId);
    });

    it('new_chat creates a chat from current chat', async () => {
      const id = await st.new_chat('Branch Chat');
      const chat = await h.deps.chats.getChatById(id);
      expect(chat!.name).toBe('Branch Chat');
      expect(chat!.characterId).toBe(characterId);
    });

    it('temp_chat creates an empty temporary chat', async () => {
      const id = await st.temp_chat('Temp');
      const chat = await h.deps.chats.getChatById(id);
      expect(chat!.name).toBe('Temp');
      expect(chat!.characterId).toBeNull();
    });

    it('branch and checkpoint create soft forks', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'fork me' }] },
      });
      const branchId = await st.branch(msg.id, 'Branched');
      expect((await h.deps.chats.getChatById(branchId))!.name).toBe('Branched');

      await h.deps.chats.updateChat(chatId, { headMessageId: msg.id, activeChildId: msg.id });
      const checkpointId = await st.checkpoint('Saved');
      expect((await h.deps.chats.getChatById(checkpointId))!.name).toBe('Saved');
    });

    it('hard_fork creates a hard fork', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'fork me' }] },
      });
      const forkId = await st.hard_fork(msg.id, 'Hard Fork');
      expect((await h.deps.chats.getChatById(forkId))!.name).toBe('Hard Fork');
    });

    it('author note set/get round-trips', async () => {
      await st.set_author_note('note!', { depth: 2, interval: 3, position: 'before_prompt', role: 'user' });
      const note = await st.get_author_note();
      expect(note).toMatchObject({ content: 'note!', depth: 2, interval: 3, position: 'before_prompt', role: 'user' });
    });

    it('set_author_note defaults position and role', async () => {
      await st.set_author_note('defaults');
      const note = await st.get_author_note();
      expect(note).toMatchObject({ position: 'in_chat', role: 'system' });
    });

    it('settings get/set/list work', async () => {
      await st.set_setting('myKey', 'myValue');
      expect(await st.get_setting('myKey')).toBe('myValue');
      const list = await st.get_settings();
      expect(list['myKey']).toBe('myValue');
    });

    it('backend configs get/list work', async () => {
      const list = await st.get_backend_configs();
      expect(list).toHaveLength(1);
      const cfg = await st.get_backend_config(backendConfigId);
      expect(cfg!.model).toBe('gpt-test');
    });

    it('set_backend_config activates config', async () => {
      await st.set_backend_config(backendConfigId);
      expect(await h.deps.settings.get('activeBackendConfigId')).toBe(backendConfigId);
    });

    it('system prompt set/get work (canonical and deprecated alias names)', async () => {
      await st.set_system_prompt(characterId, 'New prompt');
      expect(await st.get_system_prompt(characterId)).toBe('New prompt');
      // Deprecated camelCase aliases resolve to the same implementations.
      expect(st.set_systemPrompt).toBe(st.set_system_prompt);
      expect(st.get_systemPrompt).toBe(st.get_system_prompt);
      await st.set_systemPrompt(characterId, 'Alias prompt');
      expect(await st.get_systemPrompt(characterId)).toBe('Alias prompt');
    });

    it('model settings work', async () => {
      await st.set_model('new-model');
      expect(await st.get_model()).toBe('new-model');
      await st.set_backend_config(backendConfigId);
      expect(await st.get_model()).toBe('gpt-test');
    });

    it('apiUrl settings work', async () => {
      await st.set_apiUrl('http://example.com');
      expect(await st.get_apiUrl()).toBe('http://example.com');
    });

    it('temperature settings work (legacy fallback without active config)', async () => {
      await st.set_temperature(0.5);
      expect(await st.get_temperature()).toBe(0.5);
      expect(await h.deps.settings.get('temperature')).toBe(0.5);
    });

    it('temperature operates on the active backend config when one is set', async () => {
      await st.set_backend_config(backendConfigId);
      // Reads the config's temperature (0.7 from setup), not the settings key.
      expect(await st.get_temperature()).toBe(0.7);
      await st.set_temperature(0.9);
      expect(await st.get_temperature()).toBe(0.9);
      const cfg = await h.deps.backendConfigs.getById(backendConfigId);
      expect(cfg?.temperature).toBe(0.9);
      // The legacy settings key is never written when a config is active.
      expect(await h.deps.settings.get('temperature')).toBeUndefined();
    });

    it('maxTokens settings work', async () => {
      await st.set_maxTokens(256);
      expect(await st.get_maxTokens()).toBe(256);
    });

    it('contextLength settings work', async () => {
      await st.set_contextLength(8192);
      expect(await st.get_contextLength()).toBe(8192);
    });

    it('backend provider settings work', async () => {
      await st.set_backend('openrouter');
      expect(await st.get_backend()).toBe('openrouter');
    });

    it('reasoning set/get/clear work', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'hi' }] },
      });
      expect(await st.get_reasoning(msg.id)).toBeNull();
      await st.set_reasoning(msg.id, 'thinking...');
      expect(await st.get_reasoning(msg.id)).toBe('thinking...');
      await st.clear_reasoning(msg.id);
      expect(await st.get_reasoning(msg.id)).toBeNull();
    });

    it('get_generation_info returns metadata', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'hi' }], model: 'm', tokenCount: 5, generationTime: 1.2, api: 'a' },
      });
      const info = await st.get_generation_info(msg.id);
      // Storage keys are camelCase; the Lua-facing return keeps the historical
      // snake_case keys and adds camelCase duplicates alongside (additive).
      expect(info).toEqual({
        model: 'm',
        token_count: 5,
        tokenCount: 5,
        generation_time: 1.2,
        generationTime: 1.2,
        api: 'a',
      });
    });
  });

  describe('message queries', () => {
    it('get_message_by_id returns message', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'find me' }] },
      });
      const found = await st.get_message_by_id(msg.id);
      expect(found!.content).toBe('find me');
    });

    it('get_message_count and get_last_message work', async () => {
      await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'last' }] },
      });
      expect(await st.get_message_count()).toBe(1);
      const last = await st.get_last_message();
      expect(last!.content).toBe('last');
    });

    it('get_chat_name and get_character_name work (deprecated alias kept)', async () => {
      expect(await st.get_chat_name()).toBe('Test Chat');
      expect(await st.get_character_name()).toBe('Test Character');
      // Deprecated camelCase alias resolves to the same implementation.
      expect(st.get_characterName).toBe(st.get_character_name);
      expect(await st.get_characterName()).toBe('Test Character');
    });

    it('chat metadata set/get work', async () => {
      await st.set_chat_metadata('foo', 'bar');
      expect(await st.get_chat_metadata('foo')).toBe('bar');
    });

    it('get_chats lists chats optionally filtered by character', async () => {
      const list = await st.get_chats();
      expect(list).toHaveLength(1);
      const filtered = await st.get_chats(characterId);
      expect(filtered).toHaveLength(1);
      const other = crypto.randomUUID();
      expect((await st.get_chats(other))).toHaveLength(0);
    });

    it('get_message_at supports positive and negative indices', async () => {
      await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'first' }] },
      });
      await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'second' }] },
      });
      expect((await st.get_message_at(1))!.content).toBe('second');
      expect((await st.get_message_at(-1))!.content).toBe('second');
      expect(await st.get_message_at(99)).toBeNull();
    });

    it('get_message_index returns index or null', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'idx' }] },
      });
      expect(await st.get_message_index(msg.id)).toBe(0);
      expect(await st.get_message_index(99999)).toBeNull();
    });

    it('get_children returns child messages', async () => {
      const parent = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'parent' }] },
      });
      const child = await h.deps.chats.insertMessage({
        parentId: parent.id,
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'child' }] },
      });
      const children = await st.get_children(parent.id);
      expect(children).toHaveLength(1);
      expect(children[0]!.id).toBe(child.id);
    });

    it('get_message_chain walks parents', async () => {
      const a = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'a' }] },
      });
      const b = await h.deps.chats.insertMessage({
        parentId: a.id,
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'b' }] },
      });
      const chain = await st.get_message_chain(b.id);
      expect(chain).toHaveLength(2);
      expect(chain[0]!.content).toBe('a');
    });

    it('get_siblings returns siblings', async () => {
      const parent = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'parent' }] },
      });
      await h.deps.chats.insertMessage({
        parentId: parent.id,
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 's1' }] },
      });
      const s2 = await h.deps.chats.insertMessage({
        parentId: parent.id,
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 's2' }] },
      });
      const siblings = await st.get_siblings(s2.id);
      expect(siblings).toHaveLength(2);
    });

    it('repair_active_child repairs chat pointer', async () => {
      const parent = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'p' }] },
      });
      const child = await h.deps.chats.insertMessage({
        parentId: parent.id,
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'c' }] },
      });
      await h.deps.chats.updateChat(chatId, { headMessageId: parent.id, activeChildId: null });
      await st.repair_active_child();
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat!.activeChildId).toBe(child.id);
    });
  });

  describe('swipes', () => {
    it('add_swipe creates a sibling and optionally switches', async () => {
      const parent = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'parent' }] },
      });
      const active = await h.deps.chats.insertMessage({
        parentId: parent.id,
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'active' }] },
      });
      await h.deps.chats.updateChat(chatId, { headMessageId: parent.id, activeChildId: active.id });
      const swipeId = await st.add_swipe('swipe text', true);
      expect(typeof swipeId).toBe('number');
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat!.activeChildId).toBe(swipeId);
    });

    it('set_active_child switches active swipe', async () => {
      const parent = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'parent' }] },
      });
      const active = await h.deps.chats.insertMessage({
        parentId: parent.id,
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'active' }] },
      });
      await h.deps.chats.updateChat(chatId, { headMessageId: parent.id, activeChildId: active.id });
      const other = await h.deps.chats.insertMessage({
        parentId: parent.id,
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'other' }] },
      });
      await st.set_active_child(other.id);
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat!.activeChildId).toBe(other.id);
    });
  });

  describe('ui helpers', () => {
    it('send_as creates an assistant message from a character', async () => {
      const id = await st.send_as('Test Character', 'Sent as char');
      const msg = await h.deps.chats.getMessageById(id);
      expect(msg!.role).toBe('assistant');
      expect((msg!.extra as any).parts[0].text).toBe('Sent as char');
    });

    it('send_narrator creates a narrator message', async () => {
      const id = await st.send_narrator('Story', 'tale');
      const msg = await h.deps.chats.getMessageById(id);
      expect(msg!.role).toBe('system');
      expect((msg!.extra as any).type).toBe('narrator');
      expect((msg!.extra as any).parts[0].text).toBe('tale');
    });

    it('send_narrator with one argument uses content as the text', async () => {
      const id = await st.send_narrator('just a tale');
      const msg = await h.deps.chats.getMessageById(id);
      expect(msg!.role).toBe('system');
      expect((msg!.extra as any).type).toBe('narrator');
      expect((msg!.extra as any).parts[0].text).toBe('just a tale');
    });

    it('send_narrator materializes the greeting before appending to an unmaterialized chat', async () => {
      await st.send_narrator('tale');
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat!.materialized).toBe(true);
      const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
      expect(branch.map((m) => (m.extra as any).parts[0].text)).toEqual(['Hello!', 'tale']);
    });

    it('send_as materializes the greeting before appending to an unmaterialized chat', async () => {
      await st.send_as('Test Character', 'impersonated');
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat!.materialized).toBe(true);
      const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
      expect(branch.map((m) => (m.extra as any).parts[0].text)).toEqual(['Hello!', 'impersonated']);
    });

    it('comment materializes the greeting before appending to an unmaterialized chat', async () => {
      await st.comment('note');
      const chat = await h.deps.chats.getChatById(chatId);
      expect(chat!.materialized).toBe(true);
      const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
      expect(branch.map((m) => (m.extra as any).parts[0].text)).toEqual(['Hello!', 'note']);
    });

    it('comment creates a hidden system message', async () => {
      const id = await st.comment('note');
      const msg = await h.deps.chats.getMessageById(id);
      expect(msg!.role).toBe('system');
      expect(msg!.extra.type).toBe('comment');
      expect(msg!.extra.hidden).toBe(true);
    });

    it('set_message_role updates role', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'x' }] },
      });
      await st.set_message_role(msg.id, 'user');
      expect((await h.deps.chats.getMessageById(msg.id))!.role).toBe('user');
    });

    it('rename_chat updates name', async () => {
      await st.rename_chat('Renamed');
      expect(await st.get_chat_name()).toBe('Renamed');
    });

    it('delete_chat deletes current chat', async () => {
      await st.delete_chat();
      expect(await h.deps.chats.getChatById(chatId)).toBeUndefined();
    });

    it('toast sends direct message to client', async () => {
      st.toast('hello', 'success');
      const toast = client.messages.find((m: any) => m.type === 'script.toast');
      expect(toast).toMatchObject({ message: 'hello', level: 'success' });
    });

    it('delay waits', async () => {
      const start = Date.now();
      await st.delay(10);
      expect(Date.now() - start).toBeGreaterThanOrEqual(5);
    });
  });

  describe('variables', () => {
    it('setvar/getvar round-trip per chat', async () => {
      await st.setvar('x', 1);
      expect(await st.getvar('x')).toBe(1);
    });

    it('clear_variables and get_variables work', async () => {
      await st.setvar('a', 'A');
      await st.setvar('b', 'B');
      expect(await st.get_variables()).toEqual({ a: 'A', b: 'B' });
      await st.clear_variables();
      expect(await st.get_variables()).toEqual({});
      expect(await st.getvar('a')).toBeUndefined();
    });
  });

  describe('world info', () => {
    it('wi_list returns entries', async () => {
      const entries = await st.wi_list();
      expect(entries).toHaveLength(1);
    });

    it('wi_get finds entry by key', async () => {
      const entry = await st.wi_get('magic');
      expect(entry!.content).toBe('Magic exists.');
      expect(await st.wi_get('missing')).toBeNull();
    });

    it('wi_add and wi_remove manage entries', async () => {
      await st.wi_add('spell,incantation', 'A spell is cast.');
      let entries = await st.wi_list();
      expect(entries).toHaveLength(2);
      await st.wi_remove('spell');
      entries = await st.wi_list();
      expect(entries).toHaveLength(1);
    });
  });

  describe('utilities', () => {
    it('token functions return counts', async () => {
      expect(st.token_count('hello')).toBeGreaterThanOrEqual(0);
      expect(st.count_tokens('hello')).toBeGreaterThanOrEqual(0);
      expect(st.trim_tokens('hello world', 1).length).toBeLessThanOrEqual(11);
    });

    it('string case helpers work', () => {
      expect(st.upper('abc')).toBe('ABC');
      expect(st.lower('ABC')).toBe('abc');
    });

    it('replace helpers work', () => {
      expect(st.replace('a b a', 'a', 'x')).toBe('x b x');
      expect(st.replace_regex('a b a', 'a', 'x')).toBe('x b x');
      expect(st.match('abc123', '\\d+')).toEqual(['123']);
      expect(st.test('abc', '^a')).toBe(true);
      expect(st.substring('hello', 1, 3)).toBe('el');
    });

    it('trim helpers work', () => {
      expect(st.trim_start('Hello world. More')).toBe('Hello world.');
      expect(st.trim_end('Hello world. More')).toBe(' More');
    });

    it('random and now return numbers', () => {
      const r = st.random(1, 10);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(10);
      expect(typeof st.now()).toBe('number');
    });

    it('message extra set/get work', async () => {
      const msg = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'x' }] },
      });
      await st.set_message_extra(msg.id, 'key', 'value');
      expect(await st.get_message_extra(msg.id, 'key')).toBe('value');
      expect(await st.get_message_extra(msg.id, 'missing')).toBeNull();
    });

    it('array helpers work', () => {
      expect(st.array_wrap(1)).toEqual([1]);
      expect(st.array_unwrap([1, 2])).toBe(1);
      expect(st.array_unwrap('raw')).toBe('raw');
    });

    it('pass returns value', () => {
      expect(st.pass('x')).toBe('x');
    });

    it('is_empty detects empty values', () => {
      expect(st.is_empty(null)).toBe(true);
      expect(st.is_empty('')).toBe(true);
      expect(st.is_empty([])).toBe(true);
      expect(st.is_empty({})).toBe(true);
      expect(st.is_empty('x')).toBe(false);
      expect(st.is_empty([1])).toBe(false);
    });

    it('len returns length', () => {
      expect(st.len('abc')).toBe(3);
      expect(st.len([1, 2])).toBe(2);
      expect(st.len({})).toBe(0);
    });

    it('join and split work', () => {
      expect(st.join(['a', 'b'])).toBe('a,b');
      expect(st.join(['a', 'b'], '-')).toBe('a-b');
      expect(st.split('a,b')).toEqual(['a', 'b']);
      expect(st.split('a;b', ';')).toEqual(['a', 'b']);
    });

    it('includes, starts_with, ends_with work', () => {
      expect(st.includes('abc', 'b')).toBe(true);
      expect(st.starts_with('abc', 'ab')).toBe(true);
      expect(st.ends_with('abc', 'bc')).toBe(true);
    });

    it('json helpers work', () => {
      expect(st.json_encode({ x: 1 })).toBe('{"x":1}');
      expect(st.json_decode('{"x":1}')).toEqual({ x: 1 });
    });

    it('math helpers work', () => {
      expect(st.abs(-5)).toBe(5);
      expect(st.floor(2.9)).toBe(2);
      expect(st.ceil(2.1)).toBe(3);
      expect(st.round(2.5)).toBe(3);
      expect(st.clamp(5, 0, 10)).toBe(5);
      expect(st.clamp(-1, 0, 10)).toBe(0);
    });
  });

  describe('search and text', () => {
    it('find_message_by_content searches active branch', async () => {
      await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'needle' }] },
      });
      const found = await st.find_message_by_content('needle');
      expect(found!.content).toBe('needle');
      expect(await st.find_message_by_content('missing')).toBeNull();
    });

    it('find_messages_by_role filters by role', async () => {
      await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'u' }] },
      });
      await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'a' }] },
      });
      expect((await st.find_messages_by_role('user')).length).toBe(1);
      expect((await st.find_messages_by_role('assistant')).length).toBe(1);
    });

    it('messages_as_text concatenates messages', async () => {
      await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'hi' }] },
      });
      await h.deps.chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'hey' }] },
      });
      const text = await st.messages_as_text(' | ');
      expect(text).toBe('user: hi | assistant: hey');
    });

    it('get_message_texts returns texts', async () => {
      await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 't' }] },
      });
      expect(await st.get_message_texts()).toEqual(['t']);
    });

    it('get_head and get_active_child return messages', async () => {
      const head = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'head' }] },
      });
      const child = await h.deps.chats.insertMessage({
        parentId: head.id,
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'child' }] },
      });
      await h.deps.chats.updateChat(chatId, { headMessageId: head.id, activeChildId: child.id });
      expect((await st.get_head())!.id).toBe(head.id);
      expect((await st.get_active_child())!.id).toBe(child.id);
    });

    it('get_swipes returns snapshot messages', async () => {
      const head = await h.deps.chats.appendMessage(chatId, {
        role: 'user',
        extra: { parts: [{ type: 'text', text: 'head' }] },
      });
      await h.deps.chats.insertMessage({
        parentId: head.id,
        role: 'assistant',
        extra: { parts: [{ type: 'text', text: 'swipe' }] },
      });
      await h.deps.chats.updateChat(chatId, { headMessageId: head.id, activeChildId: null });
      const swipes = await st.get_swipes();
      expect(swipes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tags', () => {
    it('tag_add, tag_list, tag_remove manage tags', async () => {
      await st.tag_add(characterId, 'new-tag');
      expect(await st.tag_list(characterId)).toContain('new-tag');
      await st.tag_remove(characterId, 'new-tag');
      expect(await st.tag_list(characterId)).not.toContain('new-tag');
    });
  });

  describe('character creation and group members', () => {
    it('create_character creates a character and broadcasts created/listed', async () => {
      const result = await st.create_character({
        name: 'New NPC',
        description: 'A background character',
        personality: 'Gruff',
        tags: ['npc'],
      });
      expect(result.name).toBe('New NPC');
      const created = await h.deps.characters.getById(result.id);
      expect(created).toMatchObject({ name: 'New NPC', description: 'A background character', personality: 'Gruff', tags: ['npc'] });

      const createdMsg = client.messages.find((m: any) => m.type === 'character.created');
      expect(createdMsg).toMatchObject({ character: { id: result.id, name: 'New NPC' } });
      const listedMsg = client.messages.find((m: any) => m.type === 'character.listed');
      expect(listedMsg).toBeDefined();
      expect((listedMsg as any).characters.some((c: any) => c.id === result.id)).toBe(true);
    });

    it('create_character throws on duplicate name', async () => {
      await expect(st.create_character({ name: 'Test Character' })).rejects.toThrow('already exists');
    });

    it('create_character requires a name', async () => {
      await expect(st.create_character({ description: 'no name' })).rejects.toThrow('data.name');
    });

    it('update_character patches whitelisted fields only and broadcasts', async () => {
      await st.update_character(characterId, {
        description: 'Updated description',
        nickname: 'Nicky',
        alternateGreetings: ['Alt one'],
        extensions: { ignored: true },
      });
      const updated = await h.deps.characters.getById(characterId);
      expect(updated!.description).toBe('Updated description');
      // nickname and alternateGreetings are whitelisted; extensions is not.
      expect(updated!.nickname).toBe('Nicky');
      expect(updated!.alternateGreetings).toEqual(['Alt one']);
      expect(updated!.extensions).toEqual({});

      const updatedMsg = client.messages.find((m: any) => m.type === 'character.updated');
      expect(updatedMsg).toMatchObject({ character: { id: characterId, description: 'Updated description' } });
      expect(client.messages.some((m: any) => m.type === 'character.listed')).toBe(true);
    });

    it('update_character throws for unknown character', async () => {
      await expect(st.update_character(crypto.randomUUID(), { description: 'x' })).rejects.toThrow('not found');
    });

    async function makeGroupChatApi() {
      const groupChatId = crypto.randomUUID();
      await h.deps.chats.createChat(groupChatId, {
        characterId: null,
        personaId,
        name: 'Group Chat',
        headMessageId: null,
        metadata: {},
      });
      const groupCtx = new ScriptContext(groupChatId, new FakeLockable());
      const groupSt = createStApi(groupCtx, {
        generationService,
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
      }) as any;
      return { groupChatId, groupSt };
    }

    it('add_chat_member and remove_chat_member work on a group chat', async () => {
      const { groupChatId, groupSt } = await makeGroupChatApi();
      await groupSt.add_chat_member(characterId);
      const members = await h.deps.chatMembers.getMembers(groupChatId);
      expect(members.map((m) => m.characterId)).toEqual([characterId]);

      const addedMsg = client.messages.find((m: any) => m.type === 'group.member.added');
      expect(addedMsg).toMatchObject({ chatId: groupChatId, member: { characterId, characterName: 'Test Character' } });

      await groupSt.remove_chat_member(characterId);
      expect(await h.deps.chatMembers.getMembers(groupChatId)).toHaveLength(0);
      const removedMsg = client.messages.find((m: any) => m.type === 'group.member.removed');
      expect(removedMsg).toMatchObject({ chatId: groupChatId, characterId });
    });

    it('add_chat_member throws on a single-character chat', async () => {
      await expect(st.add_chat_member(characterId)).rejects.toThrow('single-character chat');
    });

    it('remove_chat_member throws on a single-character chat', async () => {
      await expect(st.remove_chat_member(characterId)).rejects.toThrow('single-character chat');
    });
  });

  describe('meta state', () => {
    it('set_state/get_state round-trip chat-scoped data', async () => {
      await st.set_state('my-ext', { unlocked: true, level: 3 });
      expect(await st.get_state('my-ext')).toEqual({ unlocked: true, level: 3 });
    });

    it('get_state returns null for unknown namespaces', async () => {
      expect(await st.get_state('never-set')).toBeNull();
    });

    it('set_global_state/get_global_state round-trip global data', async () => {
      await st.set_global_state('my-ext', { totalRuns: 7 });
      expect(await st.get_global_state('my-ext')).toEqual({ totalRuns: 7 });
    });

    it('delete_state removes chat-scoped data', async () => {
      await st.set_state('my-ext', { temp: 1 });
      await st.delete_state('my-ext');
      expect(await st.get_state('my-ext')).toBeNull();
    });

    it('chat-scoped state is isolated between chats', async () => {
      await st.set_state('my-ext', { origin: 'chat-1' });

      const otherChatId = crypto.randomUUID();
      await h.deps.chats.createChat(otherChatId, {
        characterId,
        personaId,
        name: 'Other Chat',
        headMessageId: null,
        metadata: {},
      });
      const otherCtx = new ScriptContext(otherChatId, new FakeLockable());
      const otherSt = createStApi(otherCtx, {
        generationService,
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
      }) as any;
      expect(await otherSt.get_state('my-ext')).toBeNull();
      // Global state, by contrast, is visible from every chat.
      await st.set_global_state('my-ext', { everywhere: true });
      expect(await otherSt.get_global_state('my-ext')).toEqual({ everywhere: true });
    });

    it('validates the namespace argument', async () => {
      await expect(st.set_state('', { x: 1 })).rejects.toThrow('namespace');
      await expect(st.get_state('x'.repeat(101))).rejects.toThrow('namespace');
    });
  });

  describe('macros', () => {
    it('substitute_macros resolves {{user}} and {{char}}', async () => {
      const result = await st.substitute_macros('{{user}} says hi to {{char}}');
      expect(result).toBe('Test Persona says hi to Test Character');
    });
  });

  describe('abort', () => {
    it('checkAbort throws after context abort for async functions', async () => {
      ctx.abort();
      await expect(st.get_chat()).rejects.toThrow('Script aborted');
    });

    it('sync functions do not call checkAbort', () => {
      ctx.abort();
      expect(() => st.pass('x')).not.toThrow();
      expect(() => st.upper('x')).not.toThrow();
    });
  });

  describe('createToolStApi subset (allowSt)', () => {
    it('every whitelisted name exists in the full API (no typos)', () => {
      for (const key of TOOL_ST_WHITELIST) {
        expect(st, `whitelist entry "${key}" missing from createStApi`).toHaveProperty(key);
      }
    });

    it('excludes chat actions, history mutation, and lifecycle', () => {
      const excluded = [
        'send', 'continue', 'impersonate', 'regenerate', 'trigger', 'stop',
        'swipe', 'cut', 'edit', 'delete', 'hide', 'unhide', 'set_message_role',
        'set_message_extra', 'set_reasoning', 'clear_reasoning', 'add_swipe',
        'set_active_child', 'repair_active_child', 'comment', 'send_as',
        'send_narrator', 'reset_chat', 'new_chat', 'temp_chat', 'delete_chat',
        'branch', 'checkpoint', 'hard_fork',
      ];
      for (const key of excluded) {
        expect(toolSt[key], `"${key}" should be excluded`).toBeUndefined();
      }
    });

    it('keeps queries, entity writes, vars, settings, quiet generation, and utils functional', async () => {
      expect(await toolSt.get_chat_name()).toBe('Test Chat');
      await toolSt.setvar('hp', 42);
      expect(await toolSt.getvar('hp')).toBe(42);
      expect(typeof toolSt.generate).toBe('function');
      expect(typeof toolSt.toast).toBe('function');
      expect(toolSt.token_count('hello world')).toBeGreaterThan(0);
      expect(await toolSt.substitute_macros('{{char}}')).toBe('Test Character');
      const created = await toolSt.create_character({ name: 'Tool Made', description: 'x' });
      expect(created.name).toBe('Tool Made');
      expect(await toolSt.wi_list()).not.toBeNull();
    });
  });
});
