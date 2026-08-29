/**
 * Public types for the `st` API injected into every Lua runtime.
 *
 * Lives apart from the domain factories so `StApi.ts` can re-export the full
 * surface without import cycles (domain modules import these types; StApi.ts
 * imports the domain modules).
 */

import type { EventBus } from '../../bus/EventBus.js';
import type { ScriptGenerationApi } from '../ScriptGenerationApi.js';
import type { IChatRepository } from '../../repos/ChatRepository.js';
import type { ICharacterRepository } from '../../repos/CharacterRepository.js';
import type { IChatMemberRepository } from '../../repos/ChatMemberRepository.js';
import type { IExtensionDataRepository } from '../../repos/ExtensionDataRepository.js';
import type { IPersonaRepository } from '../../repos/PersonaRepository.js';
import type { ISettingsRepository } from '../../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../../repos/BackendConfigRepository.js';
import type { IWorldInfoRepository } from '../../repos/WorldInfoRepository.js';
import type { GenerationMode, Message, MessageRole } from '@tamari/types';

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
  chatBroadcast: import('../../services/ChatBroadcastService.js').ChatBroadcastService;
  chatMetaBroadcast: import('../../services/ChatMetaBroadcastService.js').ChatMetaBroadcastService;
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
  generationMode: GenerationMode;
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

  // --- Slash-command parity: genraw, ask, sysgen ---
  genraw(prompt: string): Promise<void>;
  ask(characterName: string, content: string): Promise<void>;
  sysgen(content: string): Promise<void>;
};
