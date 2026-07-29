import { createStore, produce, reconcile } from 'solid-js/store';
import type { z } from 'zod';
import {
  AppSettingsSchema,
} from '@tamari/types';
import type {
  AppSettings,
  Character,
  CharacterSummary,
  Chat,
  ChatSummary,
  Message,
  WorldInfo,
  Persona,
  PersonaSummary,
  BackendConfig,
  BackendConfigSummary,
  PromptList,
  PromptListSummary,
  ChatMemberSummary,
  QuickReply,
  ToolInfo,
  Toolset,
  ToolTemplate,
  CustomBackend,
} from '@tamari/types';
import { bus } from '../bus/WebSocketBus.js';
import { addToast } from './toastStore.js';
import { playMessageSound } from '../lib/sound.js';
import {
  activeChatId,
  setActiveChatId,
  setPendingChatId,
  activeCharacterId,
  setActiveCharacterId,
  activePersonaId,
  setActivePersonaId,
  activeWorldInfoId,
  setActiveWorldInfoId,
  activeBackendConfigId,
  setActiveBackendConfigId,
  activePromptListId,
  setActivePromptListId,
} from './uiStore.js';

interface GenerationState {
  activeId: string | null;
  chatId: string | null;
  targetMessageId: number | null;
  streamingText: string;
  streamingReasoning: string;
  impersonationDraft: string;
  status: 'idle' | 'streaming' | 'error';
}

export interface ServerState {
  clientId: string;
  characters: CharacterSummary[];
  chats: ChatSummary[];
  messages: Record<string, Message[]>; // chatId -> loaded messages
  swipes: Record<string, Message[]>; // chatId -> all swipe siblings for current head
  chatMembers: Record<string, ChatMemberSummary[]>; // chatId -> members
  settings: AppSettings;
  worldInfo: WorldInfo[];
  personas: PersonaSummary[];
  backendConfigs: BackendConfigSummary[];
  promptLists: PromptListSummary[];
  quickReplies: QuickReply[];
  tools: ToolInfo[];
  toolsets: Toolset[];
  toolTemplates: ToolTemplate[];
  customBackends: CustomBackend[];
  activeChat: Chat | null;
  activeCharacter: Character | null;
  chatCharacter: Character | null;
  activePersona: Persona | null;
  /** Persona bound to the current chat (snapshot-only, mirrors chatCharacter). Separate from activePersona, which is the editor slot. */
  chatPersona: Persona | null;
  activeWorldInfo: WorldInfo | null;
  activeBackendConfig: BackendConfig | null;
  /** clientId of the client whose message last wrote activeBackendConfig (null = unknown/server-pushed). Lets editors treat their own save round-trips as no-ops. */
  activeBackendConfigOrigin: string | null;
  activePromptList: PromptList | null;
  /** Resolved greeting text for the active empty chat (server-expanded macros). */
  greeting: string | null;
  /** Pre-rendered HTML for the greeting. */
  greetingHtml: string | null;
  generation: GenerationState;
}

const [state, setState] = createStore<ServerState>({
  clientId: '',
  characters: [],
  chats: [],
  messages: {},
  swipes: {},
  chatMembers: {},
  settings: AppSettingsSchema.parse({}),
  worldInfo: [],
  personas: [],
  backendConfigs: [],
  promptLists: [],
  quickReplies: [],
  tools: [],
  toolsets: [],
  toolTemplates: [],
  customBackends: [],
  generation: {
    activeId: null,
    chatId: null,
    targetMessageId: null,
    streamingText: '',
    streamingReasoning: '',
    impersonationDraft: '',
    status: 'idle',
  },
  activeChat: null,
  activeCharacter: null,
  chatCharacter: null,
  activePersona: null,
  chatPersona: null,
  activeWorldInfo: null,
  activeBackendConfig: null,
  activeBackendConfigOrigin: null,
  activePromptList: null,
  greeting: null,
  greetingHtml: null,
});

export { state, setState };

