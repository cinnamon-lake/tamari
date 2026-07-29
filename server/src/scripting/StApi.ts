/**
 * The `st` API injected into every Lua runtime.
 *
 * All functions are synchronous or return Promises that the LuaRuntime
 * awaits before resuming the coroutine.
 */

import type { EventBus } from '../bus/EventBus.js';
import { str } from '../lib/coerce.js';
import type { ScriptGenerationApi } from './ScriptGenerationApi.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { IChatMemberRepository } from '../repos/ChatMemberRepository.js';
import type { IExtensionDataRepository } from '../repos/ExtensionDataRepository.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { IWorldInfoRepository } from '../repos/WorldInfoRepository.js';
import type { ScriptContext } from './ScriptContext.js';
import { performSwipe } from '../lib/swipe.js';
import { toChatSummary } from '../lib/summaries.js';
import { tokenCounterProvider } from '../tokenizers/TokenCounter.js';
import { getChatSnapshotMessages } from '../lib/swipeInfo.js';
import { getMessageText } from '@tamari/types';
import { MacroResolver } from '../pipeline/MacroResolver.js';
import { createCharacter, updateCharacter } from '../services/characterMutations.js';
import { materializeGreetings } from '../lib/greetings.js';
import { addChatMember, removeChatMember } from '../services/chatMembership.js';
import type { ContentPart, Message, MessageRole } from '@tamari/types';

export interface StApiDeps {
  generationService: ScriptGenerationApi;
  chats: IChatRepository;
  characters: ICharacterRepository;
  personas: IPersonaRepository;
  settings: ISettingsRepository;
  backendConfigs: IBackendConfigRepository;
  worldInfo: IWorldInfoRepository;
  chatMembers: IChatMemberRepository;
  extensionData: IExtensionDataRepository;
  bus: EventBus;
  clientId: string;
  chatBroadcast: import('../services/ChatBroadcastService.js').ChatBroadcastService;
  chatMetaBroadcast: import('../services/ChatMetaBroadcastService.js').ChatMetaBroadcastService;
}

/** Message shape marshalled to Lua (`content` is the flattened text of `extra.parts`). */
export interface LuaMessage {
  id: number;
  parentId: number | null;
  role: MessageRole;
  content: string;
  extra: Message['extra'];
  createdAt: number;
}

/** Branch fetch limit used when an operation needs the entire active branch — the "all messages" sentinel. */
const FULL_BRANCH_MESSAGE_LIMIT = 10000;

function toLuaMessage(m: Message): LuaMessage {
  return {
    id: m.id,
    parentId: m.parentId,
    role: m.role,
    content: getMessageText(m.extra.parts),
    extra: m.extra,
    createdAt: m.createdAt,
  };
}

/** Chat shape marshalled to Lua by `get_chat`. */
export interface LuaChatInfo {
  id: string;
  name: string;
  characterId: string | null;
  headMessageId: number | null;
  metadata: Record<string, unknown>;
}

