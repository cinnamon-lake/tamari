import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { MockWebSocket } from '../test/mocks/WebSocketMock.js';
import type { ServerState } from './serverStore.js';
import { getMessageText } from '@tamari/types';
import { toasts, removeToast } from './toastStore.js';
import { playMessageSound } from '../lib/sound.js';

// Mocks that must be established before serverStore is imported.
vi.mock('../lib/sound.js', () => ({
  playMessageSound: vi.fn(),
}));

let bus: import('../bus/WebSocketBus.js').WebSocketBus;
let state: ServerState;
let setState: (...args: any[]) => any;
let mockWs: MockWebSocket;

// uiStore functions (imported dynamically after WebSocket stub)
let setActiveChatId: (id: string | null) => void;
let activeChatId: () => string | null;
let setActiveCharacterId: (id: string | null) => void;
let activeCharacterId: () => string | null;
let setActiveWorldInfoId: (id: string | null) => void;
let activeWorldInfoId: () => string | null;
let setActivePersonaId: (id: string | null) => void;
let activePersonaId: () => string | null;
let setActiveBackendConfigId: (id: string | null) => void;
let activeBackendConfigId: () => string | null;
let setActivePromptListId: (id: string | null) => void;
let activePromptListId: () => string | null;
let setPendingChatId: (id: string | null) => void;
let pendingChatId: () => string | null;

// ---------- helpers ----------

function makeCharacter(overrides: Partial<import('@tamari/types').Character> = {}): import('@tamari/types').Character {
  return {
    id: 'char-1',
    name: 'Test Char',
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
    avatarUrl: null,
    thumbnailUrl: null,
    exportUrl: null,
    charxUrl: null,
    avatarUploadUrl: null,
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
  };
}