/** Project a full Chat to the lightweight ChatSummary shape used by the sidebar list. */
function toChatSummary(chat: Chat): ChatSummary {
  return {
    id: chat.id,
    characterId: chat.characterId,
    name: chat.name,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    forkedFromChatId: chat.forkedFromChatId,
    forkedAtMessageId: chat.forkedAtMessageId,
  };
}

// Wire bus messages into the store

bus.on('client.assigned', (msg) => {
  setState('clientId', msg.clientId);
});

bus.on('snapshot', (msg) => {
  const chats = msg.state.chats;
  const settings = msg.state.settings;
  const autoLoad = settings['autoLoadLastChat'] === true;
  const lastChatId = typeof settings['lastChatId'] === 'string' ? settings['lastChatId'] : '';
  if (autoLoad && lastChatId && chats.some((c) => c.id === lastChatId)) {
    setActiveChatId(lastChatId);
  }

  setState(
    produce((s) => {
      s.characters = msg.state.characters;
      s.chats = chats;
      s.settings = settings;
      s.personas = msg.state.personas ?? [];
      s.backendConfigs = msg.state.backendConfigs ?? [];
      s.promptLists = msg.state.promptLists ?? [];
      s.tools = msg.state.tools ?? [];
      s.toolsets = msg.state.toolsets ?? [];
      s.toolTemplates = msg.state.toolTemplates ?? [];
      s.activeBackendConfig = null;
      s.activePromptList = null;

      // Restore active generation for reconnecting clients
      if (msg.state.generation) {
        s.generation = {
          activeId: msg.state.generation.id,
          chatId: msg.state.generation.chatId,
          targetMessageId: msg.state.generation.messageId,
          streamingText: msg.state.generation.text,
          streamingReasoning: msg.state.generation.reasoning ?? '',
          impersonationDraft: '',
          status: 'streaming',
        };
      }
    }),
  );
});

bus.on('character.listed', (msg) => {
  setState('characters', msg.characters);
});

bus.on('character.snapshot', (msg) => {
  if (msg.character.id !== activeCharacterId()) return;
  setState('activeCharacter', msg.character);
});

bus.on('character.updated', (msg) => {
  setState('activeCharacter', (c) => (c?.id === msg.character.id ? msg.character : c));
  setState('chatCharacter', (c) => (c?.id === msg.character.id ? msg.character : c));
});

bus.on('character.deleted', (msg) => {
  if (activeCharacterId() === msg.characterId) setActiveCharacterId(null);
  setState('activeCharacter', (c) => (c?.id === msg.characterId ? null : c));
});

// Sidebar lists are driven by `.listed` rebroadcasts only (AGENTS.md §5) — the server
// rebroadcasts `chat.listed` after every create/fork. `.created`/`.forked` carry the full
// object for the pending-chat flow, not for list mutation.
bus.on('chat.created', (msg) => {
  if (msg.clientId === state.clientId) {
    setPendingChatId(msg.chat.id);
  }
});

bus.on('chat.forked', (msg) => {
  if (msg.clientId === state.clientId) {
    setPendingChatId(msg.chat.id);
  }
});

bus.on('chat.listed', (msg) => {
  setState('chats', msg.chats);
});

bus.on('chat.updated', (msg) => {
  if (!state.chats.some((c) => c.id === msg.chat.id)) return;
  // Replace the whole object — never merge (AGENTS.md §5). The server broadcasts
  // the full Chat; project to ChatSummary for the sidebar and replace activeChat.
  setState('chats', (chats) => chats.map((c) => (c.id === msg.chat.id ? toChatSummary(msg.chat) : c)));
  setState('activeChat', (chat) => (chat?.id === msg.chat.id ? msg.chat : chat));
  if (msg.chat.id === activeChatId()) {
    setState('greeting', null);
    setState('greetingHtml', null);
  }
});