/** Chat list-item shape marshalled to Lua by `get_chats`. */
export interface LuaChatListItem {
  id: string;
  name: string;
  characterId: string | null;
  personaId: string | null;
  headMessageId: number | null;
  activeChildId: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Character summary shape marshalled to Lua by `get_characters`/`find_character`. */
export interface LuaCharacterSummary {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
}

/** Full character shape marshalled to Lua by `get_character`. */
export interface LuaCharacter extends LuaCharacterSummary {
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  extensions: unknown;
}

/** Persona shape marshalled to Lua by `get_personas`/`get_persona`. */
export interface LuaPersona {
  id: string;
  name: string;
  description: string;
}

/** Backend-config summary shape marshalled to Lua by `get_backend_configs`. */
export interface LuaBackendConfigSummary {
  id: string;
  name: string;
  backendProvider: string;
  model: string;
}

/** Full backend-config shape marshalled to Lua by `get_backend_config`. */
export interface LuaBackendConfig extends LuaBackendConfigSummary {
  generationMode: string;
  apiUrl: string | null;
  temperature: number | null;
  maxTokens: number | null;
  contextLength: number | null;
  instructTemplate: string;
  stopStrings: string[];
}

/**
 * `get_generation_info` result. Historically snake_case keys; the camelCase
 * duplicates were added later for consistency with the rest of the API — both
 * sets are returned (additive, non-breaking).
 */
export interface LuaGenerationInfo {
  model: unknown;
  token_count: unknown;
  tokenCount: unknown;
  generation_time: unknown;
  generationTime: unknown;
  api: unknown;
}

/**
 * The `st` API surface injected into every Lua runtime. Declared as a type
 * alias (not an interface) so values remain assignable to
 * `Record<string, unknown>` at the wasmoon marshalling boundary. Types are
 * pragmatic where values cross into Lua (`unknown` for arbitrary tables),
 * but names, arity, and return shapes are real.
 *
 * Naming convention: snake_case is canonical. The camelCase hybrids
 * (`get_characterId`, `get_personaId`, `get_characterName`,
 * `set_systemPrompt`, `get_systemPrompt`) are deprecated aliases kept for
 * backward compatibility with shipped user scripts.
 */
export type StApi = {
  // --- Chat actions ---
  send(text: string): Promise<void>;
  continue(): Promise<void>;
  impersonate(): Promise<void>;
  regenerate(): Promise<void>;
  swipe(direction: string): Promise<void>;
  cut(count: number): Promise<void>;
  edit(messageId: number, content: string): Promise<void>;
  delete(messageId: number): Promise<void>;
  hide(messageId: number): Promise<void>;
  unhide(messageId: number): Promise<void>;
  stop(): Promise<void>;
  reset_chat(): Promise<void>;

  // --- Queries ---
  get_messages(limit?: number): Promise<LuaMessage[]>;
  get_chat(): Promise<LuaChatInfo | null>;
  get_characters(): Promise<LuaCharacterSummary[]>;
  find_character(name: string): Promise<LuaCharacterSummary | null>;
  get_character(id: string): Promise<LuaCharacter | null>;
  get_personas(): Promise<LuaPersona[]>;
  get_persona(id: string): Promise<LuaPersona | null>;
  set_persona(personaId: string): Promise<void>;
  new_chat(name?: string): Promise<string>;
  trigger(): Promise<void>;
  set_character(characterId: string): Promise<void>;
  get_character_id(): Promise<string | null>;
  /** @deprecated Use `get_character_id`. */
  get_characterId?(): Promise<string | null>;
  create_character(data: unknown): Promise<{ id: string; name: string }>;
  update_character(characterId: string, patch: unknown): Promise<void>;
  add_chat_member(characterId: string): Promise<void>;
  remove_chat_member(characterId: string): Promise<void>;
  get_persona_id(): Promise<string | null>;
  /** @deprecated Use `get_persona_id`. */
  get_personaId?(): Promise<string | null>;
  branch(messageId: number, name?: string): Promise<string>;
  checkpoint(name?: string): Promise<string>;
  set_author_note(
    content: string,
    opts?: { depth?: number; interval?: number; position?: string; role?: string },
  ): Promise<void>;
  get_author_note(): Promise<Record<string, unknown> | null>;
  get_setting(key: string): Promise<unknown>;
  set_setting(key: string, value: unknown): Promise<void>;
  get_settings(): Promise<Record<string, unknown>>;
  get_backend_configs(): Promise<LuaBackendConfigSummary[]>;
  get_backend_config(id: string): Promise<LuaBackendConfig | null>;
  set_system_prompt(characterId: string, text: string): Promise<void>;
  /** @deprecated Use `set_system_prompt`. */
  set_systemPrompt?(characterId: string, text: string): Promise<void>;
  get_system_prompt(characterId: string): Promise<string | null>;
  /** @deprecated Use `get_system_prompt`. */
  get_systemPrompt?(characterId: string): Promise<string | null>;
  set_backend_config(id: string): Promise<void>;
  get_model(): Promise<string>;
  set_model(model: string): Promise<void>;
  get_apiUrl(): Promise<string>;
  set_apiUrl(url: string): Promise<void>;
  get_temperature(): Promise<number>;
  set_temperature(value: number): Promise<void>;
  get_maxTokens(): Promise<number>;
  set_maxTokens(value: number): Promise<void>;
  get_contextLength(): Promise<number>;
  set_contextLength(value: number): Promise<void>;
  get_backend(): Promise<string>;
  set_backend(provider: string): Promise<void>;
  get_reasoning(messageId: number): Promise<unknown>;
  set_reasoning(messageId: number, text: string): Promise<void>;
  clear_reasoning(messageId: number): Promise<void>;
  get_generation_info(messageId: number): Promise<LuaGenerationInfo | null>;

  // --- Variables ---
  setvar(name: string, value: unknown): Promise<void>;
  getvar(name: string): Promise<unknown>;
  clear_variables(): Promise<void>;
  get_variables(): Promise<Record<string, unknown>>;

  // --- Meta state (out-of-fiction; does NOT fork with branches) ---
  set_state(namespace: string, data: unknown): Promise<void>;
  get_state(namespace: string): Promise<unknown>;
  set_global_state(namespace: string, data: unknown): Promise<void>;
  get_global_state(namespace: string): Promise<unknown>;
  delete_state(namespace: string): Promise<void>;

  // --- UI ---
  toast(message: string, level?: string): void;
  sleep(seconds: number): Promise<void>;
  generate(prompt: string, opts?: { maxTokens?: number; temperature?: number } | null): Promise<string>;
  send_as(name: string, content: string): Promise<number>;
  send_narrator(name: string, content?: string): Promise<number>;
  comment(content: string): Promise<number>;
  set_message_role(messageId: number, role: string): Promise<void>;
  delay(ms: number): Promise<void>;
  rename_chat(name: string): Promise<void>;
  delete_chat(): Promise<void>;

  // --- Message queries ---
  get_message_by_id(messageId: number): Promise<LuaMessage | null>;
  get_message_count(): Promise<number>;
  get_last_message(): Promise<LuaMessage | null>;
  get_chat_name(): Promise<string | null>;
  get_character_name(): Promise<string | null>;
  /** @deprecated Use `get_character_name`. */
  get_characterName?(): Promise<string | null>;
  set_chat_metadata(key: string, value: unknown): Promise<void>;
  get_chat_metadata(key: string): Promise<unknown>;
  get_chats(characterId?: string): Promise<LuaChatListItem[]>;
  hard_fork(messageId: number, name?: string): Promise<string>;
  get_message_at(index: number): Promise<LuaMessage | null>;
  get_message_index(messageId: number): Promise<number | null>;
  temp_chat(name?: string): Promise<string>;
  get_children(messageId: number): Promise<LuaMessage[]>;
  get_message_chain(messageId: number): Promise<LuaMessage[]>;
  get_swipes(): Promise<LuaMessage[]>;
  get_siblings(messageId: number): Promise<LuaMessage[]>;
  repair_active_child(): Promise<void>;

  // --- Utilities ---
  token_count(text: string): number;
  count_tokens(text: string): number;
  upper(text: string): string;
  lower(text: string): string;
  trim_tokens(text: string, limit: number): string;
  replace(text: string, search: string, replacement: string): string;
  replace_regex(text: string, pattern: string, replacement: string): string;
  match(text: string, pattern: string): string[];
  test(text: string, pattern: string): boolean;
  substring(text: string, start: number, end?: number): string;
  trim_start(text: string): string;
  trim_end(text: string): string;
  random(min?: number, max?: number): number;
  now(): number;
  set_message_extra(messageId: number, key: string, value: unknown): Promise<void>;
  get_message_extra(messageId: number, key: string): Promise<unknown>;
  array_wrap(value: unknown): unknown[];
  array_unwrap(arr: unknown[]): unknown;
  pass(value: unknown): unknown;
  is_empty(value: unknown): boolean;
  len(value: unknown): number;
  join(arr: unknown[], separator?: string): string;
  split(text: string, separator?: string): string[];
  includes(text: string, search: string): boolean;
  starts_with(text: string, prefix: string): boolean;
  ends_with(text: string, suffix: string): boolean;
  json_encode(value: unknown): string;
  json_decode(text: string): unknown;
  abs(n: number): number;
  floor(n: number): number;
  ceil(n: number): number;
  round(n: number): number;
  clamp(n: number, min: number, max: number): number;
  find_message_by_content(search: string): Promise<LuaMessage | null>;
  find_messages_by_role(role: string): Promise<LuaMessage[]>;
  messages_as_text(separator?: string): Promise<string>;
  get_message_texts(): Promise<string[]>;
  get_head(): Promise<LuaMessage | null>;
  get_active_child(): Promise<LuaMessage | null>;
  tag_add(characterId: string, tag: string): Promise<void>;
  tag_remove(characterId: string, tag: string): Promise<void>;
  tag_list(characterId: string): Promise<string[]>;

  // --- World Info ---
  wi_list(): Promise<unknown[]>;
  wi_get(key: string): Promise<unknown>;
  wi_add(keys: string, content: string): Promise<string>;
  wi_remove(key: string): Promise<boolean>;

  add_swipe(content: string, switchTo?: boolean): Promise<number>;
  set_active_child(messageId: number): Promise<void>;
  substitute_macros(text: string): Promise<string>;

  // --- Slash-command parity: inject, genraw, ask, sysgen ---
  inject(text: string): Promise<void>;
  flush_inject(): Promise<void>;
  genraw(prompt: string): Promise<void>;
  ask(characterName: string, content: string): Promise<void>;
  sysgen(content: string): Promise<void>;
};

export function createStApi(ctx: ScriptContext, deps: StApiDeps): StApi {
  const { generationService, chats, characters, personas, settings, backendConfigs, worldInfo, chatMembers, extensionData, bus, clientId, chatBroadcast, chatMetaBroadcast } = deps;
  const chatId = ctx.chatId;

  async function getCharacterBookId(): Promise<string | null> {
    const chat = await chats.getChatById(chatId);
    if (!chat || !chat.characterId) return null;
    const character = await characters.getById(chat.characterId);
    return character?.worldInfoId ?? null;
  }

  function varKey(name: string): string {
    return `lua.var.${chatId}.${name}`;
  }

  function checkAbort(): void {
    if (ctx.aborted) {
      throw new Error('Script aborted');
    }
  }

  /**
   * First real message in an unmaterialized chat: materialize the greeting
   * first (the UI does the same before sending), otherwise the appended
   * message lands on an empty branch and the client keeps showing only the
   * virtual greeting.
   */
  async function ensureChatMaterialized(): Promise<void> {
    const chat = await chats.getChatById(chatId);
    if (chat && !chat.materialized && chat.characterId) {
      const character = await characters.getById(chat.characterId);
      if (character) {
        const selectedIndex = Number(chat.metadata.selectedGreetingIndex ?? 0);
        const settingsUserName = (await settings.get('userName')) as string | undefined;
        await materializeGreetings(
          { bus, chats, chatBroadcast, personas, userName: settingsUserName },
          chatId,
          character,
          selectedIndex,
        );
      }
    }
  }

  function validateNamespace(fn: string, namespace: unknown): string {
    if (typeof namespace !== 'string' || namespace.length === 0 || namespace.length > 100) {
      throw new Error(`${fn}: expected non-empty namespace string (max 100 chars)`);
    }
    return namespace;
  }

  const api: StApi = {
    // --- Chat actions ---

    send: async (text: string) => {
      checkAbort();
      if (typeof text !== 'string') throw new Error('send: expected string');
      await generationService.handleSend(chatId, text, undefined, ctx.id);
    },

    continue: async () => {
      checkAbort();
      await generationService.handleContinue(chatId, ctx.id);
    },

    impersonate: async () => {
      checkAbort();
      await generationService.handleImpersonate(chatId, ctx.id);
    },

    regenerate: async () => {
      checkAbort();
      await generationService.handleRegenerate(chatId, undefined, ctx.id);
    },

    swipe: async (direction: string) => {
      checkAbort();
      if (direction !== 'left' && direction !== 'right') {
        throw new Error('swipe: expected "left" or "right"');
      }
      await performSwipe({ bus, chats, chatMetaBroadcast }, chatId, direction);
    },

    cut: async (count: number) => {
      checkAbort();
      const n = Math.max(1, Math.floor(Number(count) || 1));
      const { deletedIds } = await chats.cutMessages(chatId, n);
      for (const id of deletedIds) {
        chatMetaBroadcast.broadcastMessageDeleted(chatId, id);
      }
      const updatedChat = await chats.getChatById(chatId);
      if (updatedChat) {
        chatMetaBroadcast.broadcastChatUpdated(updatedChat);
        // headMessageId changed (trunk) → refresh messages via snapshot.
        await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
      }
    },

    edit: async (messageId: number, content: string) => {
      checkAbort();
      if (typeof messageId !== 'number' || typeof content !== 'string') {
        throw new Error('edit: expected (number, string)');
      }
      const existing = await chats.getMessageById(messageId);
      const existingParts = existing?.extra.parts ?? [];
      let replaced = false;
      const newParts: ContentPart[] = existingParts.map((p) => {
        if (p.type === 'text' && !replaced) {
          replaced = true;
          return { type: 'text', text: content };
        }
        return p;
      });
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- TS does not track mutation inside .map() closures
      if (!replaced) {
        newParts.push({ type: 'text', text: content });
      }
      const extra = { ...(existing?.extra ?? {}), editedAt: Math.floor(Date.now() / 1000), parts: newParts };
      const updated = await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, updated.id);
    },

    delete: async (messageId: number) => {
      checkAbort();
      await chats.deleteMessage(messageId);
      chatMetaBroadcast.broadcastMessageDeleted(chatId, messageId);
    },

    hide: async (messageId: number) => {
      checkAbort();
      const existing = await chats.getMessageById(messageId);
      if (!existing) return;
      const extra = { ...existing.extra, hidden: true };
      await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, messageId);
    },

