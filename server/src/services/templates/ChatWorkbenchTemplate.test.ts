import { describe, it, expect, vi } from 'vitest';
import { registerChatWorkbenchTemplate } from './ChatWorkbenchTemplate.js';
import type { Character } from '@tamari/types';
import type { ToolTemplate } from '../ToolTemplate.js';

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char1',
    name: 'Test Character',
    description: '',
    personality: '',
    scenario: '',
    firstMes: 'Hello!',
    mesExample: '',
    creator: '',
    characterVersion: '',
    tags: [],
    avatarPath: null,
    avatarThumbnailPath: null,
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    groupOnlyGreetings: [],
    nickname: '',
    creatorNotesMultilingual: {},
    source: [],
    extensions: {},
    createDate: '',
    worldInfoId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeTemplate(opts: { characters?: Character[]; chats?: Array<{ id: string; characterId: string | null }> } = {}) {
  const charStore = new Map((opts.characters ?? []).map((c) => [c.id, c]));
  const characters = { getById: async (id: string) => charStore.get(id) };
  const chatStore = new Map((opts.chats ?? []).map((c) => [c.id, c]));
  const chats = { getChatById: async (id: string) => chatStore.get(id) };
  const memberStore = new Map<string, Array<{ characterId: string }>>();
  const chatMembers = {
    getMembers: async (chatId: string) => memberStore.get(chatId) ?? [],
    addMember: async (chatId: string, characterId: string) => {
      const member = { chatId, characterId };
      memberStore.set(chatId, [...(memberStore.get(chatId) ?? []), member]);
      return member;
    },
    removeMember: async (chatId: string, characterId: string) => {
      memberStore.set(chatId, (memberStore.get(chatId) ?? []).filter((m) => m.characterId !== characterId));
    },
  };
  const chatMetaBroadcast = {
    broadcastGroupMemberAdded: vi.fn(),
    broadcastGroupMemberRemoved: vi.fn(),
  };

  let template: ToolTemplate | undefined;
  registerChatWorkbenchTemplate(
    {
      registerTemplate: (t) => {
        template = t;
      },
    },
    {
      chats: chats as never,
      characters: characters as never,
      chatMembers: chatMembers as never,
      chatMetaBroadcast,
    },
  );
  if (!template) throw new Error('chat workbench template was not registered');
  return { template, memberStore, chatMetaBroadcast };
}

describe('ChatWorkbenchTemplate', () => {
  describe('registration', () => {
    it('registers as builtin with the three membership tools', async () => {
      const { template } = makeTemplate();
      expect(template.id).toBe('chat_workbench');
      expect(template.source).toBe('builtin');
      const def = await template.getDefinition();
      expect(def.tools.map((t) => t.name).sort()).toEqual(['chat_add_member', 'chat_list_members', 'chat_remove_member']);
    });
  });

  describe('chat membership tools', () => {
    const groupChat = { id: 'chat1', characterId: null };
    const singleChat = { id: 'chat2', characterId: 'char1' };

    it('adds, lists, and removes a member with explicit chatId; broadcasts via chatMetaBroadcast', async () => {
      const { template, chatMetaBroadcast, memberStore } = makeTemplate({
        characters: [makeCharacter()],
        chats: [groupChat],
      });

      const add = await template.execute('chat_add_member', { characterId: 'char1', chatId: 'chat1' });
      expect(JSON.parse(add.content as string)).toEqual({ chatId: 'chat1', characterId: 'char1' });
      expect(chatMetaBroadcast.broadcastGroupMemberAdded).toHaveBeenCalledWith('chat1', expect.objectContaining({ characterId: 'char1' }));

      const list = await template.execute('chat_list_members', { chatId: 'chat1' });
      const parsed = JSON.parse(list.content as string) as { members: Array<{ characterId: string; name: string }> };
      expect(parsed.members).toEqual([{ characterId: 'char1', name: 'Test Character' }]);

      const remove = await template.execute('chat_remove_member', { characterId: 'char1', chatId: 'chat1' });
      expect(JSON.parse(remove.content as string)).toEqual({ chatId: 'chat1', removed: 'char1' });
      expect(chatMetaBroadcast.broadcastGroupMemberRemoved).toHaveBeenCalledWith('chat1', 'char1');
      expect(memberStore.get('chat1')).toEqual([]);
    });

    it('defaults to the current chat from context', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()], chats: [groupChat] });
      const res = await template.execute('chat_add_member', { characterId: 'char1' }, { chatId: 'chat1' });
      expect(JSON.parse(res.content as string)).toEqual({ chatId: 'chat1', characterId: 'char1' });
    });

    it('errors without a chatId anywhere', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()], chats: [groupChat] });
      const res = await template.execute('chat_add_member', { characterId: 'char1' });
      expect(res.content).toBe('Error: no chatId given and no current chat context');
    });

    it('rejects single-character chats', async () => {
      const { template } = makeTemplate({ characters: [makeCharacter()], chats: [singleChat] });
      const res = await template.execute('chat_add_member', { characterId: 'char1', chatId: 'chat2' });
      expect(res.content).toContain('single-character chat');
    });
  });
});
