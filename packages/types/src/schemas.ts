/**
 * Zod validation schemas for all API and WS payloads.
 */

import { z } from 'zod';

import type { MessageExtra } from './db.js';

type UnwrapDefault<S> = S extends z.ZodDefault<infer Inner> ? Inner : S;

function makeUpdateSchema<T extends z.ZodRawShape>(shape: T) {
  const newShape = {} as { [K in keyof T]: z.ZodOptional<UnwrapDefault<T[K]>> };
  for (const [key, schema] of Object.entries(shape)) {
    let s = schema as z.ZodTypeAny;
    if (s instanceof z.ZodDefault) {
      s = s.removeDefault() as z.ZodTypeAny;
    }
    (newShape as Record<string, z.ZodTypeAny>)[key] = s.optional();
  }
  return z.object(newShape);
}

// ---------- Shared primitives ----------

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

export const AttachmentRefSchema = z.object({
  id: z.string().uuid(),
  mimeType: z.string(),
  meta: z.record(z.string(), z.unknown()).default({}),
  url: z.string(),
});

export const QuickReplyInsertSchema = z.object({
  scope: z.enum(['global', 'character', 'chat']),
  scopeId: z.string(),
  label: z.string(),
  icon: z.string().default(''),
  color: z.string().default(''),
  script: z.string().default(''),
  language: z.string().default('lua'),
  autoExecute: z.number().int().default(0),
  orderIndex: z.number().int().default(0),
});

export const QuickReplyUpdateSchema = makeUpdateSchema(QuickReplyInsertSchema.shape);

// ---------- Custom Backend schemas ----------

export const CustomBackendInsertSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().default(''),
  luaSource: z.string().default(''),
});

export const CustomBackendUpdateSchema = makeUpdateSchema(CustomBackendInsertSchema.shape);

// ---------- Character schemas ----------

export const CharacterAssetInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().default(''),
  type: z.string().default('other'),
  ext: z.string().default('png'),
  filePath: z.string().nullable().default(null),
  meta: z.record(z.string(), z.unknown()).default({}),
});

export const CharacterCreateInputSchema = z.object({
  name: z.string().min(1).max(512),
  description: z.string().default(''),
  personality: z.string().default(''),
  scenario: z.string().default(''),
  firstMes: z.string().default(''),
  mesExample: z.string().default(''),
  creator: z.string().default(''),
  characterVersion: z.string().default(''),
  tags: z.array(z.string()).default([]),
  creatorNotes: z.string().default(''),
  systemPrompt: z.string().default(''),
  postHistoryInstructions: z.string().default(''),
  alternateGreetings: z.array(z.string()).default([]),
  groupOnlyGreetings: z.array(z.string()).default([]),
  nickname: z.string().default(''),
  creatorNotesMultilingual: z.record(z.string(), z.string()).default({}),
  source: z.array(z.string()).default([]),
  extensions: z.record(z.string(), z.unknown()).default({}),
  createDate: z.string().default(''),
  worldInfoId: z.string().nullable().optional(),
  assets: z.array(CharacterAssetInputSchema).optional(),
});

export const CharacterUpdateSchema = makeUpdateSchema(CharacterCreateInputSchema.shape);

// ---------- Chat schemas ----------

export const CreateChatRequestSchema = z.object({
  characterId: z.string().nullable(),
  personaId: z.string().nullable().optional(),
  name: z.string().min(1).max(512),
});

// ---------- Message schemas ----------

export const MessageInsertSchema = z.object({
  chatId: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  extra: z.record(z.string(), z.unknown()).default({}),
  parentId: z.number().int().nullable().optional(),
});

export const MessageUpdateSchema = makeUpdateSchema(MessageInsertSchema.shape).omit({ chatId: true, parentId: true });

// ---------- World Info schemas ----------

export const WorldInfoEntrySchema = z.object({
  id: z.string().min(1),
  keys: z.array(z.string()).default([]),
  content: z.string().default(''),
  comment: z.string().default(''),
  order: z.number().int().default(0),
  position: z.enum(['before_char', 'after_char', 'top', 'bottom', 'atDepth']).default('before_char'),
  depth: z.number().int().optional(),
  role: z.enum(['system', 'user', 'assistant']).optional(),
  probability: z.number().min(0).max(100).default(100),
  constant: z.boolean().default(false),
  selective: z.boolean().default(false),
  secondaryKeys: z.array(z.string()).default([]),
  addMemo: z.boolean().default(false),
  disable: z.boolean().default(false),
  regex: z.boolean().default(false),
  recursive: z.boolean().default(false),
  retrievalMode: z.enum(['keyword', 'semantic', 'constant']).optional(),
  sticky: z.number().int().min(0).optional(),
  cooldown: z.number().int().min(0).optional(),
  delay: z.number().int().min(0).optional(),
});

export const WorldInfoEntryInsertSchema = WorldInfoEntrySchema.omit({ id: true });

export const WorldInfoEntryUpdateSchema = makeUpdateSchema(WorldInfoEntryInsertSchema.shape);

export const WorldInfoInsertSchema = z.object({
  name: z.string().min(1).max(512),
  entries: z.array(WorldInfoEntryInsertSchema).default([]),
});

export const WorldInfoUpdateSchema = makeUpdateSchema(WorldInfoInsertSchema.shape);

// ---------- Settings schemas ----------

export const PersonaCreateInputSchema = z.object({
  name: z.string().min(1).max(512),
  description: z.string().default(''),
});

export const PersonaUpdateSchema = makeUpdateSchema(PersonaCreateInputSchema.shape);

export const SettingsSetSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

// ---------- Preset schemas ----------