bus.on('chat.deleted', (msg) => {
  const wasActive = activeChatId() === msg.chatId;
  setState('chats', (chats) => chats.filter((c) => c.id !== msg.chatId));
  setState('activeChat', (chat) => (chat?.id === msg.chatId ? null : chat));
  setState('chatCharacter', (c) => (c && wasActive ? null : c));
  setState('chatPersona', (p) => (p && wasActive ? null : p));
  if (wasActive) {
    setState('greeting', null);
    setState('greetingHtml', null);
  }
  setState(
    produce((s) => {
      delete s.messages[msg.chatId];
      delete s.swipes[msg.chatId];
      delete s.chatMembers[msg.chatId];
    }),
  );
  if (wasActive) setActiveChatId(null);
});

bus.on('chat.snapshot', (msg) => {
  if (msg.chat.id !== activeChatId()) return;
  setState('activeChat', msg.chat);
  setState('messages', msg.chat.id, msg.messages);
  setState('swipes', msg.chat.id, msg.swipes ?? []);
  setState('chatCharacter', msg.character ?? null);
  setState('chatPersona', msg.persona ?? null);
  setState('greeting', msg.greeting ?? null);
  setState('greetingHtml', msg.greetingHtml ?? null);
});

bus.on('messages.loaded', (msg) => {
  if (msg.chatId !== activeChatId()) return;
  // Prepend older messages
  setState('messages', msg.chatId, (existing = []) => [...msg.messages, ...existing]);
});

bus.on('message.appended', (msg) => {
  if (msg.chatId !== activeChatId()) return;
  setState('messages', msg.chatId, (msgs = []) => {
    if (msgs.some((m) => m.id === msg.message.id)) return msgs;
    return [...msgs, msg.message];
  });
  // If the message is a child of the current head, it's a swipe/active child.
  const chat = state.activeChat;
  const headId = chat?.headMessageId ?? null;
  if (msg.message.parentId === headId && msg.message.id !== headId && headId !== null) {
    setState('swipes', msg.chatId, (swipes = []) => {
      if (swipes.some((m) => m.id === msg.message.id)) return swipes;
      return [...swipes, msg.message];
    });
  }
  setState('greeting', null);
  setState('greetingHtml', null);
});

bus.on('message.snapshot', (msg) => {
  if (msg.chatId !== activeChatId()) return;
  const replacer = (m: (typeof state.messages)[string][0]) => (m.id === msg.message.id ? msg.message : m);
  setState('messages', msg.chatId, (msgs = []) => msgs.map(replacer));
  setState('swipes', msg.chatId, (swipes = []) => swipes.map(replacer));
});

bus.on('message.deleted', (msg) => {
  if (msg.chatId !== activeChatId()) return;
  setState('messages', msg.chatId, (msgs = []) => msgs.filter((m) => m.id !== msg.messageId));
  setState('swipes', msg.chatId, (swipes = []) => swipes.filter((s) => s.id !== msg.messageId));
  // Clear stale pointers so the UI doesn't reference a gone message
  // until the server broadcasts the updated chat snapshot.
  if (state.activeChat && state.activeChat.id === msg.chatId) {
    if (state.activeChat.headMessageId === msg.messageId) {
      setState('activeChat', 'headMessageId', null);
    }
    if (state.activeChat.activeChildId === msg.messageId) {
      setState('activeChat', 'activeChildId', null);
    }
  }
});

// Smooth streaming token queue
const tokenQueue: Array<{ type: 'text' | 'reasoning'; token: string }> = [];
let smoothTimer: ReturnType<typeof setInterval> | null = null;

function applyQueuedToken(item: (typeof tokenQueue)[0]) {
  if (item.type === 'text') {
    setState('generation', 'streamingText', (t) => t + item.token);
  } else {
    setState('generation', 'streamingReasoning', (t) => t + item.token);
  }
}

function flushTokenQueue() {
  let item = tokenQueue.shift();
  while (item) {
    applyQueuedToken(item);
    item = tokenQueue.shift();
  }
  if (smoothTimer) {
    clearInterval(smoothTimer);
    smoothTimer = null;
  }
}