    unhide: async (messageId: number) => {
      checkAbort();
      const existing = await chats.getMessageById(messageId);
      if (!existing) return;
      const extra = { ...existing.extra, hidden: false };
      await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, messageId);
    },

    stop: async () => {
      checkAbort();
      const active = generationService.getActiveGeneration();
      if (active && active.chatId === chatId) {
        await generationService.handleStop(active.id);
      }
    },

    reset_chat: async () => {
      checkAbort();
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      const ids = msgs.map((m) => m.id);
      if (ids.length > 0) {
        await chats.deleteMessages(ids);
      }
      const updatedChat = await chats.updateChat(chatId, { headMessageId: null, activeChildId: null });
      chatMetaBroadcast.broadcastMessagesLoaded(chatId, []);
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
      // headMessageId changed (trunk cleared) → refresh messages/greeting via snapshot.
      await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
    },

    // --- Queries ---

    get_messages: async (limit?: number) => {
      checkAbort();
      const msgs = await chats.getActiveBranch(chatId, { limit: limit ?? 100 });
      return msgs.map(toLuaMessage);
    },

    get_chat: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat) return null;
      return {
        id: chat.id,
        name: chat.name,
        characterId: chat.characterId,
        headMessageId: chat.headMessageId,
        metadata: chat.metadata,
      };
    },

    get_characters: async () => {
      checkAbort();
      const list = await characters.list();
      return list.items.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        personality: c.personality,
        scenario: c.scenario,
      }));
    },

    find_character: async (name: string) => {
      checkAbort();
      if (typeof name !== 'string') throw new Error('find_character: expected string');
      const c = await characters.getByName(name);
      if (!c) return null;
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        personality: c.personality,
        scenario: c.scenario,
      };
    },

    get_character: async (id: string) => {
      checkAbort();
      if (typeof id !== 'string') throw new Error('get_character: expected string');
      const c = await characters.getById(id);
      if (!c) return null;
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        personality: c.personality,
        scenario: c.scenario,
        firstMes: c.firstMes,
        mesExample: c.mesExample,
        creatorNotes: c.creatorNotes,
        systemPrompt: c.systemPrompt,
        postHistoryInstructions: c.postHistoryInstructions,
        extensions: c.extensions,
      };
    },

    get_personas: async () => {
      checkAbort();
      const list = await personas.listSummaries();
      return list.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
      }));
    },

    get_persona: async (id: string) => {
      checkAbort();
      if (typeof id !== 'string') throw new Error('get_persona: expected string');
      const p = await personas.getById(id);
      if (!p) return null;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
      };
    },

    set_persona: async (personaId: string) => {
      checkAbort();
      if (typeof personaId !== 'string') throw new Error('set_persona: expected string');
      const persona = await personas.getById(personaId);
      if (!persona) throw new Error(`set_persona: persona "${personaId}" not found`);
      const updatedChat = await chats.updateChat(chatId, { personaId });
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
      // personaId is structural (drives chatPersona/greeting) → refresh via snapshot.
      await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
    },

    new_chat: async (name?: string) => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('new_chat: current chat not found');
      const id = crypto.randomUUID();
      const newChat = await chats.createChat(id, {
        characterId: chat.characterId,
        personaId: chat.personaId,
        name: typeof name === 'string' ? name : chat.name,
        headMessageId: null,
        metadata: {},
      });
      bus.broadcast({ type: 'chat.created', chat: newChat });
      // Rebroadcast the full list so other tabs' sidebars converge (AGENTS.md §5).
      const createdChatList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({ type: 'chat.listed', chats: createdChatList.items.map(toChatSummary), total: createdChatList.total });
      return newChat.id;
    },

    trigger: async () => {
      checkAbort();
      await generationService.handleGenerate(chatId, ctx.id, clientId);
    },

    set_character: async (characterId: string) => {
      checkAbort();
      if (typeof characterId !== 'string') throw new Error('set_character: expected string');
      const character = await characters.getById(characterId);
      if (!character) throw new Error(`set_character: character "${characterId}" not found`);
      const updatedChat = await chats.updateChat(chatId, { characterId });
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
      // characterId is structural (drives chatCharacter/greeting) → refresh via snapshot.
      await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
    },

    get_character_id: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      return chat?.characterId ?? null;
    },

    create_character: async (data: unknown) => {
      checkAbort();
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('create_character: expected table');
      }
      try {
        const character = await createCharacter({ characters, bus }, data as Record<string, unknown>);
        return { id: character.id, name: character.name };
      } catch (err) {
        throw new Error(`create_character: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    },

    update_character: async (characterId: string, patch: unknown) => {
      checkAbort();
      if (typeof characterId !== 'string' || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('update_character: expected (string, table)');
      }
      try {
        await updateCharacter({ characters, bus }, characterId, patch as Record<string, unknown>);
      } catch (err) {
        throw new Error(`update_character: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    },

    add_chat_member: async (characterId: string) => {
      checkAbort();
      if (typeof characterId !== 'string') throw new Error('add_chat_member: expected string');
      await addChatMember({ chats, characters, chatMembers, chatMetaBroadcast }, chatId, characterId);
    },

    remove_chat_member: async (characterId: string) => {
      checkAbort();
      if (typeof characterId !== 'string') throw new Error('remove_chat_member: expected string');
      await removeChatMember({ chats, characters, chatMembers, chatMetaBroadcast }, chatId, characterId);
    },

    get_persona_id: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      return chat?.personaId ?? null;
    },

    branch: async (messageId: number, name?: string) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('branch: expected (messageId, name?)');
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('branch: chat not found');
      const branchName = typeof name === 'string' ? name : `${chat.name} (branch)`;
      const newChat = await chats.softFork(chatId, messageId, branchName);
      bus.broadcast({ type: 'chat.created', chat: newChat });
      // Rebroadcast the full list so other tabs' sidebars converge (AGENTS.md §5).
      const createdChatList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({ type: 'chat.listed', chats: createdChatList.items.map(toChatSummary), total: createdChatList.total });
      return newChat.id;
    },

    checkpoint: async (name?: string) => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('checkpoint: chat not found');
      const headId = chat.activeChildId ?? chat.headMessageId;
      if (headId === null) throw new Error('checkpoint: no messages to checkpoint');
      const checkpointName = typeof name === 'string' ? name : `${chat.name} (checkpoint)`;
      const newChat = await chats.softFork(chatId, headId, checkpointName);
      bus.broadcast({ type: 'chat.created', chat: newChat });
      // Rebroadcast the full list so other tabs' sidebars converge (AGENTS.md §5).
      const createdChatList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({ type: 'chat.listed', chats: createdChatList.items.map(toChatSummary), total: createdChatList.total });
      return newChat.id;
    },

    set_author_note: async (content: string, opts?: { depth?: number; interval?: number; position?: string; role?: string }) => {
      checkAbort();
      if (typeof content !== 'string') throw new Error('set_author_note: expected string');
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('set_author_note: chat not found');
      const authorsNote = {
        content,
        depth: opts?.depth ?? 4,
        interval: opts?.interval ?? 1,
        position: ['before_prompt', 'after_prompt', 'in_chat'].includes(String(opts?.position))
          ? opts?.position
          : 'in_chat',
        role: ['system', 'user', 'assistant'].includes(String(opts?.role))
          ? opts?.role
          : 'system',
      };
      const updatedChat = await chats.mergeChatMetadata(chatId, { authorsNote });
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
    },

    get_author_note: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat) return null;
      const an = chat.metadata['authorsNote'];
      if (!an || typeof an !== 'object') return null;
      return an as Record<string, unknown>;
    },

    get_setting: async (key: string) => {
      checkAbort();
      const value = await settings.get(String(key));
      return value ?? null;
    },

    set_setting: async (key: string, value: unknown) => {
      checkAbort();
      await settings.setValue(String(key), value);
      bus.broadcast({ type: 'settings.changed', key: String(key), value });
    },

    get_settings: async () => {
      checkAbort();
      return await settings.list();
    },

    get_backend_configs: async () => {
      checkAbort();
      const list = await backendConfigs.list();
      return list.map((p) => ({
        id: p.id,
        name: p.name,
        backendProvider: p.backendProvider,
        model: p.model,
      }));
    },

    get_backend_config: async (id: string) => {
      checkAbort();
      if (typeof id !== 'string') throw new Error('get_backend_config: expected string');
      const p = await backendConfigs.getById(id);
      if (!p) return null;
      return {
        id: p.id,
        name: p.name,
        backendProvider: p.backendProvider,
        model: p.model,
        generationMode: p.generationMode,
        apiUrl: p.apiUrl,
        temperature: p.temperature,
        maxTokens: p.maxTokens,
        contextLength: p.contextLength,
        instructTemplate: p.instructTemplate,
        stopStrings: p.stopStrings,
      };
    },

    set_system_prompt: async (characterId: string, text: string) => {
      checkAbort();
      if (typeof characterId !== 'string' || typeof text !== 'string') {
        throw new Error('set_systemPrompt: expected (string, string)');
      }
      const character = await characters.getById(characterId);
      if (!character) throw new Error(`set_systemPrompt: character "${characterId}" not found`);
      await characters.update(characterId, { systemPrompt: text });
      const updated = await characters.getById(characterId);
      if (updated) bus.broadcast({ type: 'character.updated', character: updated });
    },

    get_system_prompt: async (characterId: string) => {
      checkAbort();
      if (typeof characterId !== 'string') throw new Error('get_systemPrompt: expected string');
      const character = await characters.getById(characterId);
      if (!character) return null;
      return character.systemPrompt;
    },

    set_backend_config: async (id: string) => {
      checkAbort();
      if (typeof id !== 'string') throw new Error('set_backend_config: expected string');
      const p = await backendConfigs.getById(id);
      if (!p) throw new Error(`set_backend_config: backend config "${id}" not found`);
      await settings.setValue('activeBackendConfigId', id);
      bus.broadcast({ type: 'settings.changed', key: 'activeBackendConfigId', value: id });
    },

    get_model: async () => {
      checkAbort();
      const activeBackendConfigId = str(await settings.get('activeBackendConfigId'));
      if (activeBackendConfigId) {
        const p = await backendConfigs.getById(activeBackendConfigId);
        if (p?.model) return p.model;
      }
      return str(await settings.get('model'));
    },

    set_model: async (model: string) => {
      checkAbort();
      if (typeof model !== 'string') throw new Error('set_model: expected string');
      await settings.setValue('model', model);
      bus.broadcast({ type: 'settings.changed', key: 'model', value: model });
    },

    get_apiUrl: async () => {
      checkAbort();
      return str(await settings.get('apiUrl'));
    },

    set_apiUrl: async (url: string) => {
      checkAbort();
      if (typeof url !== 'string') throw new Error('set_apiUrl: expected string');
      await settings.setValue('apiUrl', url);
      bus.broadcast({ type: 'settings.changed', key: 'apiUrl', value: url });
    },

    get_temperature: async () => {
      checkAbort();
      // v2: temperature lives on the active BackendConfig; the top-level
      // settings key is a legacy fallback for installs without an active config.
      const activeBackendConfigId = str(await settings.get('activeBackendConfigId'));
      if (activeBackendConfigId) {
        const p = await backendConfigs.getById(activeBackendConfigId);
        if (p && p.temperature !== null) return p.temperature;
      }
      const val = await settings.get('temperature');
      return val !== undefined ? Number(val) : 0.7;
    },

    set_temperature: async (value: number) => {
      checkAbort();
      const num = Number(value);
      if (isNaN(num)) throw new Error('set_temperature: expected number');
      const activeBackendConfigId = str(await settings.get('activeBackendConfigId'));
      const active = activeBackendConfigId ? await backendConfigs.getById(activeBackendConfigId) : null;
      if (active) {
        // v2 home for temperature: patch the active BackendConfig so the value
        // actually reaches generation (buildBackendSettings reads it there).
        const updated = await backendConfigs.update(active.id, { temperature: num });
        bus.broadcast({ type: 'backendConfig.updated', backendConfig: updated });
        return;
      }
      await settings.setValue('temperature', num);
      bus.broadcast({ type: 'settings.changed', key: 'temperature', value: num });
    },

    get_maxTokens: async () => {
      checkAbort();
      const val = await settings.get('maxResponseTokens');
      return val !== undefined ? Number(val) : 512;
    },

    set_maxTokens: async (value: number) => {
      checkAbort();
      const num = Math.max(1, Math.floor(Number(value)));
      if (isNaN(num)) throw new Error('set_maxTokens: expected number');
      await settings.setValue('maxResponseTokens', num);
      bus.broadcast({ type: 'settings.changed', key: 'maxResponseTokens', value: num });
    },

    get_contextLength: async () => {
      checkAbort();
      const val = await settings.get('contextLength');
      return val !== undefined ? Number(val) : 4096;
    },

    set_contextLength: async (value: number) => {
      checkAbort();
      const num = Math.max(1, Math.floor(Number(value)));
      if (isNaN(num)) throw new Error('set_contextLength: expected number');
      await settings.setValue('contextLength', num);
      bus.broadcast({ type: 'settings.changed', key: 'contextLength', value: num });
    },

    get_backend: async () => {
      checkAbort();
      return str(await settings.get('backendProvider'));
    },

    set_backend: async (provider: string) => {
      checkAbort();
      if (typeof provider !== 'string') throw new Error('set_backend: expected string');
      await settings.setValue('backendProvider', provider);
      bus.broadcast({ type: 'settings.changed', key: 'backendProvider', value: provider });
    },

    get_reasoning: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_reasoning: expected number');
      const msg = await chats.getMessageById(messageId);
      if (!msg) return null;
      const reasoning = msg.extra['reasoning'];
      return reasoning ?? null;
    },

    set_reasoning: async (messageId: number, text: string) => {
      checkAbort();
      if (typeof messageId !== 'number' || typeof text !== 'string') {
        throw new Error('set_reasoning: expected (number, string)');
      }
      const existing = await chats.getMessageById(messageId);
      if (!existing) throw new Error('set_reasoning: message not found');
      const extra = { ...existing.extra, reasoning: text };
      const updated = await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, updated.id);
    },

    clear_reasoning: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('clear_reasoning: expected number');
      const existing = await chats.getMessageById(messageId);
      if (!existing) throw new Error('clear_reasoning: message not found');
      const extra = { ...existing.extra };
      delete extra['reasoning'];
      const updated = await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, updated.id);
    },

    get_generation_info: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_generation_info: expected number');
      const msg = await chats.getMessageById(messageId);
      if (!msg) return null;
      // snake_case keys are the historical shape; camelCase duplicates are
      // additive aliases for consistency with the rest of the API.
      return {
        model: msg.extra['model'] ?? null,
        token_count: msg.extra['tokenCount'] ?? null,
        tokenCount: msg.extra['tokenCount'] ?? null,
        generation_time: msg.extra['generationTime'] ?? null,
        generationTime: msg.extra['generationTime'] ?? null,
        api: msg.extra['api'] ?? null,
      };
    },

    // --- Variables ---

    setvar: async (name: string, value: unknown) => {
      checkAbort();
      await settings.setValue(varKey(String(name)), value);
    },

    getvar: async (name: string) => {
      checkAbort();
      return await settings.get(varKey(String(name)));
    },

    // --- Meta state (out-of-fiction; does NOT fork with branches) ---

    set_state: async (namespace: string, data: unknown) => {
      checkAbort();
      const ns = validateNamespace('set_state', namespace);
      if (data === null || typeof data !== 'object') {
        throw new Error('set_state: expected (namespace, table)');
      }
      await extensionData.set(ns, 'chat', chatId, data as Record<string, unknown>);
    },

    get_state: async (namespace: string) => {
      checkAbort();
      const ns = validateNamespace('get_state', namespace);
      return (await extensionData.get(ns, 'chat', chatId)) ?? null;
    },

    set_global_state: async (namespace: string, data: unknown) => {
      checkAbort();
      const ns = validateNamespace('set_global_state', namespace);
      if (data === null || typeof data !== 'object') {
        throw new Error('set_global_state: expected (namespace, table)');
      }
      await extensionData.set(ns, 'global', '', data as Record<string, unknown>);
    },

    get_global_state: async (namespace: string) => {
      checkAbort();
      const ns = validateNamespace('get_global_state', namespace);
      return (await extensionData.get(ns, 'global', '')) ?? null;
    },

    delete_state: async (namespace: string) => {
      checkAbort();
      const ns = validateNamespace('delete_state', namespace);
      // Deleting state that was never set is a no-op for scripts.
      await extensionData.deleteIfExists(ns, 'chat', chatId);
    },

    // --- UI ---

    toast: (message: string, level?: string) => {
      bus.sendTo(clientId, {
        type: 'script.toast',
        message: String(message),
        level: ['info', 'success', 'error', 'warning'].includes(String(level)) ? String(level) : 'info',
      });
    },

    sleep: async (seconds: number) => {
      checkAbort();
      const s = Number(seconds);
      if (!Number.isFinite(s) || s < 0) throw new Error('sleep: expected non-negative number');
      const maxSleep = 30;
      const ms = Math.min(s, maxSleep) * 1000;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (ctx.signal.aborted) {
          clearTimeout(timer);
          reject(new Error('Script aborted'));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          reject(new Error('Script aborted'));
        };
        ctx.signal.addEventListener('abort', onAbort);
      });
    },

    generate: async (prompt: string, opts?: { maxTokens?: number; temperature?: number } | null) => {
      checkAbort();
      if (typeof prompt !== 'string') throw new Error('generate: expected string prompt');
      const result = await generationService.quietGenerate(chatId, prompt, opts ?? undefined, ctx.id);
      if ('error' in result) {
        throw new Error(result.error);
      }
      return result.text;
    },

    send_as: async (name: string, content: string) => {
      checkAbort();
      if (typeof name !== 'string' || typeof content !== 'string') {
        throw new Error('send_as: expected (name, content)');
      }

      const character = await characters.getByName(name);
      if (!character) {
        throw new Error(`send_as: character "${name}" not found`);
      }

      await ensureChatMaterialized();

      const newMsg = await chats.appendMessage(chatId, {
        role: 'assistant',
        extra: { characterId: character.id, parts: [{ type: 'text', text: content }] },
      });

      const updatedChat = await chats.getChatById(chatId);
      if (updatedChat) {
        await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
      }

      return newMsg.id;
    },

    send_narrator: async (name: string, content?: string) => {
      checkAbort();
      if (content === undefined) {
        // Called as st.send_narrator(content) — use default name
        content = name;
        name = 'Narrator';
      }
      if (typeof name !== 'string' || typeof content !== 'string') {
        throw new Error('send_narrator: expected (name, content) or (content)');
      }

      await ensureChatMaterialized();

      const newMsg = await chats.appendMessage(chatId, {
        role: 'system',
        extra: { type: 'narrator', parts: [{ type: 'text', text: content }] },
      });

      const updatedChat = await chats.getChatById(chatId);
      if (updatedChat) {
        await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
      }

      return newMsg.id;
    },

    comment: async (content: string) => {
      checkAbort();
      if (typeof content !== 'string') {
        throw new Error('comment: expected string');
      }

      await ensureChatMaterialized();

      const newMsg = await chats.appendMessage(chatId, {
        role: 'system',
        extra: { type: 'comment', hidden: true, parts: [{ type: 'text', text: content }] },
      });

      const updatedChat = await chats.getChatById(chatId);
      if (updatedChat) {
        await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
      }

      return newMsg.id;
    },

    set_message_role: async (messageId: number, role: string) => {
      checkAbort();
      if (typeof messageId !== 'number' || typeof role !== 'string') {
        throw new Error('set_message_role: expected (number, string)');
      }
      const allowed: readonly MessageRole[] = ['user', 'assistant', 'system'];
      const validatedRole = allowed.find((r) => r === role);
      if (!validatedRole) {
        throw new Error(`set_message_role: role must be one of ${allowed.join(', ')}`);
      }
      const updated = await chats.updateMessage(messageId, { role: validatedRole });
      await chatBroadcast.broadcastMessageSnapshot(chatId, updated.id);
    },

    delay: async (ms: number) => {
      const duration = Math.max(0, Math.floor(Number(ms) || 0));
      await new Promise((resolve) => setTimeout(resolve, duration));
    },

    rename_chat: async (name: string) => {
      checkAbort();
      if (typeof name !== 'string') throw new Error('rename_chat: expected string');
      const updated = await chats.updateChat(chatId, { name });
      chatMetaBroadcast.broadcastChatUpdated(updated);
    },

    delete_chat: async () => {
      checkAbort();
      await chats.deleteChat(chatId);
      chatMetaBroadcast.broadcastChatDeleted(chatId);
      const list = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({ type: 'chat.listed', chats: list.items.map(toChatSummary), total: list.total });
    },

    get_message_by_id: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_message_by_id: expected number');
      const msg = await chats.getMessageById(messageId);
      if (!msg) return null;
      return toLuaMessage(msg);
    },

    get_message_count: async () => {
      checkAbort();
      return await chats.getMessageCount(chatId);
    },

    get_last_message: async () => {
      checkAbort();
      const msgs = await chats.getActiveBranch(chatId, { limit: 1 });
      const m = msgs[0];
      return m ? toLuaMessage(m) : null;
    },

    get_chat_name: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      return chat?.name ?? null;
    },

    get_character_name: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat?.characterId) return null;
      const character = await characters.getById(chat.characterId);
      return character?.name ?? null;
    },

    set_chat_metadata: async (key: string, value: unknown) => {
      checkAbort();
      if (typeof key !== 'string') throw new Error('set_chat_metadata: expected (string, value)');
      const updatedChat = await chats.mergeChatMetadata(chatId, { [key]: value });
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
    },

    get_chat_metadata: async (key: string) => {
      checkAbort();
      if (typeof key !== 'string') throw new Error('get_chat_metadata: expected string');
      const chat = await chats.getChatById(chatId);
      if (!chat) return null;
      return chat.metadata[key] ?? null;
    },

    get_chats: async (characterId?: string) => {
      checkAbort();
      const list = await chats.listChats({
        characterId: typeof characterId === 'string' ? characterId : undefined,
        limit: 100,
      });
      return list.items.map((c) => ({
        id: c.id,
        name: c.name,
        characterId: c.characterId,
        personaId: c.personaId,
        headMessageId: c.headMessageId,
        activeChildId: c.activeChildId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }));
    },

    hard_fork: async (messageId: number, name?: string) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('hard_fork: expected (messageId, name?)');
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('hard_fork: chat not found');
      const forkName = typeof name === 'string' ? name : `${chat.name} (fork)`;
      const newChat = await chats.hardFork(chatId, messageId, forkName);
      bus.broadcast({ type: 'chat.created', chat: newChat });
      // Rebroadcast the full list so other tabs' sidebars converge (AGENTS.md §5).
      const createdChatList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({ type: 'chat.listed', chats: createdChatList.items.map(toChatSummary), total: createdChatList.total });
      return newChat.id;
    },

    get_message_at: async (index: number) => {
      checkAbort();
      if (typeof index !== 'number') throw new Error('get_message_at: expected number');
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      const idx = index < 0 ? msgs.length + index : index;
      if (idx < 0 || idx >= msgs.length) return null;
      const m = msgs[idx];
      return m ? toLuaMessage(m) : null;
    },

    get_message_index: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_message_index: expected number');
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      const idx = msgs.findIndex((m) => m.id === messageId);
      return idx >= 0 ? idx : null;
    },

    temp_chat: async (name?: string) => {
      checkAbort();
      const id = crypto.randomUUID();
      const chatName = typeof name === 'string' ? name : 'Temporary Chat';
      const chat = await chats.createChat(id, {
        characterId: null,
        personaId: null,
        name: chatName,
        headMessageId: null,
        metadata: {},
      });
      bus.broadcast({ type: 'chat.created', chat });
      const createdChatList = await chats.listChatSummaries({ limit: 1000 });
      bus.broadcast({ type: 'chat.listed', chats: createdChatList.items.map(toChatSummary), total: createdChatList.total });
      return chat.id;
    },

    get_children: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_children: expected number');
      const children = await chats.getSiblings(messageId);
      return children.map(toLuaMessage);
    },

    get_message_chain: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_message_chain: expected number');
      const chain: LuaMessage[] = [];
      let current = await chats.getMessageById(messageId);
      while (current) {
        chain.unshift(toLuaMessage(current));
        if (current.parentId === null) break;
        current = await chats.getMessageById(current.parentId);
      }
      return chain;
    },

    get_swipes: async () => {
      checkAbort();
      const { swipes } = await getChatSnapshotMessages(chats, chatId, FULL_BRANCH_MESSAGE_LIMIT);
      return swipes.map(toLuaMessage);
    },

    get_siblings: async (messageId: number) => {
      checkAbort();
      if (typeof messageId !== 'number') throw new Error('get_siblings: expected number');
      const msg = await chats.getMessageById(messageId);
      if (!msg) throw new Error('get_siblings: message not found');
      const siblings = await chats.getSiblings(msg.parentId);
      return siblings.map(toLuaMessage);
    },

    repair_active_child: async () => {
      checkAbort();
      const repaired = await chats.repairActiveChild(chatId);
      if (repaired) {
        const updatedChat = await chats.getChatById(chatId);
        if (updatedChat) chatMetaBroadcast.broadcastChatUpdated(updatedChat);
      }
    },

    // --- Utilities ---

    token_count: (text: string) => {
      const counter = tokenCounterProvider.provideTokenCounter('');
      return counter.count(String(text));
    },

    count_tokens: (text: string) => {
      const counter = tokenCounterProvider.provideTokenCounter('');
      return counter.count(String(text));
    },

    upper: (text: string) => String(text).toUpperCase(),
    lower: (text: string) => String(text).toLowerCase(),

    trim_tokens: (text: string, limit: number) => {
      const counter = tokenCounterProvider.provideTokenCounter('');
      const target = Math.max(0, Math.floor(Number(limit) || 0));
      let trimmed = String(text);
      while (counter.count(trimmed) > target && trimmed.length > 0) {
        trimmed = trimmed.slice(0, -1);
      }
      return trimmed;
    },

    replace: (text: string, search: string, replacement: string) => {
      return String(text).split(String(search)).join(String(replacement));
    },

    replace_regex: (text: string, pattern: string, replacement: string) => {
      return String(text).replace(new RegExp(String(pattern), 'g'), String(replacement));
    },

    match: (text: string, pattern: string) => {
      const matches = String(text).match(new RegExp(String(pattern), 'g'));
      return matches ?? [];
    },

    test: (text: string, pattern: string) => {
      return new RegExp(String(pattern)).test(String(text));
    },

    substring: (text: string, start: number, end?: number) => {
      return String(text).substring(Number(start), end !== undefined ? Number(end) : undefined);
    },

    trim_start: (text: string) => {
      const str = String(text);
      const index = str.match(/[.!?\n]/)?.index;
      return index !== undefined ? str.substring(0, index + 1) : str;
    },

    trim_end: (text: string) => {
      const str = String(text);
      const index = str.match(/[.!?\n](?!.*[.!?\n])/)?.index;
      return index !== undefined ? str.substring(index + 1) : str;
    },

    random: (min?: number, max?: number) => {
      const lo = min !== undefined ? Math.floor(Number(min)) : 0;
      const hi = max !== undefined ? Math.floor(Number(max)) : 100;
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    },

    now: () => Math.floor(Date.now() / 1000),

    set_message_extra: async (messageId: number, key: string, value: unknown) => {
      checkAbort();
      if (typeof messageId !== 'number' || typeof key !== 'string') {
        throw new Error('set_message_extra: expected (number, string, value)');
      }
      const existing = await chats.getMessageById(messageId);
      if (!existing) throw new Error('set_message_extra: message not found');
      const extra = { ...existing.extra, [key]: value };
      const updated = await chats.updateMessage(messageId, { extra });
      await chatBroadcast.broadcastMessageSnapshot(chatId, updated.id);
    },

    get_message_extra: async (messageId: number, key: string) => {
      checkAbort();
      if (typeof messageId !== 'number' || typeof key !== 'string') {
        throw new Error('get_message_extra: expected (number, string)');
      }
      const msg = await chats.getMessageById(messageId);
      if (!msg) return null;
      return msg.extra[key] ?? null;
    },

    array_wrap: (value: unknown) => [value],
    array_unwrap: (arr: unknown[]) => Array.isArray(arr) ? arr[0] : arr,

    pass: (value: unknown) => value,

    is_empty: (value: unknown) => {
      if (value === null || value === undefined) return true;
      if (typeof value === 'string') return value.trim().length === 0;
      if (Array.isArray(value)) return value.length === 0;
      if (typeof value === 'object') return Object.keys(value).length === 0;
      return false;
    },

    len: (value: unknown) => {
      if (typeof value === 'string') return value.length;
      if (Array.isArray(value)) return value.length;
      return 0;
    },

    join: (arr: unknown[], separator?: string) => {
      if (!Array.isArray(arr)) throw new Error('join: expected array');
      return arr.join(typeof separator === 'string' ? separator : ',');
    },

    split: (text: string, separator?: string) => {
      return String(text).split(typeof separator === 'string' ? separator : ',');
    },

    includes: (text: string, search: string) => String(text).includes(String(search)),
    starts_with: (text: string, prefix: string) => String(text).startsWith(String(prefix)),
    ends_with: (text: string, suffix: string) => String(text).endsWith(String(suffix)),

    json_encode: (value: unknown) => JSON.stringify(value),
    json_decode: (text: string): unknown => JSON.parse(String(text)),

    abs: (n: number) => Math.abs(Number(n)),
    floor: (n: number) => Math.floor(Number(n)),
    ceil: (n: number) => Math.ceil(Number(n)),
    round: (n: number) => Math.round(Number(n)),
    clamp: (n: number, min: number, max: number) => Math.min(Math.max(Number(n), Number(min)), Number(max)),

    find_message_by_content: async (search: string) => {
      checkAbort();
      if (typeof search !== 'string') throw new Error('find_message_by_content: expected string');
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      const found = msgs.find((m) => getMessageText(m.extra.parts).includes(search));
      if (!found) return null;
      return toLuaMessage(found);
    },

    find_messages_by_role: async (role: string) => {
      checkAbort();
      if (typeof role !== 'string') throw new Error('find_messages_by_role: expected string');
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      return msgs
        .filter((m) => m.role === role)
        .map(toLuaMessage);
    },

    messages_as_text: async (separator?: string) => {
      checkAbort();
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      const sep = typeof separator === 'string' ? separator : '\n';
      return msgs.map((m) => `${m.role}: ${getMessageText(m.extra.parts)}`).join(sep);
    },

    get_message_texts: async () => {
      checkAbort();
      const msgs = await chats.getActiveBranch(chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
      return msgs.map((m) => getMessageText(m.extra.parts));
    },

    get_head: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat?.headMessageId) return null;
      const msg = await chats.getMessageById(chat.headMessageId);
      if (!msg) return null;
      return toLuaMessage(msg);
    },

    get_active_child: async () => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat?.activeChildId) return null;
      const msg = await chats.getMessageById(chat.activeChildId);
      if (!msg) return null;
      return toLuaMessage(msg);
    },

    tag_add: async (characterId: string, tag: string) => {
      checkAbort();
      if (typeof characterId !== 'string' || typeof tag !== 'string') {
        throw new Error('tag_add: expected (string, string)');
      }
      const character = await characters.getById(characterId);
      if (!character) throw new Error(`tag_add: character "${characterId}" not found`);
      const tags = new Set(character.tags);
      tags.add(tag);
      await characters.update(characterId, { tags: Array.from(tags) });
      const updated = await characters.getById(characterId);
      if (updated) bus.broadcast({ type: 'character.updated', character: updated });
    },

    tag_remove: async (characterId: string, tag: string) => {
      checkAbort();
      if (typeof characterId !== 'string' || typeof tag !== 'string') {
        throw new Error('tag_remove: expected (string, string)');
      }
      const character = await characters.getById(characterId);
      if (!character) throw new Error(`tag_remove: character "${characterId}" not found`);
      const tags = character.tags.filter((t) => t !== tag);
      await characters.update(characterId, { tags });
      const updated = await characters.getById(characterId);
      if (updated) bus.broadcast({ type: 'character.updated', character: updated });
    },

    tag_list: async (characterId: string) => {
      checkAbort();
      if (typeof characterId !== 'string') throw new Error('tag_list: expected string');
      const character = await characters.getById(characterId);
      if (!character) throw new Error(`tag_list: character "${characterId}" not found`);
      return character.tags;
    },

    // --- World Info ---

    wi_list: async () => {
      checkAbort();
      const bookId = await getCharacterBookId();
      if (!bookId) return [];
      const book = await worldInfo.getById(bookId);
      return book?.entries ?? [];
    },

    wi_get: async (key: string) => {
      checkAbort();
      if (typeof key !== 'string') throw new Error('wi_get: expected string');
      const bookId = await getCharacterBookId();
      if (!bookId) return null;
      const book = await worldInfo.getById(bookId);
      if (!book) return null;
      const entry = book.entries.find((e) => e.keys.some((k) => k.toLowerCase() === key.toLowerCase()));
      return entry ?? null;
    },

    wi_add: async (keys: string, content: string) => {
      checkAbort();
      if (typeof keys !== 'string' || typeof content !== 'string') {
        throw new Error('wi_add: expected (string, string)');
      }
      const bookId = await getCharacterBookId();
      if (!bookId) throw new Error('wi_add: no lorebook linked to this chat');
      const book = await worldInfo.getById(bookId);
      if (!book) throw new Error('wi_add: lorebook not found');

      const keyList = keys.split(',').map((k) => k.trim()).filter(Boolean);
      if (keyList.length === 0) throw new Error('wi_add: at least one key required');

      const newEntry = {
        id: crypto.randomUUID(),
        keys: keyList,
        content,
        comment: '',
        position: 'before_char' as const,
        order: 0,
        probability: 100,
        constant: false,
        selective: false,
        secondaryKeys: [] as string[],
        addMemo: false,
        disable: false,
        regex: false,
        recursive: false,
        depth: 0,
        role: 'system' as const,
        retrievalMode: 'keyword' as const,
      };

      const updated = await worldInfo.update(bookId, { entries: [...book.entries, newEntry] });
      bus.broadcast({ type: 'worldinfo.updated', book: updated });
      return newEntry.id;
    },

    wi_remove: async (key: string) => {
      checkAbort();
      if (typeof key !== 'string') throw new Error('wi_remove: expected string');
      const bookId = await getCharacterBookId();
      if (!bookId) throw new Error('wi_remove: no lorebook linked to this chat');
      const book = await worldInfo.getById(bookId);
      if (!book) throw new Error('wi_remove: lorebook not found');

      const idx = book.entries.findIndex((e) => e.keys.some((k) => k.toLowerCase() === key.toLowerCase()));
      if (idx === -1) throw new Error(`wi_remove: no entry with key "${key}"`);

      const updated = await worldInfo.update(bookId, { entries: book.entries.filter((_, i) => i !== idx) });
      bus.broadcast({ type: 'worldinfo.updated', book: updated });
      return true;
    },

    clear_variables: async () => {
      checkAbort();
      const all = await settings.list();
      const prefix = `lua.var.${chatId}.`;
      for (const key of Object.keys(all)) {
        if (key.startsWith(prefix)) {
          await settings.delete(key);
        }
      }
    },

    get_variables: async () => {
      checkAbort();
      const all = await settings.list();
      const prefix = `lua.var.${chatId}.`;
      const vars: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(prefix)) {
          vars[key.slice(prefix.length)] = value;
        }
      }
      return vars;
    },

    add_swipe: async (content: string, switchTo?: boolean) => {
      checkAbort();
      if (typeof content !== 'string') throw new Error('add_swipe: expected string');

      const chat = await chats.getChatById(chatId);
      if (!chat || !chat.activeChildId) {
        throw new Error('add_swipe: no active message to swipe from');
      }

      const activeMsg = await chats.getMessageById(chat.activeChildId);
      if (!activeMsg) {
        throw new Error('add_swipe: active message not found');
      }

      if (activeMsg.role !== 'assistant') {
        throw new Error('add_swipe: can only add swipes to assistant messages');
      }

      const newMsg = await chats.insertMessage({
        parentId: activeMsg.parentId,
        role: 'assistant',
        extra: activeMsg.extra.characterId ? { characterId: activeMsg.extra.characterId, parts: [{ type: 'text', text: content }] } : { parts: [{ type: 'text', text: content }] },
      });

      if (switchTo) {
        await chats.updateChat(chatId, { activeChildId: newMsg.id });
      }

      const updatedChat = await chats.getChatById(chatId);
      if (updatedChat) {
        await chatBroadcast.broadcastSnapshot(chatId, FULL_BRANCH_MESSAGE_LIMIT);
      }

      return newMsg.id;
    },

    set_active_child: async (messageId: number) => {
      checkAbort();
      const chat = await chats.getChatById(chatId);
      if (!chat) throw new Error('set_active_child: chat not found');

      const msg = await chats.getMessageById(messageId);
      if (!msg) throw new Error('set_active_child: message not found');

      if (msg.parentId !== chat.headMessageId) {
        throw new Error('set_active_child: message is not a swipe of the current head');
      }

      const updatedChat = await chats.updateChat(chatId, { activeChildId: messageId });
      chatMetaBroadcast.broadcastChatUpdated(updatedChat);
    },

    substitute_macros: async (text: string) => {
      checkAbort();
      const allSettings = await settings.list();
      const chat = await chats.getChatById(chatId);
      const character = chat?.characterId ? await characters.getById(chat.characterId) : null;
      const msgs = await chats.getActiveBranch(chatId, { limit: 100 });
      const persona = chat?.personaId ? await personas.getById(chat.personaId) : undefined;
      const settingsUserName = (allSettings['userName'] as string | undefined) ?? '';
      const resolver = MacroResolver.createPromptResolver();
      const macroCtx = {
        userName: persona?.name || settingsUserName || 'User',
        charName: character?.name ?? 'Character',
        description: character?.description,
        personality: character?.personality,
        scenario: character?.scenario,
        model: String(allSettings['model']),
        maxContext: Number(allSettings['contextLength'] ?? 4096),
        maxResponse: Number(allSettings['maxResponseTokens']),
        now: new Date(),
        messages: msgs.map((m) => ({ id: m.id, role: m.role, content: getMessageText(m.extra.parts) })),
      };
      return resolver.resolve(String(text), macroCtx);
    },

    // ── Slash-command parity: inject, genraw, ask, sysgen ──────────────

    inject: async (text: string) => {
      checkAbort();
      if (typeof text !== 'string') throw new Error('inject: expected string');
      generationService.setPendingInjection(chatId, text);
    },

    flush_inject: async () => {
      checkAbort();
      generationService.clearPendingInjections(chatId);
    },

    genraw: async (prompt: string) => {
      checkAbort();
      if (typeof prompt !== 'string') throw new Error('genraw: expected string prompt');
      // ctx.id is the lock HOLDER (not the client id) — without the pass-through
      // the nested chat-mutex acquire deadlocks against the script's own lock.
      await generationService.handleGenRaw(chatId, prompt, clientId, ctx.id);
    },

    ask: async (characterName: string, content: string) => {
      checkAbort();
      if (typeof characterName !== 'string' || typeof content !== 'string') {
        throw new Error('ask: expected (characterName, content)');
      }
      await generationService.handleAsk(chatId, characterName, content, clientId, ctx.id);
    },

    sysgen: async (content: string) => {
      checkAbort();
      if (typeof content !== 'string') throw new Error('sysgen: expected string content');
      await generationService.handleSysGen(chatId, content, clientId, ctx.id);
    },
  };

  // Deprecated camelCase aliases — kept for backward compatibility with
  // shipped user scripts; new scripts should use the snake_case names.
  api.get_characterId = api.get_character_id;
  api.get_personaId = api.get_persona_id;
  api.get_characterName = api.get_character_name;
  api.set_systemPrompt = api.set_system_prompt;
  api.get_systemPrompt = api.get_system_prompt;
  return api;
}