export const PresetPromptDefInputSchema = z.object({
  identifier: z.string().min(1),
  name: z.string().default(''),
  content: z.string().default(''),
  role: z.enum(['system', 'user', 'assistant']).default('system'),
  enabled: z.boolean().default(true),
  systemPrompt: z.boolean().optional(),
  marker: z.boolean().optional(),
  injectionPosition: z.enum(['relative', 'absolute']).optional(),
  injectionDepth: z.number().int().optional(),
  injectionOrder: z.number().int().optional(),
  forbidOverrides: z.boolean().optional(),
});

export const PresetPromptOrderEntryInputSchema = z.object({
  identifier: z.string().min(1),
  enabled: z.boolean().default(true),
});

export const BackendConfigCreateInputSchema = z.object({
  name: z.string().min(1).max(512),
  description: z.string().default(''),
  backendProvider: z.string().default('openai'),
  generationMode: z.enum(['chat', 'text']).default('chat'),
  model: z.string().default(''),
  apiUrl: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional(),
  temperature: z.number().nullable().optional(),
  maxTokens: z.number().int().nullable().optional(),
  topP: z.number().nullable().optional(),
  topK: z.number().int().nullable().optional(),
  minP: z.number().nullable().optional(),
  topA: z.number().nullable().optional(),
  repetitionPenalty: z.number().nullable().optional(),
  frequencyPenalty: z.number().nullable().optional(),
  presencePenalty: z.number().nullable().optional(),
  instructTemplate: z.string().default(''),
  contextLength: z.number().int().nullable().optional(),
  promptHistoryLimit: z.number().int().nullable().optional(),
  providerParams: z.record(z.string(), z.unknown()).default({}),
  stopStrings: z.array(z.string()).default([]),
  openrouterProvider: z.string().nullable().optional(),
  logitBias: z.record(z.string(), z.number()).nullable().optional(),
  supportsImages: z.boolean().default(true),
  supportsAudio: z.boolean().default(true),
  supportsVideo: z.boolean().default(true),
});

export const BackendConfigUpdateSchema = makeUpdateSchema(BackendConfigCreateInputSchema.shape);

export const PromptListCreateInputSchema = z.object({
  name: z.string().min(1).max(512),
  description: z.string().default(''),
  prompts: z.array(PresetPromptDefInputSchema).default([]),
  promptOrder: z.array(PresetPromptOrderEntryInputSchema).default([]),
});

export const PromptListUpdateSchema = makeUpdateSchema(PromptListCreateInputSchema.shape);

// ---------- Settings schema ----------

// Memory
const MemorySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  updateInterval: z.number().int().min(1).default(5),
  depth: z.number().int().min(0).default(10),
  backendConfigId: z.string().default(''),
  systemPrompt: z
    .string()
    .default(
      'Summarize the most important facts and events in the story so far. For each event, include a citation to the message ID(s) it came from using [msg:ID] format. Be concise.',
    ),
  maxSummaryTokens: z.number().int().min(1).default(512),
});