function startSmoothDrain() {
  if (smoothTimer) return;
  const delay = Math.max(5, Number(state.settings['smoothStreamingDelay']));
  smoothTimer = setInterval(() => {
    const item = tokenQueue.shift();
    if (item) applyQueuedToken(item);
    if (tokenQueue.length === 0 && smoothTimer) {
      clearInterval(smoothTimer);
      smoothTimer = null;
    }
  }, delay);
}

function queueToken(type: 'text' | 'reasoning', token: string) {
  const smooth = Boolean(state.settings['smoothStreaming']);
  if (!smooth) {
    applyQueuedToken({ type, token });
    return;
  }
  tokenQueue.push({ type, token });
  startSmoothDrain();
}

bus.on('generation.started', (msg) => {
  if (msg.chatId !== activeChatId()) return;
  flushTokenQueue();
  setState('generation', {
    activeId: msg.generationId,
    chatId: msg.chatId,
    targetMessageId: msg.messageId ?? null,
    streamingText: '',
    streamingReasoning: '',
    impersonationDraft: '',
    status: 'streaming',
  });
});

bus.on('generation.token', (msg) => {
  const chatId = state.generation.chatId;
  if (chatId !== activeChatId() || chatId === null) return;
  queueToken('text', msg.token);
});

bus.on('generation.reasoningToken', (msg) => {
  const chatId = state.generation.chatId;
  if (chatId !== activeChatId() || chatId === null) return;
  queueToken('reasoning', msg.token);
});

bus.on('generation.done', () => {
  flushTokenQueue();
  if (state.settings['messageSoundEnabled']) {
    const unfocusedOnly = state.settings['messageSoundUnfocusedOnly'] !== false;
    const isUnfocused = typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
    if (!unfocusedOnly || isUnfocused) {
      playMessageSound();
    }
  }
  setState('generation', {
    activeId: null,
    chatId: null,
    targetMessageId: null,
    streamingText: '',
    streamingReasoning: '',
    impersonationDraft: '',
    status: 'idle',
  });
});

bus.on('generation.aborted', () => {
  flushTokenQueue();
  setState('generation', {
    activeId: null,
    chatId: null,
    targetMessageId: null,
    streamingText: '',
    streamingReasoning: '',
    impersonationDraft: '',
    status: 'idle',
  });
});

bus.on('generation.error', (msg) => {
  flushTokenQueue();
  console.error('[generation] Error:', msg.error);
  setState('generation', {
    activeId: null,
    chatId: null,
    targetMessageId: null,
    streamingText: '',
    streamingReasoning: '',
    impersonationDraft: '',
    status: 'idle',
  });
  addToast(msg.error, 'error');
});

bus.on('impersonation.complete', (msg) => {
  if (state.generation.chatId !== activeChatId()) return;
  setState('generation', 'impersonationDraft', msg.text);
});

bus.on('error', (msg) => {
  console.error('[ws] Error:', msg.message);
  addToast(msg.message, 'error');
});

bus.on('settings.changed', (msg) => {
  // Validate against the known AppSettings fields — unknown keys (catchall
  // forward-compat from a newer server) and invalid values are ignored.
  const fieldSchema = (AppSettingsSchema.shape as Record<string, z.ZodTypeAny>)[msg.key];
  if (!fieldSchema) {
    console.debug(`[settings] ignoring unknown key '${msg.key}'`);
    return;
  }
  const parsed = fieldSchema.safeParse(msg.value);
  if (!parsed.success) {
    console.debug(`[settings] ignoring invalid value for '${msg.key}':`, parsed.error.flatten());
    return;
  }
  setState(
    'settings',
    produce((s) => {
      (s as Record<string, unknown>)[msg.key] = parsed.data;
    }),
  );
});

bus.on('settings.loaded', (msg) => {
  setState('settings', msg.settings);
});

bus.on('worldinfo.listed', (msg) => {
  setState('worldInfo', msg.books);
});

bus.on('worldinfo.snapshot', (msg) => {
  if (msg.book.id !== activeWorldInfoId()) return;
  setState('activeWorldInfo', msg.book);
});

