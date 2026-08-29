/**
 * The `st` API injected into every Lua runtime.
 *
 * All functions are synchronous or return Promises that the LuaRuntime
 * awaits before resuming the coroutine.
 *
 * The implementation is split into cohesive domain modules under `./stapi/`;
 * this file keeps the public entry points (types, `createStApi`,
 * `TOOL_ST_WHITELIST`, `createToolStApi`) and wires the domains together.
 */

import type { ScriptContext } from './ScriptContext.js';
import { createStApiContext } from './stapi/context.js';
import { createChatActions } from './stapi/chatActions.js';
import { createMessageQueries } from './stapi/messageQueries.js';
import { createMessageWrites } from './stapi/messageWrites.js';
import { createChatManagement } from './stapi/chatManagement.js';
import { createCharacters } from './stapi/characters.js';
import { createPersonas } from './stapi/personas.js';
import { createSettings } from './stapi/settings.js';
import { createVariables } from './stapi/variables.js';
import { createState } from './stapi/state.js';
import { createWorldInfo } from './stapi/worldInfo.js';
import { createGeneration } from './stapi/generation.js';
import { createUi } from './stapi/ui.js';
import { createUtilities } from './stapi/utilities.js';
import type { StApi, StApiDeps } from './stapi/types.js';

export type {
  StApi,
  StApiDeps,
  LuaMessage,
  LuaChatInfo,
  LuaChatListItem,
  LuaCharacterSummary,
  LuaCharacter,
  LuaPersona,
  LuaBackendConfigSummary,
  LuaBackendConfig,
  LuaGenerationInfo,
} from './stapi/types.js';

export function createStApi(ctx: ScriptContext, deps: StApiDeps): StApi {
  const c = createStApiContext(ctx, deps);
  const api: StApi = {
    ...createChatActions(c),
    ...createMessageQueries(c),
    ...createMessageWrites(c),
    ...createChatManagement(c),
    ...createCharacters(c),
    ...createPersonas(c),
    ...createSettings(c),
    ...createVariables(c),
    ...createState(c),
    ...createWorldInfo(c),
    ...createGeneration(c),
    ...createUi(c),
    ...createUtilities(),
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
  'get_messages',
  'get_chat',
  'get_message_by_id',
  'get_message_count',
  'get_last_message',
  'get_message_at',
  'get_message_index',
  'get_children',
  'get_message_chain',
  'get_swipes',
  'get_siblings',
  'get_head',
  'get_active_child',
  'get_message_extra',
  'find_message_by_content',
  'find_messages_by_role',
  'messages_as_text',
  'get_message_texts',
  'get_chat_name',
  'get_chats',
  'get_reasoning',
  'get_generation_info',
  // Queries — characters & personas
  'get_characters',
  'find_character',
  'get_character',
  'get_character_id',
  'get_characterId',
  'get_character_name',
  'get_characterName',
  'get_personas',
  'get_persona',
  'get_persona_id',
  'get_personaId',
  'tag_list',
  // Entity writes (global repos — no chat lock needed)
  'create_character',
  'update_character',
  'add_chat_member',
  'remove_chat_member',
  'set_character',
  'set_persona',
  'tag_add',
  'tag_remove',
  // Settings & backend (take effect on later generations)
  'get_setting',
  'get_settings',
  'set_setting',
  'get_backend_configs',
  'get_backend_config',
  'set_backend_config',
  'set_system_prompt',
  'set_systemPrompt',
  'get_system_prompt',
  'get_systemPrompt',
  'get_model',
  'set_model',
  'get_apiUrl',
  'set_apiUrl',
  'get_temperature',
  'set_temperature',
  'get_maxTokens',
  'set_maxTokens',
  'get_contextLength',
  'set_contextLength',
  'get_backend',
  'set_backend',
  // Variables & meta state
  'setvar',
  'getvar',
  'get_variables',
  'clear_variables',
  'set_state',
  'get_state',
  'set_global_state',
  'get_global_state',
  'delete_state',
  // Author's note & chat metadata
  'set_author_note',
  'get_author_note',
  'set_chat_metadata',
  'get_chat_metadata',
  'rename_chat',
  // World info (character-linked book)
  'wi_list',
  'wi_get',
  'wi_add',
  'wi_remove',
  // Quiet one-shot generation (the held ChatLock shares the outer tenure)
  'generate',
  'genraw',
  'ask',
  'sysgen',
  // UI & timing
  'toast',
  'sleep',
  'delay',
  // Pure utilities
  'token_count',
  'count_tokens',
  'substitute_macros',
  'upper',
  'lower',
  'trim_tokens',
  'replace',
  'replace_regex',
  'match',
  'test',
  'substring',
  'trim_start',
  'trim_end',
  'random',
  'now',
  'array_wrap',
  'array_unwrap',
  'pass',
  'is_empty',
  'len',
  'join',
  'split',
  'includes',
  'starts_with',
  'ends_with',
  'json_encode',
  'json_decode',
  'abs',
  'floor',
  'ceil',
  'round',
  'clamp',
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