const _AppSettingsSchema = z.object({
  // Backend / Connection
  activeBackendConfigId: z.string().default(''),
  activePromptListId: z.string().default(''),
  autoLoadLastChat: z.boolean().default(false),
  lastChatId: z.string().default(''),
  backendProvider: z.string().default('openai'),
  apiUrl: z.string().nullable().default(null),
  apiKey: z.string().nullable().default(null),
  model: z.string().default(''),
  'custom.requestScript': z.string().default(''),
  userName: z.string().default('User'),

  // Generation
  generationMode: z.enum(['chat', 'text']).default('chat'),
  contextLength: z.number().int().nullable().default(4096),
  maxResponseTokens: z.number().int().default(512),
  impersonationPrompt: z.string().default(''),

  // Memory
  memory: MemorySettingsSchema.default({
    enabled: false,
    updateInterval: 5,
    depth: 10,
    backendConfigId: '',
    systemPrompt:
      'Summarize the most important facts and events in the story so far. For each event, include a citation to the message ID(s) it came from using [msg:ID] format. Be concise.',
    maxSummaryTokens: 512,
  }),

  // OpenRouter
  'openrouter.providerOrder': z.array(z.string()).default([]),
  'openrouter.allowFallbacks': z.boolean().default(true),
  'openrouter.transforms': z.array(z.unknown()).default([]),
  'openrouter.plugins': z.array(z.unknown()).default([]),
  'openrouter.reasoningEffort': z.string().default(''),
  'openrouter.reasoningSummary': z.string().default(''),

  // Provider params (opaque JSON blobs)
  'openai.params': z.record(z.string(), z.unknown()).default({}),
  'claude.params': z.record(z.string(), z.unknown()).default({}),
  'gemini.params': z.record(z.string(), z.unknown()).default({}),
  'textgen.params': z.record(z.string(), z.unknown()).default({}),

  // TTS
  'tts.provider': z.string().default(''),
  'tts.enabled': z.boolean().default(false),
  'tts.fishaudio.baseUrl': z.string().default('http://127.0.0.1:8080'),
  'tts.fishaudio.apiKey': z.string().default(''),
  'tts.fishaudio.voiceId': z.string().default(''),
  'tts.fishaudio.format': z.string().default('wav'),
  'tts.fishaudio.temperature': z.number().default(0.8),
  'tts.kokoro.baseUrl': z.string().default('http://127.0.0.1:8880'),
  'tts.kokoro.apiKey': z.string().default(''),
  'tts.kokoro.voiceId': z.string().default(''),
  'tts.kokoro.format': z.string().default('wav'),
  'tts.kokoro.speed': z.number().default(1.0),
  'tts.elevenlabs.baseUrl': z.string().default('https://api.elevenlabs.io'),
  'tts.elevenlabs.apiKey': z.string().default(''),
  'tts.elevenlabs.voiceId': z.string().default(''),
  'tts.elevenlabs.model': z.string().default('eleven_multilingual_v2'),
  'tts.openai.baseUrl': z.string().default('https://api.openai.com'),
  'tts.openai.apiKey': z.string().default(''),
  'tts.openai.voiceId': z.string().default(''),
  'tts.openai.model': z.string().default('gpt-4o-mini-tts'),
  'tts.azure.baseUrl': z.string().default('https://eastus.tts.speech.microsoft.com'),
  'tts.azure.apiKey': z.string().default(''),
  'tts.azure.voiceId': z.string().default(''),
  'tts.minimax.baseUrl': z.string().default('https://api.minimax.io'),
  'tts.minimax.apiKey': z.string().default(''),
  'tts.minimax.voiceId': z.string().default(''),
  'tts.minimax.model': z.string().default('speech-02-hd'),
  'tts.volcengine.baseUrl': z.string().default('https://openspeech.bytedance.com'),
  'tts.volcengine.apiKey': z.string().default(''),
  'tts.volcengine.appId': z.string().default(''),
  'tts.volcengine.cluster': z.string().default('volcano_tts'),
  'tts.volcengine.voiceId': z.string().default(''),
  'tts.alltalk.baseUrl': z.string().default('http://127.0.0.1:7851'),
  'tts.alltalk.voiceId': z.string().default(''),
  'tts.vits.baseUrl': z.string().default('http://127.0.0.1:23456'),
  'tts.vits.apiKey': z.string().default(''),
  'tts.vits.voiceId': z.string().default(''),
  'tts.silero.baseUrl': z.string().default('http://127.0.0.1:8001'),
  'tts.silero.voiceId': z.string().default(''),
  'tts.gptsovits.baseUrl': z.string().default('http://127.0.0.1:9880'),
  'tts.gptsovits.voiceId': z.string().default(''),

  // Proxy
  'proxy.enabled': z.boolean().default(false),
  'proxy.url': z.string().default(''),
  'proxy.bypass': z.array(z.string()).default([]),

  // Prompt / Context
  chatMessageLoadLimit: z.number().int().default(30),
  promptHistoryLimit: z.number().int().default(100),
  chatTruncation: z.number().int().default(0),
  instructTemplates: z.array(z.unknown()).default([]),
  reasoningTemplate: z.string().default('none'),
  reasoningAddToPrompts: z.boolean().default(false),
  reasoningTemplates: z.array(z.unknown()).default([]),

  // Auto-continue
  autoContinueEnabled: z.boolean().default(false),
  autoContinueTargetLength: z.number().int().default(100),

  // Claude prompt caching
  claudeCacheMode: z.enum(['off', 'auto', 'manual']).default('off'),
  claudeCacheDepth: z.number().int().default(0),
  claudeCacheTTL: z.string().nullable().default(null),
  // Append-only prompt layout: render turns as strict byte-prefixes of each
  // other (snapshot-cache friendly) by disabling depth injections, non-constant
  // WI, macros, prompt/output regex, and output post-processing.
  appendOnlyPromptLayout: z.boolean().default(false),

  // Post-processing
  whitespaceMode: z.string().default('none'),
  removeXML: z.boolean().default(false),
  singleLine: z.boolean().default(false),
  trimSentences: z.boolean().default(false),
  autoFixGeneratedMarkdown: z.boolean().default(false),
  regexRules: z.array(z.unknown()).default([]),
  customStoppingStrings: z.array(z.string()).default([]),
  customStoppingStringsMacro: z.boolean().default(false),
  stripExamples: z.boolean().default(false),
  enabledToolsets: z.array(z.string()).default([]),
  enabledTools: z.array(z.string()).default([]),
  toolConfigs: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  globalVars: z.record(z.string(), z.string()).default({}),

  // UI / Display
  sendOnEnter: z.enum(['enabled', 'disabled', 'auto']).default('auto'),
  restoreUserInput: z.boolean().default(true),
  autoSelectInput: z.boolean().default(false),
  quickImpersonate: z.boolean().default(false),
  quickContinue: z.boolean().default(false),
  hideQuickReplies: z.boolean().default(false),
  showQuickReplyBar: z.boolean().default(true),
  showHiddenMessages: z.boolean().default(false),
  autoScrollToBottom: z.boolean().default(true),
  autoSaveMessageEdits: z.boolean().default(false),
  confirmMessageDelete: z.boolean().default(true),
  useSoftFork: z.boolean().default(false),
  messageTokenCountEnabled: z.boolean().default(false),
  timerEnabled: z.boolean().default(false),
  timestampModelIcon: z.boolean().default(false),
  clickToEdit: z.boolean().default(false),
  mediaDisplayMode: z.string().default('list'),
  fontScale: z.number().default(1),
  chatWidth: z.number().default(50),
  avatarStyle: z.string().default('circle'),
  chatStyle: z.string().default('default'),
  noShadows: z.boolean().default(false),
  shadowWidth: z.number().default(1),
  compactInputArea: z.boolean().default(false),
  reducedMotion: z.boolean().default(false),
  blurStrength: z.number().default(5),
  backgroundImageUrl: z.string().default(''),
  backgroundBlur: z.number().default(0),
  themeCustomCss: z.string().default(''),
  neverResizeAvatars: z.boolean().default(false),
  charListGrid: z.boolean().default(false),
  disableGroupTrimming: z.boolean().default(false),
  mediaVerboseMode: z.boolean().default(false),
  hideChatAvatars: z.boolean().default(false),
  hideChatNames: z.boolean().default(false),
  // UI language (BCP-47-ish code, e.g. 'en'). Source of truth for i18n; client derives its locale from this.
  language: z.string().default('en'),

  // Swipes
  swipeNumbersOnAllMessages: z.boolean().default(false),

  // Messages
  showMessageIds: z.boolean().default(false),
  encodeTags: z.boolean().default(false),

  // Streaming
  smoothStreaming: z.boolean().default(false),
  smoothStreamingDelay: z.number().default(25),
  messageSoundEnabled: z.boolean().default(false),
  messageSoundUnfocusedOnly: z.boolean().default(true),
  streamFadeIn: z.boolean().default(true),

  // Toasts
  toastPosition: z
    .enum(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'])
    .default('top-right'),

  // Security
  strictHtmlSanitization: z.boolean().default(false),
  allowExternalMedia: z.boolean().default(false),

  // Search
  fuzzySearch: z.boolean().default(false),

  // Hotswap
  showHotswapBar: z.boolean().default(true),
});

/** Runtime schema that accepts unknown keys (for forward compat). */
export const AppSettingsSchema = _AppSettingsSchema.catchall(z.unknown());

/** Type-safe settings shape without the index signature. */
export type AppSettings = z.infer<typeof _AppSettingsSchema>;

// ---------- Entity schemas ----------

export const CharacterAssetSchema = z.object({
  id: z.string(),
  characterId: z.string(),
  name: z.string(),
  type: z.string(),
  ext: z.string(),
  filePath: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
  updatedAt: z.number(),
  assetUrl: z.string().nullable().optional(),
  uri: z.string().nullable().optional(),
});

export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  personality: z.string(),
  scenario: z.string(),
  firstMes: z.string(),
  mesExample: z.string(),
  creator: z.string(),
  characterVersion: z.string(),
  tags: z.array(z.string()),
  avatarPath: z.string().nullable(),
  avatarThumbnailPath: z.string().nullable(),
  avatarUrl: z.string().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  exportUrl: z.string().nullable().optional(),
  charxUrl: z.string().nullable().optional(),
  avatarUploadUrl: z.string().nullable().optional(),
  creatorNotes: z.string(),
  systemPrompt: z.string(),
  postHistoryInstructions: z.string(),
  alternateGreetings: z.array(z.string()),
  groupOnlyGreetings: z.array(z.string()),
  nickname: z.string(),
  creatorNotesMultilingual: z.record(z.string(), z.string()),
  source: z.array(z.string()),
  extensions: z.record(z.string(), z.unknown()),
  createDate: z.string(),
  worldInfoId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  assets: z.array(CharacterAssetSchema).optional(),
});