/**
 * The `st` subset exposed to Lua TOOL templates (`allowSt` sandbox flag).
 *
 * One rule: queries, entity writes, variables/state, settings, quiet
 * generation, and utilities are IN; anything that mutates the running chat's
 * message history, drives generation flow, or manages chat lifecycle is OUT —
 * tool templates execute inside an active generation's tool loop, which is
 * itself reading and writing the branch.
 */
export const TOOL_ST_WHITELIST: ReadonlySet<keyof StApi> = new Set<keyof StApi>([
  // Queries — chat & message tree
  'get_messages', 'get_chat', 'get_message_by_id', 'get_message_count', 'get_last_message',
  'get_message_at', 'get_message_index', 'get_children', 'get_message_chain', 'get_swipes',
  'get_siblings', 'get_head', 'get_active_child', 'get_message_extra', 'find_message_by_content',
  'find_messages_by_role', 'messages_as_text', 'get_message_texts', 'get_chat_name',
  'get_chats', 'get_reasoning', 'get_generation_info',
  // Queries — characters & personas
  'get_characters', 'find_character', 'get_character', 'get_character_id', 'get_characterId',
  'get_character_name', 'get_characterName',
  'get_personas', 'get_persona', 'get_persona_id', 'get_personaId', 'tag_list',
  // Entity writes (global repos — no chat lock needed)
  'create_character', 'update_character', 'add_chat_member', 'remove_chat_member',
  'set_character', 'set_persona', 'tag_add', 'tag_remove',
  // Settings & backend (take effect on later generations)
  'get_setting', 'get_settings', 'set_setting', 'get_backend_configs', 'get_backend_config',
  'set_backend_config', 'set_system_prompt', 'set_systemPrompt', 'get_system_prompt',
  'get_systemPrompt', 'get_model', 'set_model',
  'get_apiUrl', 'set_apiUrl', 'get_temperature', 'set_temperature', 'get_maxTokens',
  'set_maxTokens', 'get_contextLength', 'set_contextLength', 'get_backend', 'set_backend',
  // Variables & meta state
  'setvar', 'getvar', 'get_variables', 'clear_variables', 'set_state', 'get_state',
  'set_global_state', 'get_global_state', 'delete_state',
  // Author's note & chat metadata
  'set_author_note', 'get_author_note', 'set_chat_metadata', 'get_chat_metadata', 'rename_chat',
  // World info (character-linked book)
  'wi_list', 'wi_get', 'wi_add', 'wi_remove',
  // Quiet one-shot generation (no tool loop; lockHolder shares the outer tenure)
  'generate', 'genraw', 'ask', 'sysgen',
  // UI & timing
  'toast', 'sleep', 'delay',
  // Pure utilities
  'token_count', 'count_tokens', 'substitute_macros', 'upper', 'lower', 'trim_tokens',
  'replace', 'replace_regex', 'match', 'test', 'substring', 'trim_start', 'trim_end',
  'random', 'now', 'array_wrap', 'array_unwrap', 'pass', 'is_empty', 'len', 'join',
  'split', 'includes', 'starts_with', 'ends_with', 'json_encode', 'json_decode',
  'abs', 'floor', 'ceil', 'round', 'clamp',
]);

/**
 * Build the curated `st` API for Lua tool templates: the full API filtered to
 * TOOL_ST_WHITELIST. Excluded names are simply absent (Lua sees `nil`).
 */
export function createToolStApi(ctx: ScriptContext, deps: StApiDeps): Partial<StApi> {
  const full = createStApi(ctx, deps);
  const subset: Partial<StApi> = {};
  for (const key of TOOL_ST_WHITELIST) {
    // Object.assign sidesteps the union-keyed index-write limitation while
    // staying typed: `key` is `keyof StApi`, so typos fail to compile.
    Object.assign(subset, { [key]: full[key] });
  }
  return subset;
}
