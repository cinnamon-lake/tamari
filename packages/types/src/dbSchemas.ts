/**
 * Zod schemas for raw SQLite row shapes.
 *
 * These validate the data returned by `@libsql/client` *before* JSON parsing
 * and type conversion (e.g. INTEGER → boolean, TEXT JSON → object).
 */

import { z } from 'zod';

export const CharacterRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  personality: z.string().nullable(),
  scenario: z.string().nullable(),
  first_mes: z.string().nullable(),
  mes_example: z.string().nullable(),
  creator: z.string().nullable(),
  character_version: z.string().nullable(),
  tags: z.string(),
  avatar_path: z.string().nullable(),
  avatar_thumbnail_path: z.string().nullable(),
  creator_notes: z.string(),
  system_prompt: z.string(),
  post_history_instructions: z.string(),
  alternate_greetings: z.string(),
  group_only_greetings: z.string(),
  nickname: z.string(),
  creator_notes_multilingual: z.string(),
  source: z.string(),
  extensions: z.string(),
  create_date: z.string(),
  world_info_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

/** Projection for `listSummaries` (sidebar/list views) — a strict subset of CharacterRowSchema. */
export const CharacterSummaryRowSchema = CharacterRowSchema.pick({
  id: true,
  name: true,
  tags: true,
  avatar_path: true,
  avatar_thumbnail_path: true,
  created_at: true,
  updated_at: true,
});

export const CharacterAssetRowSchema = z.object({
  id: z.string(),
  character_id: z.string(),
  name: z.string(),
  type: z.string(),
  ext: z.string(),
  file_path: z.string().nullable(),
  meta: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const ChatRowSchema = z.object({
  id: z.string(),
  character_id: z.string().nullable(),
  persona_id: z.string().nullable(),
  name: z.string(),
  head_message_id: z.number().nullable(),
  active_child_id: z.number().nullable(),
  materialized: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
  metadata: z.string(),
  forked_from_chat_id: z.string().nullable(),
  forked_at_message_id: z.number().nullable(),
});

/** Projection for `listChatSummaries` — a strict subset of ChatRowSchema. */
export const ChatSummaryRowSchema = ChatRowSchema.pick({
  id: true,
  character_id: true,
  name: true,
  created_at: true,
  updated_at: true,
  forked_from_chat_id: true,
  forked_at_message_id: true,
});

export const MessageRowSchema = z.object({
  id: z.number(),
  parent_id: z.number().nullable(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  extra: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const WorldInfoRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  entries: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const PersonaRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  avatar_path: z.string().nullable(),
  avatar_thumbnail_path: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

/** Projection for `listSummaries` — a strict subset of PersonaRowSchema. */
export const PersonaSummaryRowSchema = PersonaRowSchema.pick({
  id: true,
  name: true,
  description: true,
  avatar_path: true,
  avatar_thumbnail_path: true,
});

export const BackendConfigRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  backend_provider: z.string(),
  generation_mode: z.string(),
  model: z.string(),
  temperature: z.number().nullable(),
  max_tokens: z.number().nullable(),
  top_p: z.number().nullable(),
  top_k: z.number().nullable(),
  min_p: z.number().nullable(),
  top_a: z.number().nullable(),
  repetition_penalty: z.number().nullable(),
  frequency_penalty: z.number().nullable(),
  presence_penalty: z.number().nullable(),
  instruct_template: z.string(),
  context_length: z.number().nullable(),
  prompt_history_limit: z.number().nullable(),
  provider_params_json: z.string(),
  stop_strings_json: z.string(),
  openrouter_provider: z.string().nullable(),
  api_url: z.string().nullable(),
  api_key: z.string().nullable(),
  logit_bias_json: z.string().nullable(),
  supports_images: z.number().nullable(),
  supports_audio: z.number().nullable(),
  supports_video: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const PromptListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  prompts_json: z.string(),
  prompt_order_json: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const ChatMemberRowSchema = z.object({
  chat_id: z.string(),
  character_id: z.string(),
  talkativeness: z.number(),
  depth_prompt: z.string(),
  depth_prompt_depth: z.number(),
  enabled: z.number(),
});

export const GenerationRowSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  message_id: z.number().nullable(),
  status: z.enum(['pending', 'streaming', 'complete', 'error', 'aborted']),
  backend: z.string(),
  prompt_tokens: z.number().nullable(),
  completion_tokens: z.number().nullable(),
  error_message: z.string().nullable(),
  kind: z.enum(['send', 'regenerate', 'continue', 'impersonate', 'quiet', 'genraw', 'subagent']),
  parent_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const SecretRowSchema = z.object({
  key: z.string(),
  value: z.string(),
  label: z.string().nullable(),
  updated_at: z.number(),
});

export const QuickReplyRowSchema = z.object({
  id: z.string(),
  scope: z.enum(['global', 'character', 'chat']),
  scope_id: z.string(),
  label: z.string(),
  icon: z.string(),
  color: z.string(),
  script: z.string(),
  language: z.string(),
  auto_execute: z.number(),
  order_index: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const CustomBackendRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  lua_source: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const AttachmentRowSchema = z.object({
  id: z.string(),
  message_id: z.number().nullable(),
  mime_type: z.string(),
  blob: z.unknown().nullable().optional(),
  file_path: z.string().nullable(),
  meta: z.string(),
});

export const ToolTemplateRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  config_schema: z.string(),
  sandbox: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const ToolsetRowSchema = z.object({
  id: z.string(),
  template_id: z.string(),
  name: z.string(),
  config: z.string(),
  tool_overrides: z.string(),
  enabled: z.number(),
  agent_visible: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