export const CharacterSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
  avatarUrl: z.string().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  exportUrl: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ChatSchema = z.object({
  id: z.string(),
  characterId: z.string().nullable(),
  personaId: z.string().nullable(),
  name: z.string(),
  headMessageId: z.number().nullable(),
  activeChildId: z.number().nullable(),
  materialized: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  metadata: z.record(z.string(), z.unknown()),
  forkedFromChatId: z.string().nullable(),
  forkedAtMessageId: z.number().nullable(),
  jsonlExportUrl: z.string().nullable().optional(),
  txtExportUrl: z.string().nullable().optional(),
});

export const ChatSummarySchema = z.object({
  id: z.string(),
  characterId: z.string().nullable(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  forkedFromChatId: z.string().nullable(),
  forkedAtMessageId: z.number().nullable(),
});

/**
 * Boundary validation for `Message.extra`: any JSON object passes (fields are
 * validated structurally by consumers), but the OUTPUT type is the typed
 * `MessageExtra` so repos narrow once instead of every consumer re-casting.
 */
export const MessageExtraSchema = z.custom<MessageExtra>(
  (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
);

export const MessageSchema = z.object({
  id: z.number(),
  parentId: z.number().nullable(),
  role: MessageRoleSchema,
  extra: MessageExtraSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  renderedHtml: z.array(z.string().nullable()).optional(),
});

export const WorldInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  entries: z.array(WorldInfoEntrySchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const PersonaSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  avatarPath: z.string().nullable(),
  avatarThumbnailPath: z.string().nullable(),
  avatarUrl: z.string().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  avatarUploadUrl: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const PersonaSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  avatarUrl: z.string().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  avatarUploadUrl: z.string().nullable().optional(),
});

export const PresetPromptDefSchema = z.object({
  identifier: z.string(),
  name: z.string(),
  content: z.string(),
  role: z.enum(['system', 'user', 'assistant']),
  enabled: z.boolean(),
  systemPrompt: z.boolean().optional(),
  marker: z.boolean().optional(),
  injectionPosition: z.enum(['relative', 'absolute']).optional(),
  injectionDepth: z.number().optional(),
  injectionOrder: z.number().optional(),
  forbidOverrides: z.boolean().optional(),
});

export const PresetPromptOrderEntrySchema = z.object({
  identifier: z.string(),
  enabled: z.boolean(),
});

export const BackendConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  backendProvider: z.string(),
  generationMode: z.enum(['chat', 'text']),
  model: z.string(),
  apiUrl: z.string().nullable(),
  apiKey: z.string().nullable(),
  temperature: z.number().nullable(),
  maxTokens: z.number().nullable(),
  topP: z.number().nullable(),
  topK: z.number().nullable(),
  minP: z.number().nullable(),
  topA: z.number().nullable(),
  repetitionPenalty: z.number().nullable(),
  frequencyPenalty: z.number().nullable(),
  presencePenalty: z.number().nullable(),
  instructTemplate: z.string(),
  contextLength: z.number().nullable(),
  promptHistoryLimit: z.number().nullable(),
  providerParams: z.record(z.string(), z.unknown()),
  stopStrings: z.array(z.string()),
  openrouterProvider: z.string().nullable(),
  logitBias: z.record(z.string(), z.number()).nullable(),
  supportsImages: z.boolean(),
  supportsAudio: z.boolean(),
  supportsVideo: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const BackendConfigSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const PromptListSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  prompts: z.array(PresetPromptDefSchema),
  promptOrder: z.array(PresetPromptOrderEntrySchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const PromptListSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const ChatMemberSchema = z.object({
  chatId: z.string(),
  characterId: z.string(),
  talkativeness: z.number(),
  depthPrompt: z.string(),
  depthPromptDepth: z.number(),
  enabled: z.boolean(),
});

export const ChatMemberSummarySchema = z.object({
  chatId: z.string(),
  characterId: z.string(),
  talkativeness: z.number(),
  depthPrompt: z.string(),
  depthPromptDepth: z.number(),
  enabled: z.boolean(),
  characterName: z.string(),
  characterAvatarUrl: z.string().nullable(),
  characterThumbnailUrl: z.string().nullable(),
});

export const GenerationSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  messageId: z.number().nullable(),
  status: z.enum(['pending', 'streaming', 'complete', 'error', 'aborted']),
  backend: z.string(),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const GenerationSnapshotSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  messageId: z.number(),
  text: z.string(),
  reasoning: z.string().optional(),
});

