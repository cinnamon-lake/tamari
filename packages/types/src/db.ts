/**
 * Domain types for tamari entities (camelCase).
 * Repositories map snake_case SQLite rows to these at the DB boundary (AGENTS.md §8).
 */

import type { MemoryCitation } from './memory.js';
import type { ContentPart, Prompt, TraceError } from './pipeline.js';

export interface CharacterAsset {
  id: string;
  characterId: string;
  name: string;
  type: string;
  ext: string;
  filePath: string | null;
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** Canonical URL for serving the asset. Computed server-side. */
  assetUrl?: string | null;
  /** Original embeded:// URI from the card. Computed server-side. */
  uri?: string | null;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creator: string;
  characterVersion: string;
  tags: string[];
  avatarPath: string | null;
  avatarThumbnailPath: string | null;
  /** Canonical avatar URL computed by the server. */
  avatarUrl?: string | null;
  /** Canonical thumbnail URL computed by the server. */
  thumbnailUrl?: string | null;
  /** Canonical PNG export URL computed by the server. */
  exportUrl?: string | null;
  /** Canonical CharX export URL computed by the server. */
  charxUrl?: string | null;
  /** Canonical avatar upload URL computed by the server. */
  avatarUploadUrl?: string | null;
  creatorNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  groupOnlyGreetings: string[];
  nickname: string;
  creatorNotesMultilingual: Record<string, string>;
  source: string[];
  extensions: Record<string, unknown>;
  createDate: string;
  worldInfoId: string | null;
  /** True for unpacked (on-disk) cards — read-only overlays; edit the folder, not the app. */
  external?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Populated at serve time from character_assets table. */
  assets?: CharacterAsset[];
}

export type CharacterInsert = {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMes?: string;
  mesExample?: string;
  creator?: string;
  characterVersion?: string;
  tags?: string[];
  avatarPath?: string | null;
  avatarThumbnailPath?: string | null;
  creatorNotes?: string;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  alternateGreetings?: string[];
  groupOnlyGreetings?: string[];
  nickname?: string;
  creatorNotesMultilingual?: Record<string, string>;
  source?: string[];
  extensions?: Record<string, unknown>;
  createDate?: string;
  worldInfoId?: string | null;
  assets?: CharacterAssetInsert[];
};
export type CharacterUpdate = Partial<Omit<Character, 'id' | 'createdAt' | 'updatedAt' | 'assets'>> & {
  assets?: CharacterAssetInsert[];
};

export type CharacterAssetInsert = Omit<CharacterAsset, 'id' | 'characterId' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};

