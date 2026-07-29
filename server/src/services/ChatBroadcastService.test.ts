import { describe, it, expect, vi } from 'vitest';
import { ChatBroadcastService, type ChatBroadcastServiceDeps } from './ChatBroadcastService.js';
import type { EventBus } from '../bus/EventBus.js';
import type { Character, Chat } from '@tamari/types';

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

const makeChat = (overrides?: Partial<Chat>): Chat => ({
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
  ...overrides,
});

function makeService(character: Character) {
  const bus = { broadcast: vi.fn() } as unknown as EventBus;
  const deps: ChatBroadcastServiceDeps = {
    bus,
    chats: {
      getChatById: vi.fn(async () => makeChat()),
      getBulkOfMessages: vi.fn(async () => []),
      getSiblings: vi.fn(async () => []),
      getMessageById: vi.fn(),
    } as unknown as ChatBroadcastServiceDeps['chats'],
    characters: {
      getById: vi.fn(async () => character),
      getByIds: vi.fn(async () => []),
    } as unknown as ChatBroadcastServiceDeps['characters'],
    personas: {
      getById: vi.fn(),
      getByIds: vi.fn(async () => []),
    } as unknown as ChatBroadcastServiceDeps['personas'],
    settings: {
      list: vi.fn(async () => ({})),
      getTyped: vi.fn(async () => ({ userName: 'User' })),
    } as unknown as ChatBroadcastServiceDeps['settings'],
    characterAssets: {
      listForCharacter: vi.fn(async () => [
        { name: 'portrait.png', id: 'asset1', ext: 'png', filePath: 'asset1.png', meta: {} },
      ]),
    } as unknown as NonNullable<ChatBroadcastServiceDeps['characterAssets']>,
  };
  return { service: new ChatBroadcastService(deps), bus };
}

describe('ChatBroadcastService virtual greeting', () => {
  it('resolves the img display macro in greetingHtml', async () => {
    const character = makeCharacter({ firstMes: 'Look! {{img::portrait.png}}' });
    const { service, bus } = makeService(character);

    await service.broadcastSnapshot('chat-1');

    const payload = vi.mocked(bus.broadcast).mock.calls[0]![0] as { greetingHtml?: string };
    expect(payload.greetingHtml).toContain('<img');
    expect(payload.greetingHtml).toContain('/api/characters/char-1/assets/asset1.png');
    expect(payload.greetingHtml).not.toContain('{{img');
  });

  it('degrades to alt text when the asset is unknown', async () => {
    const character = makeCharacter({ firstMes: 'Look! {{img::missing.png}}' });
    const { service, bus } = makeService(character);

    await service.broadcastSnapshot('chat-1');

    const payload = vi.mocked(bus.broadcast).mock.calls[0]![0] as { greetingHtml?: string };
    expect(payload.greetingHtml).not.toContain('{{img');
    expect(payload.greetingHtml).toContain('missing.png');
  });
});