export const QuickReplySchema = z.object({
  id: z.string(),
  scope: z.enum(['global', 'character', 'chat']),
  scopeId: z.string(),
  label: z.string(),
  icon: z.string(),
  color: z.string(),
  script: z.string(),
  language: z.string(),
  autoExecute: z.number(),
  orderIndex: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const CustomBackendSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  luaSource: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** Dry-run outcome for `custombackend.test` (mirrors DryRunOutcome in server customBackendDryRun.ts). */
export const CustomBackendTestOutcomeSchema = z.object({
  ok: z.boolean(),
  text: z.string().optional(),
  reasoning: z.string().optional(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) }))
    .optional(),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }),
  stateOut: z.string().optional(),
  delegations: z.array(
    z.object({ configId: z.string().nullable(), promptPreview: z.string(), response: z.string() }),
  ),
  debug: z.string().optional(),
  error: z.string().optional(),
});
export type CustomBackendTestOutcome = z.infer<typeof CustomBackendTestOutcomeSchema>;

export const ToolInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        parameters: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
});

/**
 * Per-template Lua sandbox flags for DB-stored Lua tool templates.
 * Everything off (or absent) = fully sandboxed. Note: `os.execute`/`os.exit`
 * stay stripped even under `allowOs` (they crash/abort the wasmoon engine).
 * `allowNet` exposes an SSRF-guarded async `fetch` global (loopback allowed —
 * local media servers are the point — other private ranges blocked).
 * `allowFiles` exposes `attachments.create` for saving generated media.
 */
export const LuaSandboxFlagsSchema = z.object({
  allowIo: z.boolean().optional(),
  allowOs: z.boolean().optional(),
  allowDebug: z.boolean().optional(),
  allowRequire: z.boolean().optional(),
  allowNet: z.boolean().optional(),
  allowFiles: z.boolean().optional(),
  allowSt: z.boolean().optional(),
});
export type LuaSandboxFlags = z.infer<typeof LuaSandboxFlagsSchema>;

export const ToolTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  configSchema: z.record(z.string(), z.unknown()).default({}),
  sandbox: LuaSandboxFlagsSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ToolTemplateCreateSchema = ToolTemplateSchema.omit({ id: true, createdAt: true, updatedAt: true });
export const ToolTemplateUpdateSchema = makeUpdateSchema(ToolTemplateSchema.shape).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const ToolsetSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()).default({}),
  toolOverrides: z
    .record(
      z.string(),
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        parameterDescriptions: z.record(z.string(), z.string()).optional(),
      }),
    )
    .default({}),
  enabled: z.boolean().default(true),
  agentVisible: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ToolsetCreateSchema = ToolsetSchema.omit({ id: true, createdAt: true, updatedAt: true });
export const ToolsetUpdateSchema = makeUpdateSchema(ToolsetSchema.shape).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const FullStateSchema = z.object({
  characters: z.array(CharacterSummarySchema),
  chats: z.array(ChatSummarySchema),
  settings: AppSettingsSchema,
  generation: GenerationSnapshotSchema.optional(),
  personas: z.array(PersonaSummarySchema).optional(),
  backendConfigs: z.array(BackendConfigSummarySchema).optional(),
  promptLists: z.array(PromptListSummarySchema).optional(),
  tools: z.array(ToolInfoSchema).optional(),
  toolTemplates: z.array(ToolTemplateSchema).optional(),
  toolsets: z.array(ToolsetSchema).optional(),
});

