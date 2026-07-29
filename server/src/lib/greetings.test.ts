import { describe, it, expect, vi } from 'vitest';
import { materializeGreetings, type GreetingMaterializerDeps } from './greetings.js';
import { EventBus } from '../bus/EventBus.js';
import type { Character, Message } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { IChatRepository } from '../repos/ChatRepository.js';

describe('materializeGreetings macroVars', () => {
  const makeCharacter = (overrides?: Partial<Character>): Character => ({
    id: 'char-1',
    name: 'Marisa',
    description: '',
    personality: '',
    scenario: '',
    firstMes: '',
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
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });

  it('stores macroVars in the greeting message extra', async () => {
    const bus = new EventBus();
    const appended: Message[] = [];
    const chats: IChatRepository = {
      appendMessage: vi.fn(async (_chatId, msg) => {
        const m = { id: 1, ...msg, createdAt: 0, updatedAt: 0 } as Message;
        appended.push(m);
        return m;
      }),
      updateChat: vi.fn(),
      getChatById: vi.fn(async () => ({
        id: 'chat-1',
        characterId: 'char-1',
        personaId: null,
        name: 'Test',
        headMessageId: null,
        activeChildId: null,
        materialized: false,
        createdAt: 0,
        updatedAt: 0,
        metadata: {},
        forkedFromChatId: null,
        forkedAtMessageId: null,
      })),
      getActiveBranch: vi.fn(async () => []),
      getBulkOfMessages: vi.fn(async () => []),
      getMessageById: vi.fn(),
      getSiblings: vi.fn(async () => []),
    } as unknown as IChatRepository;

    const chatBroadcast = { broadcastSnapshot: vi.fn() } as unknown as GreetingMaterializerDeps['chatBroadcast'];
    const deps: GreetingMaterializerDeps = { bus, chats, chatBroadcast };
    const character = makeCharacter({
      firstMes: 'Hello! {{setvar::greeting_type::casual}}',
    });

    await materializeGreetings(deps, 'chat-1', character, 0);

    expect(appended).toHaveLength(1);
    expect(getMessageText(appended[0]!.extra.parts)).toBe('Hello! ');
    expect(appended[0]!.extra.macroVars).toEqual({ greeting_type: 'casual' });
  });

  it('includes defaultVariables from risuai extensions in the snapshot', async () => {
    const bus = new EventBus();
    const appended: Message[] = [];
    const chats: IChatRepository = {
      appendMessage: vi.fn(async (_chatId, msg) => {
        const m = { id: 1, ...msg, createdAt: 0, updatedAt: 0 } as Message;
        appended.push(m);
        return m;
      }),
      updateChat: vi.fn(),
      getChatById: vi.fn(async () => ({
        id: 'chat-1',
        characterId: 'char-1',
        personaId: null,
        name: 'Test',
        headMessageId: null,
        activeChildId: null,
        materialized: false,
        createdAt: 0,
        updatedAt: 0,
        metadata: {},
        forkedFromChatId: null,
        forkedAtMessageId: null,
      })),
      getActiveBranch: vi.fn(async () => []),
      getBulkOfMessages: vi.fn(async () => []),
      getMessageById: vi.fn(),
      getSiblings: vi.fn(async () => []),
    } as unknown as IChatRepository;

    const chatBroadcast = { broadcastSnapshot: vi.fn() } as unknown as GreetingMaterializerDeps['chatBroadcast'];
    const deps: GreetingMaterializerDeps = { bus, chats, chatBroadcast };
    const character = makeCharacter({
      firstMes: 'Hey! {{setvar::mood::happy}}',
      extensions: { risuai: { defaultVariables: 'place=shrine\nmood=calm' } },
    });

    await materializeGreetings(deps, 'chat-1', character, 0);

    expect(appended[0]!.extra.macroVars).toEqual({
      place: 'shrine',
      mood: 'happy',
    });
  });

  it('materializes an empty chat (no greeting) and broadcasts a snapshot', async () => {
    const bus = new EventBus();
    const appended: Message[] = [];
    const chats: IChatRepository = {
      appendMessage: vi.fn(async (_chatId, msg) => {
        const m = { id: 1, ...msg, createdAt: 0, updatedAt: 0 } as Message;
        appended.push(m);
        return m;
      }),
      updateChat: vi.fn(),
      getChatById: vi.fn(async () => ({
        id: 'chat-1',
        characterId: 'char-1',
        personaId: null,
        name: 'Test',
        headMessageId: null,
        activeChildId: null,
        materialized: false,
        createdAt: 0,
        updatedAt: 0,
        metadata: {},
        forkedFromChatId: null,
        forkedAtMessageId: null,
      })),
      getActiveBranch: vi.fn(async () => []),
      getBulkOfMessages: vi.fn(async () => []),
      getMessageById: vi.fn(),
      getSiblings: vi.fn(async () => []),
    } as unknown as IChatRepository;

    const chatBroadcast = { broadcastSnapshot: vi.fn() } as unknown as GreetingMaterializerDeps['chatBroadcast'];
    const deps: GreetingMaterializerDeps = { bus, chats, chatBroadcast };
    const character = makeCharacter({ firstMes: '   ', alternateGreetings: [''] });

    await materializeGreetings(deps, 'chat-1', character, 0);

    // No message is inserted, but the chat must still be marked materialized
    // and a snapshot broadcast — otherwise the client's materialize promise
    // never resolves and Send silently dead-ends.
    expect(appended).toHaveLength(0);
    expect(chats.updateChat).toHaveBeenCalledWith('chat-1', { materialized: true });
    expect(chatBroadcast.broadcastSnapshot).toHaveBeenCalledWith('chat-1');
  });
});