function makeCharacterSummary(overrides: Partial<import('@tamari/types').CharacterSummary> = {}): import('@tamari/types').CharacterSummary {
  return {
    id: 'char-1',
    name: 'Test Char',
    tags: [],
    avatarUrl: null,
    thumbnailUrl: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeChat(overrides: Partial<import('@tamari/types').Chat> = {}): import('@tamari/types').Chat {
  return {
    id: 'chat-1',
    characterId: 'char-1',
    personaId: null,
    name: 'Test Chat',
    headMessageId: null,
    activeChildId: null,
    materialized: false,
    createdAt: 0,
    updatedAt: 0,
    metadata: {},
    forkedFromChatId: null,
    forkedAtMessageId: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<import('@tamari/types').Message> = {}): import('@tamari/types').Message {
  return {
    id: 1,
    parentId: null,
    role: 'assistant',
    extra: { parts: [{ type: 'text', text: 'Hello' }] },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeWorldInfo(overrides: Partial<import('@tamari/types').WorldInfo> = {}): import('@tamari/types').WorldInfo {
  return {
    id: 'wi-1',
    name: 'Test Book',
    entries: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makePersona(overrides: Partial<import('@tamari/types').Persona> = {}): import('@tamari/types').Persona {
  return {
    id: 'persona-1',
    name: 'Test Persona',
    description: '',
    avatarPath: null,
    avatarThumbnailPath: null,
    avatarUrl: null,
    thumbnailUrl: null,
    avatarUploadUrl: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makePersonaSummary(overrides: Partial<import('@tamari/types').PersonaSummary> = {}): import('@tamari/types').PersonaSummary {
  return {
    id: 'persona-1',
    name: 'Test Persona',
    description: '',
    avatarUrl: null,
    thumbnailUrl: null,
    avatarUploadUrl: null,
    ...overrides,
  };
}

function makeBackendConfig(overrides: Partial<import('@tamari/types').BackendConfig> = {}): import('@tamari/types').BackendConfig {
  return {
    id: 'bc-1',
    name: 'Test BackendConfig',
    description: '',
    backendProvider: 'openai',
    generationMode: 'chat',
    model: 'gpt-4',
    apiUrl: null,
    apiKey: null,
    temperature: 0.7,
    maxTokens: 512,
    topP: 1,
    topK: null,
    minP: null,
    topA: null,
    repetitionPenalty: null,
    frequencyPenalty: null,
    presencePenalty: null,
    instructTemplate: '',
    contextLength: null,
    promptHistoryLimit: null,
    providerParams: {},
    stopStrings: [],
    openrouterProvider: null,
    logitBias: null,
    supportsImages: true,
    supportsAudio: true,
    supportsVideo: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeBackendConfigSummary(overrides: Partial<import('@tamari/types').BackendConfigSummary> = {}): import('@tamari/types').BackendConfigSummary {
  return {
    id: 'bc-1',
    name: 'Test BackendConfig',
    ...overrides,
  };
}

function makePromptList(overrides: Partial<import('@tamari/types').PromptList> = {}): import('@tamari/types').PromptList {
  return {
    id: 'pl-1',
    name: 'Test PromptList',
    description: '',
    prompts: [],
    promptOrder: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makePromptListSummary(overrides: Partial<import('@tamari/types').PromptListSummary> = {}): import('@tamari/types').PromptListSummary {
  return {
    id: 'pl-1',
    name: 'Test PromptList',
    ...overrides,
  };
}

function makeQuickReply(overrides: Partial<import('@tamari/types').QuickReply> = {}): import('@tamari/types').QuickReply {
  return {
    id: 'qr-1',
    scope: 'global',
    scopeId: '',
    label: 'Test',
    icon: '',
    color: '',
    script: '',
    language: 'javascript',
    autoExecute: 0,
    orderIndex: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeChatMember(overrides: Partial<import('@tamari/types').ChatMemberSummary> = {}): import('@tamari/types').ChatMemberSummary {
  return {
    chatId: 'chat-1',
    characterId: 'char-1',
    talkativeness: 1,
    depthPrompt: '',
    depthPromptDepth: 0,
    enabled: true,
    characterName: 'Test Char',
    characterAvatarUrl: null,
    characterThumbnailUrl: null,
    ...overrides,
  };
}

function resetState() {
  setState({
    clientId: '',
    characters: [],
    chats: [],
    messages: {},
    swipes: {},
    chatMembers: {},
    settings: {},
    worldInfo: [],
    personas: [],
    backendConfigs: [],
    promptLists: [],
    quickReplies: [],
    activeChat: null,
    activeCharacter: null,
    chatCharacter: null,
    activePersona: null,
    activeWorldInfo: null,
    activeBackendConfig: null,
    activeBackendConfigOrigin: null,
    activePromptList: null,
    toolsets: [],
    toolTemplates: [],
    generation: {
      activeId: null,
      chatId: null,
      targetMessageId: null,
      streamingText: '',
      streamingReasoning: '',
      impersonationDraft: '',
      status: 'idle',
    },
  });
}

async function flushMicrotasks() {
  await new Promise<void>((r) => queueMicrotask(() => r()));
}

describe('serverStore', () => {
  beforeAll(async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:8000' });

    const busModule = await import('../bus/WebSocketBus.js');
    bus = busModule.bus;

    const storeModule = await import('./serverStore.js');
    state = storeModule.state;
    setState = storeModule.setState;

    const uiModule = await import('./uiStore.js');
    setActiveChatId = uiModule.setActiveChatId;
    activeChatId = uiModule.activeChatId;
    setActiveCharacterId = uiModule.setActiveCharacterId;
    activeCharacterId = uiModule.activeCharacterId;
    setActiveWorldInfoId = uiModule.setActiveWorldInfoId;
    activeWorldInfoId = uiModule.activeWorldInfoId;
    setActivePersonaId = uiModule.setActivePersonaId;
    activePersonaId = uiModule.activePersonaId;
    setActiveBackendConfigId = uiModule.setActiveBackendConfigId;
    activeBackendConfigId = uiModule.activeBackendConfigId;
    setActivePromptListId = uiModule.setActivePromptListId;
    activePromptListId = uiModule.activePromptListId;
    setPendingChatId = uiModule.setPendingChatId;
    pendingChatId = uiModule.pendingChatId;

    await flushMicrotasks();
    mockWs = (bus as unknown as { ws: MockWebSocket }).ws;
  });

  beforeEach(() => {
    resetState();
    // Reset uiStore signals
    setActiveChatId(null);
    setActiveCharacterId(null);
    setActiveWorldInfoId(null);
    setActivePersonaId(null);
    setActiveBackendConfigId(null);
    setActivePromptListId(null);
    setPendingChatId(null);

    // Reset toasts
    while (toasts.length > 0) {
      removeToast(toasts[0]!.id);
    }

    // Reset bus
    bus.disconnect();
    bus.clientId = '';
    bus.authError = false;
    bus.connect();
    mockWs = (bus as unknown as { ws: MockWebSocket }).ws;

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------- client.assigned ----------

  describe('client.assigned', () => {
    it('sets clientId', () => {
      mockWs.simulateMessage({ type: 'client.assigned', clientId: 'c1' });
      expect(state.clientId).toBe('c1');
    });
  });

  // ---------- snapshot ----------

  describe('snapshot', () => {
    it('populates characters, chats, and settings', () => {
      const char = makeCharacterSummary({ id: 'char-1', name: 'Alice' });
      const chat = makeChat({ id: 'chat-1', name: 'Chat 1' });
      mockWs.simulateMessage({
        type: 'snapshot',
        state: {
          characters: [char],
          chats: [chat],
          settings: { theme: 'dark' },
        },
      });
      expect(state.characters).toHaveLength(1);
      expect(state.characters[0]!.name).toBe('Alice');
      expect(state.chats).toHaveLength(1);
      expect((state.settings as any).theme).toBe('dark');
    });

    it('restores generation state when present', () => {
      mockWs.simulateMessage({
        type: 'snapshot',
        state: {
          characters: [],
          chats: [],
          settings: {},
          generation: { id: 'gen-1', chatId: 'chat-1', messageId: 1, text: 'hello' },
        },
      });
      expect(state.generation.status).toBe('streaming');
      expect(state.generation.activeId).toBe('gen-1');
      expect(state.generation.streamingText).toBe('hello');
    });

    it('leaves generation idle when not present', () => {
      mockWs.simulateMessage({
        type: 'snapshot',
        state: { characters: [], chats: [], settings: {} },
      });
      expect(state.generation.status).toBe('idle');
    });

    it('restores last active chat when autoLoadLastChat is enabled', () => {
      const chat = makeChat({ id: 'chat-last', name: 'Last Chat' });
      mockWs.simulateMessage({
        type: 'snapshot',
        state: {
          characters: [],
          chats: [chat],
          settings: { autoLoadLastChat: true, lastChatId: 'chat-last' },
        },
      });
      expect(activeChatId()).toBe('chat-last');
    });

    it('does not restore last chat when autoLoadLastChat is disabled', () => {
      const chat = makeChat({ id: 'chat-last', name: 'Last Chat' });
      mockWs.simulateMessage({
        type: 'snapshot',
        state: {
          characters: [],
          chats: [chat],
          settings: { autoLoadLastChat: false, lastChatId: 'chat-last' },
        },
      });
      expect(activeChatId()).toBeNull();
    });

    it('does not restore last chat when the stored chat no longer exists', () => {
      mockWs.simulateMessage({
        type: 'snapshot',
        state: {
          characters: [],
          chats: [makeChat({ id: 'chat-other' })],
          settings: { autoLoadLastChat: true, lastChatId: 'chat-missing' },
        },
      });
      expect(activeChatId()).toBeNull();
    });
  });

  // ---------- character handlers ----------

  describe('character handlers', () => {
    it('character.listed sets the list', () => {
      const char = makeCharacterSummary({ id: 'char-1', name: 'Alice' });
      mockWs.simulateMessage({ type: 'character.listed', characters: [char] });
      expect(state.characters).toHaveLength(1);
      expect(state.characters[0]!.name).toBe('Alice');
    });

    it('character.listed replaces the list', () => {
      setState('characters', [makeCharacterSummary({ id: 'char-1', name: 'Alice' })]);
      mockWs.simulateMessage({
        type: 'character.listed',
        characters: [makeCharacterSummary({ id: 'char-1', name: 'Alice Updated' })],
      });
      expect(state.characters[0]!.name).toBe('Alice Updated');
    });

    it('character.updated ignores unknown character', () => {
      setState('characters', [makeCharacterSummary({ id: 'char-1' })]);
      mockWs.simulateMessage({
        type: 'character.updated',
        character: makeCharacter({ id: 'char-99', name: 'Unknown' }),
      });
      expect(state.characters).toHaveLength(1);
      expect(state.characters[0]!.id).toBe('char-1');
    });

    it('character.updated updates activeCharacter', () => {
      setState('characters', [makeCharacterSummary({ id: 'char-1' })]);
      setActiveCharacterId('char-1');
      setState('activeCharacter', makeCharacter({ id: 'char-1', name: 'Old' }));
      mockWs.simulateMessage({
        type: 'character.updated',
        character: makeCharacter({ id: 'char-1', name: 'New' }),
      });
      expect(state.activeCharacter?.name).toBe('New');
    });

    it('character.updated updates chatCharacter', () => {
      setState('characters', [makeCharacterSummary({ id: 'char-1' })]);
      setState('chatCharacter', makeCharacter({ id: 'char-1', name: 'Old' }));
      mockWs.simulateMessage({
        type: 'character.updated',
        character: makeCharacter({ id: 'char-1', name: 'New' }),
      });
      expect(state.chatCharacter?.name).toBe('New');
    });

    it('character.deleted does not mutate list directly', () => {
      setState('characters', [makeCharacterSummary({ id: 'char-1' })]);
      mockWs.simulateMessage({ type: 'character.deleted', characterId: 'char-1' });
      expect(state.characters).toHaveLength(1);
    });

    it('character.deleted clears activeCharacterId', () => {
      setActiveCharacterId('char-1');
      setState('activeCharacter', makeCharacter({ id: 'char-1' }));
      mockWs.simulateMessage({ type: 'character.deleted', characterId: 'char-1' });
      expect(activeCharacterId()).toBeNull();
    });

    it('character.snapshot updates activeCharacter when IDs match', () => {
      setActiveCharacterId('char-1');
      mockWs.simulateMessage({
        type: 'character.snapshot',
        character: makeCharacter({ id: 'char-1', name: 'Updated' }),
      });
      expect(state.activeCharacter?.name).toBe('Updated');
    });

    it('character.snapshot ignores when ID does not match', () => {
      setActiveCharacterId('char-1');
      setState('activeCharacter', makeCharacter({ id: 'char-1', name: 'Old' }));
      mockWs.simulateMessage({
        type: 'character.snapshot',
        character: makeCharacter({ id: 'char-2', name: 'Other' }),
      });
      expect(state.activeCharacter?.name).toBe('Old');
    });
  });

  // ---------- chat handlers ----------

  describe('chat handlers', () => {
    it('chat.created does not mutate the list (.listed owns lists)', () => {
      const chat = makeChat({ id: 'chat-1', name: 'New Chat' });
      mockWs.simulateMessage({ type: 'chat.created', chat });
      expect(state.chats).toHaveLength(0);
    });

    it('chat.created sets pendingChatId for own client', () => {
      setPendingChatId(null);
      setState('clientId', 'my-client');
      mockWs.simulateMessage({ type: 'chat.created', chat: makeChat({ id: 'chat-1' }), clientId: 'my-client' });
      expect(pendingChatId()).toBe('chat-1');
    });

    it('chat.forked does not mutate the list (.listed owns lists)', () => {
      const chat = makeChat({ id: 'chat-fork', name: 'Fork' });
      mockWs.simulateMessage({ type: 'chat.forked', chat });
      expect(state.chats).toHaveLength(0);
    });

    it('chat.updated replaces list item with the full object', () => {
      setState('chats', [makeChat({ id: 'chat-1', name: 'Old' })]);
      mockWs.simulateMessage({ type: 'chat.updated', chat: makeChat({ id: 'chat-1', name: 'New' }) });
      expect(state.chats[0]!.name).toBe('New');
    });

    it('chat.updated replaces activeChat with the full object (no merge)', () => {
      setState('chats', [makeChat({ id: 'chat-1', name: 'Old', metadata: { stale: true } })]);
      setState('activeChat', makeChat({ id: 'chat-1', name: 'Old', metadata: { stale: true } }));
      mockWs.simulateMessage({
        type: 'chat.updated',
        chat: makeChat({ id: 'chat-1', name: 'New', metadata: {} }),
      });
      expect(state.activeChat?.name).toBe('New');
      // Full replace, not merge: the stale metadata key is gone.
      expect(state.activeChat?.metadata?.stale).toBeUndefined();
    });

    it('chat.updated ignores unknown chat', () => {
      setState('chats', [makeChat({ id: 'chat-1' })]);
      mockWs.simulateMessage({ type: 'chat.updated', chat: makeChat({ id: 'chat-99', name: 'New' }) });
      expect(state.chats[0]!.name).not.toBe('New');
    });

    it('chat.deleted removes from list', () => {
      setState('chats', [makeChat({ id: 'chat-1' })]);
      mockWs.simulateMessage({ type: 'chat.deleted', chatId: 'chat-1' });
      expect(state.chats).toHaveLength(0);
    });

    it('chat.deleted clears activeChatId and related state', () => {
      setActiveChatId('chat-1');
      setState('activeChat', makeChat({ id: 'chat-1' }));
      setState('messages', 'chat-1', [makeMessage()]);
      setState('swipes', 'chat-1', [makeMessage()]);
      setState('chatMembers', 'chat-1', [makeChatMember()]);
      mockWs.simulateMessage({ type: 'chat.deleted', chatId: 'chat-1' });
      expect(activeChatId()).toBeNull();
      expect(state.activeChat).toBeNull();
      expect(state.messages['chat-1']).toBeUndefined();
      expect(state.swipes['chat-1']).toBeUndefined();
      expect(state.chatMembers['chat-1']).toBeUndefined();
    });

    it('chat.snapshot sets active chat data when IDs match', () => {
      setActiveChatId('chat-1');
      const chat = makeChat({ id: 'chat-1', name: 'Active' });
      const msg = makeMessage({ id: 1, extra: { parts: [{ type: 'text', text: 'Hello' }] } });
      mockWs.simulateMessage({
        type: 'chat.snapshot',
        chat,
        messages: [msg],
        swipes: [],
      });
      expect(state.activeChat?.name).toBe('Active');
      expect(state.messages['chat-1']).toHaveLength(1);
    });

    it('chat.snapshot writes the bound persona to chatPersona, not the editor slot', () => {
      setActiveChatId('chat-1');
      setState('activePersona', makePersona({ id: 'persona-editor' }));
      mockWs.simulateMessage({
        type: 'chat.snapshot',
        chat: makeChat({ id: 'chat-1' }),
        messages: [],
        swipes: [],
        persona: makePersona({ id: 'persona-chat', name: 'Chat Persona' }),
      });
      expect(state.chatPersona?.id).toBe('persona-chat');
      // Editor slot untouched — a background snapshot must not unmount the editor
      // (AGENTS.md §1 chatX/activeX split).
      expect(state.activePersona?.id).toBe('persona-editor');
    });

    it('chat.snapshot ignores when ID does not match activeChatId', () => {
      setActiveChatId('chat-1');
      const chat = makeChat({ id: 'chat-2', name: 'Other' });
      mockWs.simulateMessage({
        type: 'chat.snapshot',
        chat,
        messages: [],
        swipes: [],
      });
      expect(state.activeChat).toBeNull();
    });
  });

  // ---------- message handlers ----------

  describe('message handlers', () => {
    beforeEach(() => {
      setActiveChatId('chat-1');
      setState('messages', 'chat-1', [makeMessage({ id: 1, extra: { parts: [{ type: 'text', text: 'First' }] } })]);
    });

    it('messages.loaded prepends older messages', () => {
      mockWs.simulateMessage({
        type: 'messages.loaded',
        chatId: 'chat-1',
        messages: [makeMessage({ id: 0, extra: { parts: [{ type: 'text', text: 'Older' }] } })],
      });
      expect(state.messages['chat-1']).toHaveLength(2);
      expect(getMessageText(state.messages['chat-1']![0]!.extra.parts)).toBe('Older');
      expect(getMessageText(state.messages['chat-1']![1]!.extra.parts)).toBe('First');
    });

    it('messages.loaded ignores wrong chatId', () => {
      mockWs.simulateMessage({
        type: 'messages.loaded',
        chatId: 'chat-2',
        messages: [makeMessage({ id: 0 })],
      });
      expect(state.messages['chat-1']).toHaveLength(1);
    });

    it('message.appended adds to end', () => {
      mockWs.simulateMessage({
        type: 'message.appended',
        chatId: 'chat-1',
        message: makeMessage({ id: 2, extra: { parts: [{ type: 'text', text: 'Second' }] } }),
      });
      expect(state.messages['chat-1']).toHaveLength(2);
      expect(getMessageText(state.messages['chat-1']![1]!.extra.parts)).toBe('Second');
    });

    it('message.appended deduplicates by ID', () => {
      mockWs.simulateMessage({
        type: 'message.appended',
        chatId: 'chat-1',
        message: makeMessage({ id: 1, extra: { parts: [{ type: 'text', text: 'Duplicate' }] } }),
      });
      expect(state.messages['chat-1']).toHaveLength(1);
      expect(getMessageText(state.messages['chat-1']![0]!.extra.parts)).toBe('First');
    });

    it('message.snapshot updates message in messages and swipes', () => {
      setState('swipes', 'chat-1', [makeMessage({ id: 1, extra: { parts: [{ type: 'text', text: 'Swipe' }] } })]);
      mockWs.simulateMessage({
        type: 'message.snapshot',
        chatId: 'chat-1',
        message: makeMessage({ id: 1, extra: { parts: [{ type: 'text', text: 'Edited' }] } }),
      });
      expect(getMessageText(state.messages['chat-1']![0]!.extra.parts)).toBe('Edited');
      expect(getMessageText(state.swipes['chat-1']![0]!.extra.parts)).toBe('Edited');
    });

    it('message.deleted removes from messages and swipes', () => {
      setState('swipes', 'chat-1', [makeMessage({ id: 1 })]);
      mockWs.simulateMessage({
        type: 'message.deleted',
        chatId: 'chat-1',
        messageId: 1,
      });
      expect(state.messages['chat-1']).toHaveLength(0);
      expect(state.swipes['chat-1']).toHaveLength(0);
    });

    it('message.deleted clears headMessageId when matches', () => {
      setState('activeChat', makeChat({ id: 'chat-1', headMessageId: 1 }));
      mockWs.simulateMessage({
        type: 'message.deleted',
        chatId: 'chat-1',
        messageId: 1,
      });
      expect(state.activeChat?.headMessageId).toBeNull();
    });

    it('message.deleted clears activeChildId when matches', () => {
      setState('activeChat', makeChat({ id: 'chat-1', activeChildId: 1 }));
      mockWs.simulateMessage({
        type: 'message.deleted',
        chatId: 'chat-1',
        messageId: 1,
      });
      expect(state.activeChat?.activeChildId).toBeNull();
    });
  });

  // ---------- generation handlers ----------

  describe('generation handlers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      setActiveChatId('chat-1');
    });

    it('generation.started resets state', () => {
      mockWs.simulateMessage({
        type: 'generation.started',
        generationId: 'gen-1',
        chatId: 'chat-1',
        messageId: 1,
      });
      expect(state.generation.status).toBe('streaming');
      expect(state.generation.activeId).toBe('gen-1');
      expect(state.generation.chatId).toBe('chat-1');
      expect(state.generation.streamingText).toBe('');
    });

    it('generation.token with smooth streaming OFF updates immediately', () => {
      setState('settings', { smoothStreaming: false });
      setState('generation', { ...state.generation, chatId: 'chat-1', status: 'streaming' });
      mockWs.simulateMessage({
        type: 'generation.token',
        generationId: 'gen-1',
        token: 'hello',
      });
      expect(state.generation.streamingText).toBe('hello');
    });

    it('generation.token with smooth streaming ON queues tokens', () => {
      setState('settings', { smoothStreaming: true, smoothStreamingDelay: 25 });
      setState('generation', { ...state.generation, chatId: 'chat-1', status: 'streaming' });
      mockWs.simulateMessage({
        type: 'generation.token',
        generationId: 'gen-1',
        token: 'h',
      });
      expect(state.generation.streamingText).toBe('');
      vi.advanceTimersByTime(25);
      expect(state.generation.streamingText).toBe('h');
    });

    it('generation.reasoningToken updates reasoning text', () => {
      setState('settings', { smoothStreaming: false });
      setState('generation', { ...state.generation, chatId: 'chat-1', status: 'streaming' });
      mockWs.simulateMessage({
        type: 'generation.reasoningToken',
        generationId: 'gen-1',
        token: 'thinking',
      });
      expect(state.generation.streamingReasoning).toBe('thinking');
    });

    it('generation.done resets state', () => {
      setState('generation', { ...state.generation, activeId: 'gen-1', status: 'streaming' });
      mockWs.simulateMessage({
        type: 'generation.done',
        generationId: 'gen-1',
        finishReason: 'stop',
      });
      expect(state.generation.status).toBe('idle');
      expect(state.generation.activeId).toBeNull();
    });

    it('generation.done plays sound when enabled and unfocused-only is off', () => {
      vi.stubGlobal('document', { hidden: false, hasFocus: () => true });
      setState('settings', { messageSoundEnabled: true, messageSoundUnfocusedOnly: false });
      setState('generation', { ...state.generation, activeId: 'gen-1', status: 'streaming' });
      mockWs.simulateMessage({
        type: 'generation.done',
        generationId: 'gen-1',
        finishReason: 'stop',
      });
      expect(playMessageSound).toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('generation.done plays sound when enabled, unfocused-only is on, and document is hidden', () => {
      vi.stubGlobal('document', { hidden: true, hasFocus: () => false });
      setState('settings', { messageSoundEnabled: true, messageSoundUnfocusedOnly: true });
      setState('generation', { ...state.generation, activeId: 'gen-1', status: 'streaming' });
      mockWs.simulateMessage({
        type: 'generation.done',
        generationId: 'gen-1',
        finishReason: 'stop',
      });
      expect(playMessageSound).toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('generation.done does not play sound when enabled but focused and unfocused-only is on', () => {
      vi.stubGlobal('document', { hidden: false, hasFocus: () => true });
      setState('settings', { messageSoundEnabled: true, messageSoundUnfocusedOnly: true });
      setState('generation', { ...state.generation, activeId: 'gen-1', status: 'streaming' });
      mockWs.simulateMessage({
        type: 'generation.done',
        generationId: 'gen-1',
        finishReason: 'stop',
      });
      expect(playMessageSound).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('generation.aborted resets state', () => {
      setState('generation', { ...state.generation, activeId: 'gen-1', status: 'streaming' });
      mockWs.simulateMessage({
        type: 'generation.aborted',
        generationId: 'gen-1',
      });
      expect(state.generation.status).toBe('idle');
    });

    it('generation.error resets state', () => {
      setState('generation', { ...state.generation, activeId: 'gen-1', status: 'streaming' });
      mockWs.simulateMessage({
        type: 'generation.error',
        generationId: 'gen-1',
        error: 'API failed',
      });
      expect(state.generation.status).toBe('idle');
    });

    it('impersonation.complete sets draft', () => {
      setState('generation', { ...state.generation, chatId: 'chat-1', status: 'streaming' });
      mockWs.simulateMessage({
        type: 'impersonation.complete',
        generationId: 'gen-1',
        text: 'I think...',
      });
      expect(state.generation.impersonationDraft).toBe('I think...');
    });
  });

  // ---------- world info handlers ----------

  describe('world info handlers', () => {
    it('worldinfo.listed sets books', () => {
      const book = makeWorldInfo({ id: 'wi-1', name: 'Lore' });
      mockWs.simulateMessage({ type: 'worldinfo.listed', books: [book] });
      expect(state.worldInfo).toHaveLength(1);
      expect(state.worldInfo[0]!.name).toBe('Lore');
    });

    it('worldinfo.created does not mutate list directly', () => {
      setState('worldInfo', [makeWorldInfo({ id: 'wi-1' })]);
      mockWs.simulateMessage({ type: 'worldinfo.created', book: makeWorldInfo({ id: 'wi-2', name: 'New' }) });
      expect(state.worldInfo).toHaveLength(1);
    });

    it('worldinfo.updated updates activeWorldInfo', () => {
      setActiveWorldInfoId('wi-1');
      setState('activeWorldInfo', makeWorldInfo({ id: 'wi-1', name: 'Old' }));
      mockWs.simulateMessage({ type: 'worldinfo.updated', book: makeWorldInfo({ id: 'wi-1', name: 'New' }) });
      expect(state.activeWorldInfo?.name).toBe('New');
    });

    it('worldinfo.deleted clears activeWorldInfoId', () => {
      setActiveWorldInfoId('wi-1');
      setState('activeWorldInfo', makeWorldInfo({ id: 'wi-1' }));
      mockWs.simulateMessage({ type: 'worldinfo.deleted', bookId: 'wi-1' });
      expect(activeWorldInfoId()).toBeNull();
      expect(state.activeWorldInfo).toBeNull();
    });

    it('worldinfo.snapshot updates activeWorldInfo when IDs match', () => {
      setActiveWorldInfoId('wi-1');
      mockWs.simulateMessage({ type: 'worldinfo.snapshot', book: makeWorldInfo({ id: 'wi-1', name: 'Updated' }) });
      expect(state.activeWorldInfo?.name).toBe('Updated');
    });

    it('worldinfo.snapshot ignores when ID does not match', () => {
      setActiveWorldInfoId('wi-1');
      mockWs.simulateMessage({ type: 'worldinfo.snapshot', book: makeWorldInfo({ id: 'wi-2', name: 'Other' }) });
      expect(state.activeWorldInfo).toBeNull();
    });
  });

  // ---------- persona handlers ----------

  describe('persona handlers', () => {
    it('persona.listed sets personas', () => {
      const p = makePersonaSummary({ id: 'p1', name: 'Alice' });
      mockWs.simulateMessage({ type: 'persona.listed', personas: [p] });
      expect(state.personas).toHaveLength(1);
    });

    it('persona.created does not mutate list directly', () => {
      setState('personas', []);
      mockWs.simulateMessage({ type: 'persona.created', persona: makePersona({ id: 'p1' }) });
      expect(state.personas).toHaveLength(0);
    });

    it('persona.updated updates activePersona', () => {
      setActivePersonaId('p1');
      setState('activePersona', makePersona({ id: 'p1', name: 'Old' }));
      mockWs.simulateMessage({ type: 'persona.updated', persona: makePersona({ id: 'p1', name: 'New' }) });
      expect(state.activePersona?.name).toBe('New');
    });

    it('persona.deleted clears activePersonaId', () => {
      setActivePersonaId('p1');
      setState('activePersona', makePersona({ id: 'p1' }));
      mockWs.simulateMessage({ type: 'persona.deleted', personaId: 'p1' });
      expect(activePersonaId()).toBeNull();
      expect(state.activePersona).toBeNull();
    });

    it('persona.snapshot updates activePersona when IDs match', () => {
      setActivePersonaId('p1');
      mockWs.simulateMessage({ type: 'persona.snapshot', persona: makePersona({ id: 'p1', name: 'Updated' }) });
      expect(state.activePersona?.name).toBe('Updated');
    });
  });

  // ---------- backendConfig handlers ----------

  describe('backendConfig handlers', () => {
    it('backendConfig.listed sets backendConfigs', () => {
      const b = makeBackendConfigSummary({ id: 'bc1', name: 'Default' });
      mockWs.simulateMessage({ type: 'backendConfig.listed', backendConfigs: [b] });
      expect(state.backendConfigs).toHaveLength(1);
    });

    it('backendConfig.created does not mutate list directly', () => {
      setState('backendConfigs', []);
      mockWs.simulateMessage({ type: 'backendConfig.created', backendConfig: makeBackendConfig({ id: 'bc1', name: 'New' }) });
      expect(state.backendConfigs).toHaveLength(0);
    });

    it('backendConfig.updated updates activeBackendConfig', () => {
      setActiveBackendConfigId('bc1');
      setState('activeBackendConfig', makeBackendConfig({ id: 'bc1', name: 'Old' }));
      mockWs.simulateMessage({ type: 'backendConfig.updated', backendConfig: makeBackendConfig({ id: 'bc1', name: 'New' }) });
      expect(state.activeBackendConfig?.name).toBe('New');
    });

    it('backendConfig.deleted clears activeBackendConfigId', () => {
      setActiveBackendConfigId('bc1');
      setState('activeBackendConfig', makeBackendConfig({ id: 'bc1' }));
      mockWs.simulateMessage({ type: 'backendConfig.deleted', backendConfigId: 'bc1' });
      expect(activeBackendConfigId()).toBeNull();
      expect(state.activeBackendConfig).toBeNull();
    });

    it('backendConfig.snapshot updates activeBackendConfig when IDs match', () => {
      setActiveBackendConfigId('bc1');
      mockWs.simulateMessage({ type: 'backendConfig.snapshot', backendConfig: makeBackendConfig({ id: 'bc1', name: 'Updated' }) });
      expect(state.activeBackendConfig?.name).toBe('Updated');
    });

    it('backendConfig.updated records the originator clientId', () => {
      setActiveBackendConfigId('bc1');
      setState('activeBackendConfig', makeBackendConfig({ id: 'bc1', name: 'Old' }));
      mockWs.simulateMessage({
        type: 'backendConfig.updated',
        backendConfig: makeBackendConfig({ id: 'bc1', name: 'New' }),
        clientId: 'client-2',
      });
      expect(state.activeBackendConfigOrigin).toBe('client-2');
    });

    it('backendConfig.updated for a non-active config leaves config and origin untouched', () => {
      setActiveBackendConfigId('bc1');
      setState('activeBackendConfig', makeBackendConfig({ id: 'bc1', name: 'Old' }));
      setState('activeBackendConfigOrigin', 'client-1');
      mockWs.simulateMessage({
        type: 'backendConfig.updated',
        backendConfig: makeBackendConfig({ id: 'bc2', name: 'Other' }),
        clientId: 'client-2',
      });
      expect(state.activeBackendConfig?.name).toBe('Old');
      expect(state.activeBackendConfigOrigin).toBe('client-1');
    });

    it('backendConfig.snapshot records the originator clientId', () => {
      setActiveBackendConfigId('bc1');
      mockWs.simulateMessage({
        type: 'backendConfig.snapshot',
        backendConfig: makeBackendConfig({ id: 'bc1' }),
        clientId: 'client-1',
      });
      expect(state.activeBackendConfigOrigin).toBe('client-1');
    });
  });

  // ---------- toolset handlers ----------

  describe('toolset handlers', () => {
    const makeToolset = (overrides: Partial<import('@tamari/types').Toolset> = {}): import('@tamari/types').Toolset => ({
      id: 'ts-1',
      templateId: 'tpl-1',
      name: 'Test Toolset',
      config: {},
      toolOverrides: {},
      enabled: true,
      agentVisible: false,
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    });

    it('toolset.listed replaces the list', () => {
      mockWs.simulateMessage({ type: 'toolset.listed', toolsets: [makeToolset({ id: 'ts-1' })] });
      expect(state.toolsets).toHaveLength(1);
      expect(state.toolsets[0]?.name).toBe('Test Toolset');
    });

    it('toolset.listed echo with identical content preserves item identity (no <For> remount)', () => {
      mockWs.simulateMessage({
        type: 'toolset.listed',
        toolsets: [makeToolset({ id: 'ts-1' }), makeToolset({ id: 'ts-2', name: 'Two' })],
      });
      const first = state.toolsets[0];
      const second = state.toolsets[1];
      // Same content, fresh objects — exactly what an own-save echo delivers.
      mockWs.simulateMessage({
        type: 'toolset.listed',
        toolsets: [makeToolset({ id: 'ts-1' }), makeToolset({ id: 'ts-2', name: 'Two' })],
      });
      expect(state.toolsets[0]).toBe(first);
      expect(state.toolsets[1]).toBe(second);
    });

    it('toolset.listed applies real changes while keeping identities of unchanged items', () => {
      mockWs.simulateMessage({
        type: 'toolset.listed',
        toolsets: [makeToolset({ id: 'ts-1' }), makeToolset({ id: 'ts-2', name: 'Two' })],
      });
      const unchanged = state.toolsets[0];
      mockWs.simulateMessage({
        type: 'toolset.listed',
        toolsets: [makeToolset({ id: 'ts-1' }), makeToolset({ id: 'ts-2', name: 'Renamed' })],
      });
      expect(state.toolsets[0]).toBe(unchanged);
      expect(state.toolsets[1]?.name).toBe('Renamed');
    });

    it('toolset.updated echo with identical content preserves item identity', () => {
      mockWs.simulateMessage({ type: 'toolset.listed', toolsets: [makeToolset({ id: 'ts-1' })] });
      const before = state.toolsets[0];
      mockWs.simulateMessage({ type: 'toolset.updated', toolset: makeToolset({ id: 'ts-1' }) });
      expect(state.toolsets[0]).toBe(before);
    });

    it('toolset.updated applies changes and ignores unknown ids', () => {
      mockWs.simulateMessage({ type: 'toolset.listed', toolsets: [makeToolset({ id: 'ts-1' })] });
      mockWs.simulateMessage({ type: 'toolset.updated', toolset: makeToolset({ id: 'ts-1', name: 'New Name' }) });
      expect(state.toolsets[0]?.name).toBe('New Name');
      mockWs.simulateMessage({ type: 'toolset.updated', toolset: makeToolset({ id: 'ts-unknown' }) });
      expect(state.toolsets).toHaveLength(1);
    });
  });

  // ---------- promptList handlers ----------

  describe('promptList handlers', () => {
    it('promptList.listed sets promptLists', () => {
      const p = makePromptListSummary({ id: 'pl1', name: 'Default' });
      mockWs.simulateMessage({ type: 'promptList.listed', promptLists: [p] });
      expect(state.promptLists).toHaveLength(1);
    });

    it('promptList.created does not mutate list directly', () => {
      setState('promptLists', []);
      mockWs.simulateMessage({ type: 'promptList.created', promptList: makePromptList({ id: 'pl1', name: 'New' }) });
      expect(state.promptLists).toHaveLength(0);
    });

    it('promptList.updated updates activePromptList', () => {
      setActivePromptListId('pl1');
      setState('activePromptList', makePromptList({ id: 'pl1', name: 'Old' }));
      mockWs.simulateMessage({ type: 'promptList.updated', promptList: makePromptList({ id: 'pl1', name: 'New' }) });
      expect(state.activePromptList?.name).toBe('New');
    });

    it('promptList.deleted clears activePromptListId', () => {
      setActivePromptListId('pl1');
      setState('activePromptList', makePromptList({ id: 'pl1' }));
      mockWs.simulateMessage({ type: 'promptList.deleted', promptListId: 'pl1' });
      expect(activePromptListId()).toBeNull();
      expect(state.activePromptList).toBeNull();
    });

    it('promptList.snapshot updates activePromptList when IDs match', () => {
      setActivePromptListId('pl1');
      mockWs.simulateMessage({ type: 'promptList.snapshot', promptList: makePromptList({ id: 'pl1', name: 'Updated' }) });
      expect(state.activePromptList?.name).toBe('Updated');
    });
  });

  // ---------- quick reply handlers ----------

  describe('quick reply handlers', () => {
    it('quickreply.listed sets items', () => {
      const qr = makeQuickReply({ id: 'qr1', label: 'Hi' });
      mockWs.simulateMessage({ type: 'quickreply.listed', items: [qr] });
      expect(state.quickReplies).toHaveLength(1);
    });

    it('quickreply.created does not touch the list (owned by quickreply.listed)', () => {
      // The server rebroadcasts `quickreply.listed` after every create/update/delete,
      // so `.created` carries no list behavior (AGENTS.md §5).
      setState('quickReplies', []);
      mockWs.simulateMessage({ type: 'quickreply.created', item: makeQuickReply({ id: 'qr1' }) });
      expect(state.quickReplies).toHaveLength(0);
    });

    it('quickreply.updated updates in list', () => {
      setState('quickReplies', [makeQuickReply({ id: 'qr1', label: 'Old' })]);
      mockWs.simulateMessage({ type: 'quickreply.updated', item: makeQuickReply({ id: 'qr1', label: 'New' }) });
      expect(state.quickReplies[0]!.label).toBe('New');
    });

    it('quickreply.updated ignores unknown item', () => {
      setState('quickReplies', [makeQuickReply({ id: 'qr1' })]);
      mockWs.simulateMessage({ type: 'quickreply.updated', item: makeQuickReply({ id: 'qr99' }) });
      expect(state.quickReplies).toHaveLength(1);
    });

    it('quickreply.deleted removes from list', () => {
      setState('quickReplies', [makeQuickReply({ id: 'qr1' })]);
      mockWs.simulateMessage({ type: 'quickreply.deleted', id: 'qr1' });
      expect(state.quickReplies).toHaveLength(0);
    });
  });

  // ---------- group chat handlers ----------

  describe('group chat handlers', () => {
    beforeEach(() => {
      setActiveChatId('chat-1');
    });

    it('group.members sets members', () => {
      mockWs.simulateMessage({
        type: 'group.members',
        chatId: 'chat-1',
        members: [makeChatMember({ characterId: 'char-1' })],
      });
      expect(state.chatMembers['chat-1']).toHaveLength(1);
    });

    it('group.member.added appends member', () => {
      setState('chatMembers', 'chat-1', [makeChatMember({ characterId: 'char-1' })]);
      mockWs.simulateMessage({
        type: 'group.member.added',
        chatId: 'chat-1',
        member: makeChatMember({ characterId: 'char-2' }),
      });
      expect(state.chatMembers['chat-1']).toHaveLength(2);
    });

    it('group.member.updated patches member', () => {
      setState('chatMembers', 'chat-1', [makeChatMember({ characterId: 'char-1', talkativeness: 1 })]);
      mockWs.simulateMessage({
        type: 'group.member.updated',
        chatId: 'chat-1',
        member: makeChatMember({ characterId: 'char-1', talkativeness: 5 }),
      });
      expect(state.chatMembers['chat-1']![0]!.talkativeness).toBe(5);
    });

    it('group.member.updated ignores unknown member', () => {
      setState('chatMembers', 'chat-1', [makeChatMember({ characterId: 'char-1', talkativeness: 1 })]);
      mockWs.simulateMessage({
        type: 'group.member.updated',
        chatId: 'chat-1',
        member: makeChatMember({ characterId: 'char-2', talkativeness: 5 }),
      });
      expect(state.chatMembers['chat-1']![0]!.talkativeness).toBe(1);
    });

    it('group.member.removed filters member', () => {
      setState('chatMembers', 'chat-1', [
        makeChatMember({ characterId: 'char-1' }),
        makeChatMember({ characterId: 'char-2' }),
      ]);
      mockWs.simulateMessage({
        type: 'group.member.removed',
        chatId: 'chat-1',
        characterId: 'char-1',
      });
      expect(state.chatMembers['chat-1']).toHaveLength(1);
      expect(state.chatMembers['chat-1']![0]!.characterId).toBe('char-2');
    });

    it('group handlers ignore wrong chatId', () => {
      setState('chatMembers', 'chat-1', [makeChatMember()]);
      mockWs.simulateMessage({
        type: 'group.members',
        chatId: 'chat-2',
        members: [makeChatMember({ characterId: 'char-99' })],
      });
      expect(state.chatMembers['chat-1']).toHaveLength(1);
      expect(state.chatMembers['chat-2']).toBeUndefined();
    });
  });

  // ---------- settings ----------

  describe('settings.changed', () => {
    it('updates a known setting by key', () => {
      setState('settings', { userName: 'Alice' });
      mockWs.simulateMessage({ type: 'settings.changed', key: 'userName', value: 'Bob' });
      expect(state.settings.userName).toBe('Bob');
    });

    it('ignores unknown keys', () => {
      mockWs.simulateMessage({ type: 'settings.changed', key: 'no.such.setting', value: 'x' });
      expect((state.settings as Record<string, unknown>)['no.such.setting']).toBeUndefined();
    });

    it('ignores values that fail the field schema', () => {
      setState('settings', { fontScale: 1 });
      mockWs.simulateMessage({ type: 'settings.changed', key: 'fontScale', value: 'huge' });
      expect(state.settings.fontScale).toBe(1);
    });
  });

  // ---------- error handlers ----------

  describe('error handlers', () => {
    it('error message is handled without throwing', () => {
      expect(() => {
        mockWs.simulateMessage({ type: 'error', message: 'Something broke' });
      }).not.toThrow();
    });

    it('script.toast with valid level is handled', () => {
      expect(() => {
        mockWs.simulateMessage({ type: 'script.toast', message: 'Hello', level: 'success' });
      }).not.toThrow();
    });

    it('script.toast maps warning level to warning toast', () => {
      mockWs.simulateMessage({ type: 'script.toast', message: 'Heads up', level: 'warning' });
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.message).toBe('Heads up');
      expect(toasts[0]!.type).toBe('warning');
    });

    it('script.toast with invalid level defaults to info', () => {
      expect(() => {
        mockWs.simulateMessage({ type: 'script.toast', message: 'Hello', level: 'invalid' });
      }).not.toThrow();
    });

    it('script.error is handled without throwing', () => {
      expect(() => {
        mockWs.simulateMessage({ type: 'script.error', message: 'Oops', source: 'test' });
      }).not.toThrow();
    });
  });
});