// ---------- Client message schemas ----------

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().optional() }),
  z.object({
    type: z.literal('chat.load'),
    chatId: z.string(),
    limit: z.number().int().optional(),
    beforeId: z.number().int().optional(),
    offset: z.number().int().optional(),
  }),
  z.object({ type: z.literal('chat.select'), chatId: z.string(), limit: z.number().int().optional() }),
  z.object({ type: z.literal('character.select'), characterId: z.string() }),
  z.object({ type: z.literal('persona.select'), personaId: z.string() }),
  z.object({ type: z.literal('worldinfo.select'), bookId: z.string() }),
  z.object({
    type: z.literal('action.send'),
    chatId: z.string(),
    content: z.string(),
    personaId: z.string().optional(),
    attachments: z.array(AttachmentRefSchema).optional(),
  }),
  // Atomic send+generate: appends the user message, runs USER_MESSAGE
  // auto-execute quick replies, then generates — all in one dispatch so the
  // pair can't be reordered by concurrent dispatches (the old action.send +
  // action.generate sequence raced at the chat mutex).
  z.object({
    type: z.literal('action.sendAndGenerate'),
    chatId: z.string(),
    content: z.string(),
    personaId: z.string().optional(),
    attachments: z.array(AttachmentRefSchema).optional(),
  }),
  z.object({
    type: z.literal('action.generate'),
    chatId: z.string(),
  }),
  z.object({
    type: z.literal('action.regenerate'),
    chatId: z.string(),
    messageId: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('action.swipe'),
    chatId: z.string(),
    // Optional: omitted means "swipe the chat's active message" (see performSwipe).
    messageId: z.number().int().optional(),
    direction: z.enum(['left', 'right']),
  }),
  z.object({
    type: z.literal('action.edit'),
    chatId: z.string(),
    messageId: z.number().int(),
    content: z.string(),
    // When set, edit exactly this part (must be a text part). When omitted,
    // the LAST text part is targeted — the definitive answer after any
    // reasoning/tool parts — or one is appended if none exists.
    partIndex: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('action.delete'),
    chatId: z.string(),
    messageId: z.number().int(),
  }),
  z.object({
    type: z.literal('action.hide'),
    chatId: z.string(),
    messageId: z.number().int(),
  }),
  z.object({
    type: z.literal('action.unhide'),
    chatId: z.string(),
    messageId: z.number().int(),
  }),
  z.object({
    type: z.literal('action.system'),
    chatId: z.string(),
    content: z.string(),
  }),
  z.object({
    type: z.literal('action.cut'),
    chatId: z.string(),
    count: z.number().int().min(1),
  }),
  z.object({
    type: z.literal('action.continue'),
    chatId: z.string(),
  }),
  z.object({ type: z.literal('action.impersonate'), chatId: z.string() }),
  z.object({
    type: z.literal('action.stop'),
    generationId: z.string(),
  }),
  z.object({
    type: z.literal('action.gen'),
    chatId: z.string(),
    prompt: z.string(),
  }),
  z.object({
    type: z.literal('action.genraw'),
    chatId: z.string(),
    prompt: z.string(),
  }),
  z.object({
    type: z.literal('action.ask'),
    chatId: z.string(),
    characterName: z.string(),
    content: z.string(),
  }),
  z.object({
    type: z.literal('action.sysgen'),
    chatId: z.string(),
    content: z.string(),
  }),
  z.object({
    type: z.literal('chat.create'),
    data: CreateChatRequestSchema,
  }),
  z.object({
    type: z.literal('chat.update'),
    chatId: z.string(),
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('chat.delete'),
    chatId: z.string(),
  }),
  z.object({
    type: z.literal('chat.reset'),
    chatId: z.string(),
  }),
  z.object({
    type: z.literal('chat.softFork'),
    chatId: z.string(),
    messageId: z.number().int(),
    name: z.string(),
  }),
  z.object({
    type: z.literal('chat.hardFork'),
    chatId: z.string(),
    messageId: z.number().int(),
    name: z.string(),
  }),
  z.object({
    type: z.literal('chat.list'),
    characterId: z.string().optional(),
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('character.create'),
    data: CharacterCreateInputSchema,
  }),
  z.object({
    type: z.literal('character.update'),
    characterId: z.string(),
    patch: CharacterUpdateSchema,
  }),
  z.object({
    type: z.literal('character.delete'),
    characterId: z.string(),
  }),
  z.object({
    type: z.literal('settings.set'),
    key: z.string(),
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('settings.get'),
    keys: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('worldinfo.list') }),
  z.object({
    type: z.literal('worldinfo.create'),
    data: z.object({ name: z.string(), entries: z.array(WorldInfoEntryInsertSchema).optional() }),
  }),
  z.object({
    type: z.literal('worldinfo.update'),
    bookId: z.string(),
    patch: z.object({ name: z.string().optional(), entries: z.array(WorldInfoEntryInsertSchema).optional() }),
  }),
  z.object({ type: z.literal('worldinfo.delete'), bookId: z.string() }),
  z.object({
    type: z.literal('worldinfo.entry.create'),
    bookId: z.string(),
    data: WorldInfoEntryInsertSchema,
  }),
  z.object({
    type: z.literal('worldinfo.entry.update'),
    bookId: z.string(),
    entryId: z.string(),
    patch: makeUpdateSchema(WorldInfoEntryInsertSchema.shape),
  }),
  z.object({ type: z.literal('worldinfo.entry.delete'), bookId: z.string(), entryId: z.string() }),
  z.object({ type: z.literal('worldinfo.test'), entries: z.array(WorldInfoEntrySchema), text: z.string() }),
  z.object({ type: z.literal('persona.list') }),
  z.object({ type: z.literal('persona.create'), data: PersonaCreateInputSchema }),
  z.object({ type: z.literal('persona.update'), personaId: z.string(), patch: PersonaUpdateSchema }),
  z.object({ type: z.literal('persona.delete'), personaId: z.string() }),
  z.object({ type: z.literal('backendConfig.list') }),
  z.object({ type: z.literal('backendConfig.select'), backendConfigId: z.string() }),
  z.object({ type: z.literal('backendConfig.create'), data: BackendConfigCreateInputSchema }),
  z.object({ type: z.literal('backendConfig.update'), backendConfigId: z.string(), patch: BackendConfigUpdateSchema }),
  z.object({ type: z.literal('backendConfig.delete'), backendConfigId: z.string() }),
  z.object({ type: z.literal('promptList.list') }),
  z.object({ type: z.literal('promptList.select'), promptListId: z.string() }),
  z.object({ type: z.literal('promptList.create'), data: PromptListCreateInputSchema }),
  z.object({ type: z.literal('promptList.update'), promptListId: z.string(), patch: PromptListUpdateSchema }),
  z.object({ type: z.literal('promptList.delete'), promptListId: z.string() }),
  z.object({ type: z.literal('group.members.get'), chatId: z.string() }),
  z.object({ type: z.literal('group.member.add'), chatId: z.string(), characterId: z.string() }),
  z.object({ type: z.literal('group.member.remove'), chatId: z.string(), characterId: z.string() }),
  z.object({
    type: z.literal('group.member.update'),
    chatId: z.string(),
    characterId: z.string(),
    patch: makeUpdateSchema(ChatMemberSchema.shape).omit({ chatId: true, characterId: true }),
  }),
  z.object({ type: z.literal('chat.materialize'), chatId: z.string(), selectedIndex: z.number().int().default(0) }),
  z.object({ type: z.literal('quickreply.list'), scope: z.enum(['global', 'character', 'chat']), scopeId: z.string() }),
  z.object({ type: z.literal('quickreply.listForChat'), chatId: z.string() }),
  z.object({ type: z.literal('quickreply.create'), data: QuickReplyInsertSchema }),
  z.object({ type: z.literal('quickreply.update'), id: z.string(), patch: QuickReplyUpdateSchema }),
  z.object({ type: z.literal('quickreply.delete'), id: z.string() }),
  z.object({ type: z.literal('quickreply.execute'), id: z.string(), chatId: z.string() }),
  z.object({ type: z.literal('quickreply.runStartup'), chatId: z.string() }),
  z.object({ type: z.literal('custombackend.list') }),
  z.object({ type: z.literal('custombackend.get'), id: z.string() }),
  z.object({ type: z.literal('custombackend.create'), data: CustomBackendInsertSchema }),
  z.object({ type: z.literal('custombackend.update'), id: z.string(), patch: CustomBackendUpdateSchema }),
  z.object({ type: z.literal('custombackend.delete'), id: z.string() }),
  z.object({
    type: z.literal('custombackend.test'),
    // Script source resolution order: luaSource > customBackendId > characterId's stored contextual backend.
    luaSource: z.string().optional(),
    customBackendId: z.string().optional(),
    characterId: z.string().optional(),
    // Module map for the sandboxed require. Explicit files win over the
    // character's stored extensions.contextualBackend.files.
    files: z.record(z.string(), z.string()).optional(),
    input: z.string().min(1),
    state: z.string().optional(),
    delegateResponse: z.string().optional(),
    requestId: z.string().optional(),
  }),
  z.object({ type: z.literal('toolset.create'), data: ToolsetCreateSchema }),
  z.object({ type: z.literal('toolset.update'), toolsetId: z.string(), patch: ToolsetUpdateSchema }),
  z.object({ type: z.literal('toolset.delete'), toolsetId: z.string() }),
  z.object({ type: z.literal('toolTemplate.create'), data: ToolTemplateCreateSchema }),
  z.object({ type: z.literal('toolTemplate.update'), toolTemplateId: z.string(), patch: ToolTemplateUpdateSchema }),
  z.object({ type: z.literal('toolTemplate.delete'), toolTemplateId: z.string() }),
]);