bus.on('worldinfo.updated', (msg) => {
  setState('activeWorldInfo', (b) => (b?.id === msg.book.id ? msg.book : b));
});

bus.on('worldinfo.deleted', (msg) => {
  if (activeWorldInfoId() === msg.bookId) setActiveWorldInfoId(null);
  setState('activeWorldInfo', (b) => (b?.id === msg.bookId ? null : b));
});

bus.on('persona.listed', (msg) => {
  setState('personas', msg.personas);
});

bus.on('persona.snapshot', (msg) => {
  if (msg.persona.id !== activePersonaId()) return;
  setState('activePersona', msg.persona);
});

bus.on('persona.updated', (msg) => {
  setState('activePersona', (p) => (p?.id === msg.persona.id ? msg.persona : p));
});

bus.on('persona.deleted', (msg) => {
  if (activePersonaId() === msg.personaId) setActivePersonaId(null);
  setState('activePersona', (p) => (p?.id === msg.personaId ? null : p));
});

bus.on('backendConfig.listed', (msg) => {
  setState('backendConfigs', msg.backendConfigs);
});

bus.on('backendConfig.snapshot', (msg) => {
  if (msg.backendConfig.id !== activeBackendConfigId()) return;
  setState('activeBackendConfig', msg.backendConfig);
  setState('activeBackendConfigOrigin', msg.clientId ?? null);
});

bus.on('backendConfig.updated', (msg) => {
  if (state.activeBackendConfig?.id !== msg.backendConfig.id) return;
  setState('activeBackendConfig', msg.backendConfig);
  setState('activeBackendConfigOrigin', msg.clientId ?? null);
});

bus.on('backendConfig.deleted', (msg) => {
  const wasActive = activeBackendConfigId() === msg.backendConfigId;
  setState('activeBackendConfig', (b) => (b?.id === msg.backendConfigId ? null : b));
  if (wasActive) {
    const fallbackId = state.settings['activeBackendConfigId'];
    if (fallbackId && fallbackId !== msg.backendConfigId) {
      setActiveBackendConfigId(String(fallbackId));
      bus.send({ type: 'backendConfig.select', backendConfigId: String(fallbackId) });
    } else {
      setActiveBackendConfigId(null);
    }
  }
});

bus.on('promptList.listed', (msg) => {
  setState('promptLists', msg.promptLists);
});

bus.on('promptList.snapshot', (msg) => {
  if (msg.promptList.id !== activePromptListId()) return;
  setState('activePromptList', msg.promptList);
});

bus.on('promptList.updated', (msg) => {
  setState('activePromptList', (p) => (p?.id === msg.promptList.id ? msg.promptList : p));
});

bus.on('promptList.deleted', (msg) => {
  const wasActive = activePromptListId() === msg.promptListId;
  setState('activePromptList', (p) => (p?.id === msg.promptListId ? null : p));
  if (wasActive) {
    const fallbackId = state.settings['activePromptListId'];
    if (fallbackId && fallbackId !== msg.promptListId) {
      setActivePromptListId(String(fallbackId));
      bus.send({ type: 'promptList.select', promptListId: String(fallbackId) });
    } else {
      setActivePromptListId(null);
    }
  }
});

bus.on('quickreply.listed', (msg) => {
  setState('quickReplies', msg.items);
});

bus.on('quickreply.updated', (msg) => {
  if (!state.quickReplies.some((qr) => qr.id === msg.item.id)) return;
  setState('quickReplies', (list) => list.map((qr) => (qr.id === msg.item.id ? msg.item : qr)));
});

bus.on('quickreply.deleted', (msg) => {
  setState('quickReplies', (list) => list.filter((qr) => qr.id !== msg.id));
});

bus.on('toolset.listed', (msg) => {
  // Wholesale replace — never merge (AGENTS.md §5). The server is canonical for ordering and
  // the full object; merging previously let deleted config keys survive on the client.
  // reconcile still matches the source exactly (absent keys are dropped) but preserves
  // object identity for unchanged items, so <For> rows don't remount on every echo.
  setState('toolsets', reconcile(msg.toolsets));
});