/** Lightweight character fields for list views (sidebar, selectors). */
export interface CharacterSummary {
  id: string;
  name: string;
  tags: string[];
  /** Canonical avatar URL computed by the server. */
  avatarUrl?: string | null;
  /** Canonical thumbnail URL computed by the server. */
  thumbnailUrl?: string | null;
  /** Canonical V3 card export URL computed by the server. */
  exportUrl?: string | null;
  /** True for unpacked (on-disk) cards — shown with a disk badge in list views. */
  external?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Chat {
  id: string;
  characterId: string | null;
  personaId: string | null;
  name: string;
  /** Parent of the active leaf message. Swipes are children of this message. */
  headMessageId: number | null;
  /** The active leaf message (the currently displayed last message). */
  activeChildId: number | null;
  /** Whether the chat has ever been materialized from its virtual greeting. */
  materialized: boolean;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
  forkedFromChatId: string | null;
  forkedAtMessageId: number | null;
  /** Canonical JSONL export URL computed by the server. */
  jsonlExportUrl?: string | null;
  /** Canonical TXT export URL computed by the server. */
  txtExportUrl?: string | null;
}

/**
 * Group-chat reply ordering, stored in `Chat.metadata.groupChatSettings`.
 * Shared by the server (GroupChatService) and the client panel.
 */
export type ActivationStrategy = 'NATURAL' | 'LIST' | 'MANUAL' | 'POOLED';

/** Lightweight chat fields for sidebar list views. */
export interface ChatSummary {
  id: string;
  characterId: string | null;
  name: string;
  createdAt: number;
  updatedAt: number;
  forkedFromChatId: string | null;
  forkedAtMessageId: number | null;
}

export type ChatInsert = Omit<
  Chat,
  'id' | 'createdAt' | 'updatedAt' | 'activeChildId' | 'forkedFromChatId' | 'forkedAtMessageId' | 'materialized'
> & {
  activeChildId?: number | null;
  forkedFromChatId?: string | null;
  forkedAtMessageId?: number | null;
  materialized?: boolean;
};
export type ChatUpdate = Partial<Omit<Chat, 'id' | 'createdAt' | 'updatedAt'>>;

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Legacy tool-call record (superseded by `tool_use` content parts). */
export interface MessageToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Attachment reference enriched with an inline data URL at prompt-build time (never persisted). */
export type MessageAttachment = AttachmentRef & { dataUrl?: string };

/** Rolling memory summary anchored at a message (see MemoryService). */
export interface MessageMemoryExtra {
  summaryText: string;
  citations: MemoryCitation[];
  anchoredAt: number;
}

/**
 * Typed view of `Message.extra` — the richest domain structure on a message.
 * Known fields are typed; the index signature keeps forward compat for tool
 * widget payloads (e.g. `map`, `npcs`, `scene`, `choices`) and extension data.
 */
export interface MessageExtra {
  /** Ordered content parts (text/image/audio/video/tool_use/tool_result/reasoning). */
  parts?: ContentPart[];
  /** Snapshot of macro variables captured when the message was written. */
  macroVars?: Record<string, string>;
  tokenCount?: number;
  /** Serialized per-tool state snapshots keyed by tool stateKey (server: services/toolState.ts). */
  _toolState?: Record<string, string>;
  /** World Info entry IDs that activated at this message (branch-aware sticky/cooldown state). */
  _wiActivations?: string[];
  hidden?: boolean;
  editedAt?: number;
  /** Swipe marker on imported/legacy swipe messages. */
  swipe?: number | string | boolean;
  /** Legacy message kind marker (e.g. 'narrator', 'comment'). */
  type?: string;
  /** Legacy flat text content (pre-parts messages). */
  content?: string;
  reasoning?: string;
  model?: string;
  generationTime?: number;
  api?: string;
  /** Author references. */
  characterId?: string;
  personaId?: string;
  /** Server-enriched display metadata (computed at broadcast, not authored). */
  characterName?: string;
  characterAvatarUrl?: string;
  personaName?: string;
  personaAvatarUrl?: string;
  attachments?: MessageAttachment[];
  /** Legacy tool-call list (superseded by `tool_use` parts). */
  toolCalls?: MessageToolCall[];
  /** Tool-message correlation fields (role === 'tool'). */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Rolling memory summary anchored at this message. */
  memory?: MessageMemoryExtra;
  /** Tool-widget discriminator: when set, the client hydrates a widget for this message. */
  renderType?: string;
  [key: string]: unknown;
}

export interface Message {
  id: number;
  parentId: number | null;
  role: MessageRole;
  extra: MessageExtra;
  createdAt: number;
  updatedAt: number;
  /**
   * Server-computed HTML for display, aligned 1:1 with `extra.parts`.
   * Index `i` holds the rendered HTML for `parts[i]` when it is a non-empty
   * `text` part; `null` for every other part type (the client renders those
   * from the raw part data). Not persisted to DB.
   */
  renderedHtml?: (string | null)[];
}

export type MessageInsert = Omit<Message, 'id' | 'parentId' | 'createdAt' | 'updatedAt'> & {
  parentId?: number | null;
};
export type MessageUpdate = Partial<Omit<Message, 'id' | 'createdAt' | 'updatedAt'>>;

export interface WorldInfo {
  id: string;
  name: string;
  entries: WorldInfoEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface WorldInfoEntry {
  id: string;
  keys: string[];
  content: string;
  comment: string;
  order: number;
  position: 'before_char' | 'after_char' | 'top' | 'bottom' | 'atDepth';
  /** Depth in messages from the end (0 = after last message). Only used when position is 'atDepth'. */
  depth?: number;
  /** Role for the synthetic message when position is 'atDepth'. */
  role?: 'system' | 'user' | 'assistant';
  probability: number;
  constant: boolean;
  selective: boolean;
  secondaryKeys: string[];
  addMemo: boolean;
  disable: boolean;
  regex: boolean;
  recursive: boolean;
  /** Retrieval mode. 'keyword' = substring/regex scan, 'semantic' = vector similarity, 'constant' = always on. */
  retrievalMode?: 'keyword' | 'semantic' | 'constant';
  /** Once activated, stay in context for this many messages even if trigger disappears. */
  sticky?: number;
  /** After activation, block re-activation for this many messages. */
  cooldown?: number;
  /** Don't activate until the chat has at least this many messages. */
  delay?: number;
}

export type WorldInfoEntryInsert = Omit<WorldInfoEntry, 'id'>;
export type WorldInfoInsert = Omit<WorldInfo, 'id' | 'createdAt' | 'updatedAt'>;
export type WorldInfoUpdate = Partial<Omit<WorldInfo, 'id' | 'createdAt' | 'updatedAt'>>;

export interface SecretRow {
  key: string;
  value: string;
  label: string | null;
  updatedAt: number;
}

export interface Generation {
  id: string;
  chatId: string;
  messageId: number | null;
  status: 'pending' | 'streaming' | 'complete' | 'error' | 'aborted';
  backend: string;
  promptTokens: number | null;
  completionTokens: number | null;
  errorMessage: string | null;
  /** Which target kind produced this run. */
  kind: 'send' | 'regenerate' | 'continue' | 'impersonate' | 'quiet' | 'genraw' | 'subagent';
  /** The spawning generation's id (sub-agent runs); null at top level. */
  parentId: string | null;
  /** Debug-trace payload (docs/design/debug-traces.md); null for pre-007 rows. */
  meta?: GenerationMeta | null;
  createdAt: number;
  updatedAt: number;
}

/** Per-run debug-trace payload stored in generations.meta (migration 007). */
export interface GenerationMeta {
  /** The layer this node ran on (adapter id / script identity). */
  layer?: string;
  depth?: number;
  rounds?: number;
  toolCalls?: Array<{ name: string; isError?: boolean }>;
  traceError?: TraceError;
  /** Round-1 prompt snapshot — only when prompt capture is on
      (target.capturePrompts ?? the debugPrompts setting). */
  prompt?: Prompt;
  /** Every round's prompt, in order (prompts[0] === prompt; rounds are
      bounded by maxToolRounds). Same capture gating as `prompt`. */
  prompts?: Prompt[];
  /** Append-only layout: what the mode suppressed/hoisted for this run
      (docs/design/append-only-caching.md). Present only when the mode is on. */
  appendOnly?: { suppressed: string[]; hoisted: string[] };
}

export type GenerationInsert = Omit<Generation, 'createdAt' | 'updatedAt' | 'kind' | 'parentId'> & {
  /** Defaults to 'send' at insert (top-level generation). */
  kind?: Generation['kind'];
  parentId?: string | null;
};

export interface ExtensionData {
  extensionId: string;
  entityType: 'global' | 'character' | 'chat' | 'message';
  entityId: string;
  data: Record<string, unknown>;
}

export interface Attachment {
  id: string;
  messageId: number | null;
  mimeType: string;
  filePath: string;
  meta: Record<string, unknown>;
  /** Canonical download URL computed by the server. */
  url: string;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  avatarPath: string | null;
  avatarThumbnailPath: string | null;
  /** Canonical avatar URL computed by the server. */
  avatarUrl?: string | null;
  /** Canonical thumbnail URL computed by the server. */
  thumbnailUrl?: string | null;
  /** Canonical avatar upload URL computed by the server. */
  avatarUploadUrl?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type PersonaInsert = {
  name: string;
  description?: string;
  avatarPath?: string | null;
  avatarThumbnailPath?: string | null;
};
export type PersonaUpdate = Partial<Omit<Persona, 'id' | 'createdAt' | 'updatedAt'>>;

/** Lightweight persona fields for list views. */
export interface PersonaSummary {
  id: string;
  name: string;
  description: string;
  /** Canonical avatar URL computed by the server. */
  avatarUrl?: string | null;
  /** Canonical thumbnail URL computed by the server. */
  thumbnailUrl?: string | null;
  /** Canonical avatar upload URL computed by the server. */
  avatarUploadUrl?: string | null;
}

export type AttachmentRef = {
  id: string;
  mimeType: string;
  meta: Record<string, unknown>;
  /** Canonical download URL computed by the server. */
  url: string;
};

// ---------- Chat Members (Group Chats) ----------

export interface ChatMember {
  chatId: string;
  characterId: string;
  talkativeness: number;
  depthPrompt: string;
  depthPromptDepth: number;
  enabled: boolean;
}

export type ChatMemberInsert = Omit<ChatMember, 'enabled'> & { enabled?: boolean };
export type ChatMemberUpdate = Partial<Omit<ChatMember, 'chatId' | 'characterId'>>;

/** Enriched ChatMember sent to the client so it never has to look up characters. */
export interface ChatMemberSummary extends ChatMember {
  characterName: string;
  characterAvatarUrl: string | null;
  characterThumbnailUrl: string | null;
}

// ---------- Prompt Definitions ----------

export interface PresetPromptDef {
  identifier: string;
  name: string;
  content: string;
  role: 'system' | 'user' | 'assistant';
  enabled: boolean;
  systemPrompt?: boolean;
  marker?: boolean;
  injectionPosition?: 'relative' | 'absolute';
  injectionDepth?: number;
  injectionOrder?: number;
  forbidOverrides?: boolean;
}

export interface PresetPromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

// ---------- Backend Configs ----------

/** How a backend talks to its provider: chat completions vs. raw text completion. */
export type GenerationMode = 'chat' | 'text';

export interface BackendConfig {
  id: string;
  name: string;
  description: string;
  backendProvider: string;
  generationMode: GenerationMode;
  model: string;
  apiUrl: string | null;
  apiKey: string | null;
  temperature: number | null;
  maxTokens: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  topA: number | null;
  repetitionPenalty: number | null;
  frequencyPenalty: number | null;
  presencePenalty: number | null;
  instructTemplate: string;
  contextLength: number | null;
  promptHistoryLimit: number | null;
  providerParams: Record<string, unknown>;
  stopStrings: string[];
  openrouterProvider: string | null;
  logitBias: Record<string, number> | null;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  createdAt: number;
  updatedAt: number;
}

export type BackendConfigInsert = Omit<
  BackendConfig,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'temperature'
  | 'maxTokens'
  | 'topP'
  | 'topK'
  | 'minP'
  | 'topA'
  | 'repetitionPenalty'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'contextLength'
  | 'promptHistoryLimit'
  | 'stopStrings'
  | 'openrouterProvider'
  | 'apiUrl'
  | 'apiKey'
  | 'logitBias'
  | 'supportsImages'
  | 'supportsAudio'
  | 'supportsVideo'
> & {
  id?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  topK?: number | null;
  minP?: number | null;
  topA?: number | null;
  repetitionPenalty?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  contextLength?: number | null;
  promptHistoryLimit?: number | null;
  stopStrings?: string[];
  openrouterProvider?: string | null;
  apiUrl?: string | null;
  apiKey?: string | null;
  logitBias?: Record<string, number> | null;
  supportsImages?: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
};
export type BackendConfigUpdate = Partial<Omit<BackendConfig, 'id' | 'createdAt' | 'updatedAt'>>;

/** Lightweight backend config fields for list views. */
export interface BackendConfigSummary {
  id: string;
  name: string;
}

// ---------- Custom Backends (Lua-driven adapters) ----------

/**
 * A named, Lua-driven backend adapter ("custom backend"). The script's
 * `generate(prompt, ctx)` receives the fully-built prompt and may rebuild it,
 * delegate to other registered backends, and synthesize the output stream.
 * See docs/design/scriptable-layers.md §2.
 */
export interface CustomBackend {
  id: string;
  name: string;
  description: string;
  luaSource: string;
  createdAt: number;
  updatedAt: number;
}
export type CustomBackendInsert = Omit<CustomBackend, 'id' | 'createdAt' | 'updatedAt'>;
export type CustomBackendUpdate = Partial<CustomBackendInsert>;

// ---------- Prompt Lists ----------

export interface PromptList {
  id: string;
  name: string;
  description: string;
  prompts: PresetPromptDef[];
  promptOrder: PresetPromptOrderEntry[];
  createdAt: number;
  updatedAt: number;
}

export type PromptListInsert = Omit<PromptList, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
export type PromptListUpdate = Partial<Omit<PromptList, 'id' | 'createdAt' | 'updatedAt'>>;

/** Lightweight prompt list fields for list views. */
export interface PromptListSummary {
  id: string;
  name: string;
}

// ---------- Tool Instances ----------

export interface ToolTemplate {
  id: string;
  name: string;
  code: string;
  configSchema: Record<string, unknown>;
  /** Per-template Lua sandbox flags (allowIo/allowOs/allowDebug/allowRequire/allowNet/allowFiles/allowSt). Absent = fully sandboxed. */
  sandbox?: {
    allowIo?: boolean;
    allowOs?: boolean;
    allowDebug?: boolean;
    allowRequire?: boolean;
    allowNet?: boolean;
    allowFiles?: boolean;
    allowSt?: boolean;
  };
  createdAt: number;
  updatedAt: number;
}

export type ToolTemplateCreateInput = Omit<ToolTemplate, 'id' | 'createdAt' | 'updatedAt'>;
export type ToolTemplateUpdateInput = Partial<Omit<ToolTemplate, 'id' | 'createdAt' | 'updatedAt'>>;

export interface Toolset {
  id: string;
  templateId: string;
  name: string;
  config: Record<string, unknown>;
  toolOverrides: Record<
    string,
    { name?: string; description?: string; parameterDescriptions?: Record<string, string> }
  >;
  enabled: boolean;
  /** When true, this toolset's tools are also visible to sub-agents
      (run_agent). Default off — sub-agents get an explicit allowlist. */
  agentVisible: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ToolsetCreateInput = Omit<Toolset, 'id' | 'createdAt' | 'updatedAt'>;
export type ToolsetUpdateInput = Partial<Omit<Toolset, 'id' | 'createdAt' | 'updatedAt'>>;