// ---------- Prompt schema ----------

const TextContentPartSchema = z.object({ type: z.literal('text'), text: z.string() });
const ImageContentPartSchema = z.object({
  type: z.literal('image'),
  source: z.string(),
  mimeType: z.string().optional(),
  detail: z.enum(['low', 'high', 'auto']).optional(),
});
const AudioContentPartSchema = z.object({
  type: z.literal('audio'),
  source: z.string(),
  mimeType: z.string().optional(),
});
const VideoContentPartSchema = z.object({
  type: z.literal('video'),
  source: z.string(),
  mimeType: z.string().optional(),
});

/** Parts that can be inlined inside a tool_result's content (matches `InlineContentPart` in pipeline.ts). */
const InlineContentPartSchema = z.union([
  TextContentPartSchema,
  ImageContentPartSchema,
  AudioContentPartSchema,
  VideoContentPartSchema,
]);

export const ContentPartSchema = z.union([
  TextContentPartSchema,
  ImageContentPartSchema,
  AudioContentPartSchema,
  VideoContentPartSchema,
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    name: z.string().optional(),
    // Templates produce either plain text or inline parts (e.g. ForgeImageTemplate
    // returns text + the generated image) — matches `ToolResultPart.content`.
    content: z.union([z.string(), z.array(InlineContentPartSchema)]),
    isError: z.boolean().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal('reasoning'), text: z.string(), signature: z.string().optional() }),
  z.object({ type: z.literal('backend_debug'), text: z.string() }),
]);

const PipelineMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  reasoningFormatted: z.string().optional(),
});

const ToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

const ResponseFormatSchema = z.union([
  z.object({ type: z.literal('json_schema'), schema: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('json_object') }),
  z.object({ type: z.literal('text') }),
]);

export const PromptSchema = z.object({
  messages: z.array(PipelineMessageSchema),
  tokenUsage: z.object({ prompt: z.number(), completion: z.number() }),
  systemPrompt: z.string().optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  responseFormat: ResponseFormatSchema.optional(),
  cacheDepth: z.number().optional(),
  wiActivations: z.array(z.string()).optional(),
});