bus.on('toolset.updated', (msg) => {
  const idx = state.toolsets.findIndex((t) => t.id === msg.toolset.id);
  if (idx === -1) return;
  // Replace the whole object — the server broadcasts the full toolset (AGENTS.md §5).
  setState('toolsets', idx, reconcile(msg.toolset));
});

bus.on('toolset.deleted', (msg) => {
  setState(
    'toolsets',
    produce((list) => {
      const idx = list.findIndex((t) => t.id === msg.toolsetId);
      if (idx !== -1) list.splice(idx, 1);
    }),
  );
});

bus.on('custombackend.listed', (msg) => {
  // Wholesale replace — never merge (AGENTS.md §5). The server rebroadcasts the
  // full list after every mutation, so it is canonical for ordering and content.
  setState('customBackends', msg.items);
});

bus.on('custombackend.created', (msg) => {
  setState('customBackends', (list) =>
    list.some((b) => b.id === msg.item.id) ? list : [...list, msg.item],
  );
});

bus.on('custombackend.updated', (msg) => {
  setState('customBackends', (list) =>
    list.some((b) => b.id === msg.item.id)
      ? list.map((b) => (b.id === msg.item.id ? msg.item : b))
      : [...list, msg.item],
  );
});

bus.on('custombackend.deleted', (msg) => {
  setState('customBackends', (list) => list.filter((b) => b.id !== msg.id));
});

bus.on('toolTemplate.listed', (msg) => {
  // Wholesale replace — never merge (AGENTS.md §5). reconcile keeps the store
  // structurally identical to the source while preserving object identity for
  // unchanged items, so <For> rows don't remount on every echo.
  setState('toolTemplates', reconcile(msg.toolTemplates));
});

bus.on('toolTemplate.updated', (msg) => {
  const idx = state.toolTemplates.findIndex((t) => t.id === msg.toolTemplate.id);
  if (idx === -1) return;
  // Replace the whole object — the server broadcasts the full tool template (AGENTS.md §5).
  setState('toolTemplates', idx, reconcile(msg.toolTemplate));
});

bus.on('toolTemplate.deleted', (msg) => {
  setState(
    'toolTemplates',
    produce((list) => {
      const idx = list.findIndex((t) => t.id === msg.toolTemplateId);
      if (idx !== -1) list.splice(idx, 1);
    }),
  );
});

bus.on('script.toast', (msg) => {
  const level = typeof msg.level === 'string' ? msg.level : 'info';
  const type =
    level === 'error' ? 'error' :
    level === 'success' ? 'success' :
    level === 'warning' ? 'warning' :
    'info';
  addToast(msg.message, type);
});

bus.on('script.error', (msg) => {
  console.error('[script] Error:', msg.message);
  addToast(msg.message, 'error');
});

// Group chat members
bus.on('group.members', (msg) => {
  if (msg.chatId !== activeChatId()) return;
  setState('chatMembers', msg.chatId, msg.members);
});

bus.on('group.member.added', (msg) => {
  if (msg.chatId !== activeChatId()) return;
  setState('chatMembers', msg.chatId, (members = []) => [...members, msg.member]);
});

bus.on('group.member.updated', (msg) => {
  if (msg.chatId !== activeChatId()) return;
  const members = state.chatMembers[msg.chatId] ?? [];
  if (!members.some((m) => m.characterId === msg.member.characterId)) return;
  setState('chatMembers', msg.chatId, (prev = []) =>
    prev.map((m) => (m.characterId === msg.member.characterId ? msg.member : m)),
  );
});

bus.on('group.member.removed', (msg) => {
  if (msg.chatId !== activeChatId()) return;
  setState('chatMembers', msg.chatId, (members = []) => members.filter((m) => m.characterId !== msg.characterId));
});

// Auto-connect on import
bus.connect();