// ---------- Server message schemas ----------

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('client.assigned'), clientId: z.string() }),
  z.object({ type: z.literal('auth.error'), message: z.string() }),
  z.object({ type: z.literal('snapshot'), state: FullStateSchema, clientId: z.string().optional() }),
  z.object({
    type: z.literal('chat.snapshot'),
    chat: ChatSchema,
    messages: z.array(MessageSchema),
    swipes: z.array(MessageSchema).optional(),
    character: CharacterSchema.optional(),
    persona: PersonaSchema.optional(),
    greeting: z.string().optional(),
    greetingHtml: z.string().optional(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('chat.listed'),
    chats: z.array(ChatSummarySchema),
    total: z.number().int(),
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('chat.created'), chat: ChatSchema, clientId: z.string().optional() }),
  z.object({
    type: z.literal('chat.updated'),
    chat: ChatSchema,
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('chat.deleted'), chatId: z.string(), clientId: z.string().optional() }),
  z.object({ type: z.literal('chat.forked'), chat: ChatSchema, clientId: z.string().optional() }),
  z.object({
    type: z.literal('messages.loaded'),
    chatId: z.string(),
    messages: z.array(MessageSchema),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('message.appended'),
    chatId: z.string(),
    message: MessageSchema,
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('message.snapshot'),
    chatId: z.string(),
    message: MessageSchema,
    clientId: z.string().optional(),
  }),
  // Per-part streaming update: replace (or append, when partIndex is one past
  // the end) one part of a message. renderedHtml is the rendered HTML for a
  // text part, null for any other type (client renders those from raw data).
  z.object({
    type: z.literal('part.snapshot'),
    chatId: z.string(),
    messageId: z.number().int(),
    partIndex: z.number().int().min(0),
    part: ContentPartSchema,
    renderedHtml: z.string().nullable(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('message.deleted'),
    chatId: z.string(),
    messageId: z.number().int(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('attachment.created'),
    attachment: AttachmentRefSchema,
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('generation.started'),
    generationId: z.string(),
    chatId: z.string(),
    messageId: z.number().int().optional(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('prompt.announced'),
    generationId: z.string(),
    prompt: PromptSchema,
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('generation.token'),
    generationId: z.string(),
    token: z.string(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('generation.reasoningToken'),
    generationId: z.string(),
    token: z.string(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('generation.debugToken'),
    generationId: z.string(),
    token: z.string(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('generation.patch'),
    generationId: z.string(),
    patch: GenerationSchema.partial(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('generation.done'),
    generationId: z.string(),
    finishReason: z.string(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('generation.aborted'),
    generationId: z.string(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('generation.error'),
    generationId: z.string(),
    error: z.string(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('impersonation.complete'),
    generationId: z.string(),
    text: z.string(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('character.snapshot'),
    character: CharacterSchema,
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('character.created'), character: CharacterSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('character.updated'), character: CharacterSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('character.deleted'), characterId: z.string(), clientId: z.string().optional() }),
  z.object({
    type: z.literal('character.listed'),
    characters: z.array(CharacterSummarySchema),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('settings.changed'),
    key: z.string(),
    value: z.unknown(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('settings.loaded'),
    settings: AppSettingsSchema,
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('worldinfo.snapshot'), book: WorldInfoSchema, clientId: z.string().optional() }),
  z.object({
    type: z.literal('worldinfo.listed'),
    books: z.array(WorldInfoSchema),
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('worldinfo.created'), book: WorldInfoSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('worldinfo.updated'), book: WorldInfoSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('worldinfo.deleted'), bookId: z.string(), clientId: z.string().optional() }),
  z.object({
    type: z.literal('worldinfo.tested'),
    activated: z.array(z.object({ entry: WorldInfoEntrySchema, tokens: z.number() })),
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('persona.snapshot'), persona: PersonaSchema, clientId: z.string().optional() }),
  z.object({
    type: z.literal('persona.listed'),
    personas: z.array(PersonaSummarySchema),
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('persona.created'), persona: PersonaSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('persona.updated'), persona: PersonaSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('persona.deleted'), personaId: z.string(), clientId: z.string().optional() }),
  z.object({
    type: z.literal('backendConfig.listed'),
    backendConfigs: z.array(BackendConfigSummarySchema),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('backendConfig.snapshot'),
    backendConfig: BackendConfigSchema,
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('backendConfig.created'),
    backendConfig: BackendConfigSchema,
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('backendConfig.updated'),
    backendConfig: BackendConfigSchema,
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('backendConfig.deleted'), backendConfigId: z.string(), clientId: z.string().optional() }),
  z.object({
    type: z.literal('promptList.listed'),
    promptLists: z.array(PromptListSummarySchema),
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('promptList.snapshot'), promptList: PromptListSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('promptList.created'), promptList: PromptListSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('promptList.updated'), promptList: PromptListSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('promptList.deleted'), promptListId: z.string(), clientId: z.string().optional() }),
  z.object({
    type: z.literal('group.members'),
    chatId: z.string(),
    members: z.array(ChatMemberSummarySchema),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('group.member.added'),
    chatId: z.string(),
    member: ChatMemberSummarySchema,
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('group.member.removed'),
    chatId: z.string(),
    characterId: z.string(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('group.member.updated'),
    chatId: z.string(),
    member: ChatMemberSummarySchema,
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('quickreply.listed'),
    items: z.array(QuickReplySchema),
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('quickreply.created'), item: QuickReplySchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('quickreply.updated'), item: QuickReplySchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('quickreply.deleted'), id: z.string(), clientId: z.string().optional() }),
  z.object({
    type: z.literal('custombackend.listed'),
    items: z.array(CustomBackendSchema),
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('custombackend.created'), item: CustomBackendSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('custombackend.updated'), item: CustomBackendSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('custombackend.deleted'), id: z.string(), clientId: z.string().optional() }),
  z.object({
    type: z.literal('custombackend.testResult'),
    requestId: z.string().optional(),
    outcome: CustomBackendTestOutcomeSchema,
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('toolset.listed'),
    toolsets: z.array(ToolsetSchema),
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('toolset.created'), toolset: ToolsetSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('toolset.updated'), toolset: ToolsetSchema, clientId: z.string().optional() }),
  z.object({ type: z.literal('toolset.deleted'), toolsetId: z.string(), clientId: z.string().optional() }),
  z.object({
    type: z.literal('toolTemplate.listed'),
    toolTemplates: z.array(ToolTemplateSchema),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('toolTemplate.created'),
    toolTemplate: ToolTemplateSchema,
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('toolTemplate.updated'),
    toolTemplate: ToolTemplateSchema,
    clientId: z.string().optional(),
  }),
  z.object({ type: z.literal('toolTemplate.deleted'), toolTemplateId: z.string(), clientId: z.string().optional() }),
  z.object({
    type: z.literal('script.toast'),
    message: z.string(),
    level: z.string(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('script.error'),
    message: z.string(),
    source: z.string(),
    clientId: z.string().optional(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
    clientId: z.string().optional(),
  }),
]);
