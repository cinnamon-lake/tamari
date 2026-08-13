/**
 * Legacy data migration script (one-shot import tool).
 *
 * Reads the old flat-file `data/` directory and imports everything into SQLite.
 * Messages are converted from flat arrays into a tree (parent_id) where swipes
 * become sibling nodes under the same parent.
 *
 * Deliberate layering exceptions — do not copy this pattern elsewhere:
 * - Raw INSERTs bypass the repository layer (~15 sites). This runs once at
 *   boot before any repo/service wiring exists; routing it through repos
 *   would drag validation and broadcast logic into a boot-time backfill.
 * - `db/index.ts` imports `FileStorage` from services/ for the boot-time
 *   BLOB→file migration — the same tolerated inversion.
 * - The legacy dir defaults to the CWD-relative `DEFAULT_LEGACY_DATA_DIR`,
 *   matching where v1 kept `data/` next to the checkout.
 */

import type { Client } from '@libsql/client';
import {
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, basename, extname, dirname } from 'node:path';
import { convertLegacyScopedScripts } from '../services/characterRegex.js';
import { insertMessageParts } from './messageParts.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import type { WorldInfoEntry, BackendConfigInsert, PromptListInsert, PresetPromptDef, PresetPromptOrderEntry, ContentPart } from '@tamari/types';

/**
 * CWD-relative default for the v1 flat-file `data/` dir. Relative on purpose:
 * v1 kept `data/` next to the checkout, so boot auto-detection resolves it
 * against the process working directory.
 */
export const DEFAULT_LEGACY_DATA_DIR = './data';

export interface MigrateOptions {
  legacyDataDir: string;
  client: Client;
  dataDir: string;
  /** Rename old data dir to this suffix after successful migration */
  backupSuffix?: string;
}

interface LegacyMessage {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  isSystem?: boolean;
  send_date?: number | string;
  sendDate?: number | string;
  mes?: string;
  extra?: Record<string, unknown>;
  swipe_id?: number;
  swipeId?: number;
  swipes?: string[];
  swipe_info?: Array<{
    send_date?: number | string;
    sendDate?: number | string;
    gen_started?: number;
    gen_finished?: number;
    extra?: Record<string, unknown>;
  }>;
}

interface LegacyWorldInfoEntry {
  uid: number;
  key: string[];
  keysecondary?: string[];
  comment?: string;
  content?: string;
  constant?: boolean;
  selective?: boolean;
  selectiveLogic?: number;
  addMemo?: boolean;
  order?: number;
  position?: number;
  disable?: boolean;
  useRegex?: boolean;
  probability?: number;
  recursive?: boolean;
  depth?: number;
  useProbability?: boolean;
  role?: number | null;
  vectorized?: boolean;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  delayUntilRecursion?: number | boolean;
  scanDepth?: number | null;
  caseSensitive?: boolean | null;
  matchWholeWords?: boolean | null;
  useGroupScoring?: boolean | null;
  automationId?: string;
  sticky?: number | null;
  cooldown?: number | null;
  delay?: number | null;
  triggers?: unknown[];
  characterFilter?: unknown;
  displayIndex?: number;
  group?: string;
  groupOverride?: boolean;
  groupWeight?: number;
  ignoreBudget?: boolean;
  matchPersonaDescription?: boolean;
  matchCharacterDescription?: boolean;
  matchCharacterPersonality?: boolean;
  matchCharacterDepthPrompt?: boolean;
  matchScenario?: boolean;
  matchCreatorNotes?: boolean;
  outletName?: string;
}

interface LegacySettings {
  username?: string;
  user_avatar?: string;
  main_api?: string;
  amount_gen?: number;
  max_context?: number;
  background?: string;
  power_user?: Record<string, unknown>;
  [key: string]: unknown;
}

function parsePngMetadata(filePath: string): { v2?: string; v3?: string } {
  const buf = readFileSync(filePath);
  const chunks = extract(new Uint8Array(buf));
  const textChunks = chunks.filter((c) => c.name === 'tEXt').map((c) => PNGtext.decode(c.data));

  const v2 = textChunks.find((t) => t.keyword.toLowerCase() === 'chara');
  const v3 = textChunks.find((t) => t.keyword.toLowerCase() === 'ccv3');

  return {
    v2: v2 ? Buffer.from(v2.text, 'base64').toString('utf-8') : undefined,
    v3: v3 ? Buffer.from(v3.text, 'base64').toString('utf-8') : undefined,
  };
}

function mtimeToUnix(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

function safeDateToUnix(dateStr: string | undefined, fallback: number): number {
  if (!dateStr) return fallback;
  const ts = new Date(dateStr).getTime();
  if (!Number.isFinite(ts)) return fallback;
  return Math.floor(ts / 1000);
}

function legacyPositionToEnum(pos: number): WorldInfoEntry['position'] {
  switch (pos) {
    case 0:
      return 'before_char';
    case 1:
      return 'after_char';
    case 2:
      return 'top';
    case 3:
      return 'bottom';
    case 4:
      return 'atDepth';
    default:
      return 'before_char';
  }
}

function legacyRoleToEnum(role: number | null | undefined): WorldInfoEntry['role'] {
  switch (role) {
    case 0:
      return 'system';
    case 1:
      return 'user';
    case 2:
      return 'assistant';
    default:
      return 'system';
  }
}

// ---------- Preset mapping helpers ----------

const DEFAULT_PROMPTS: PresetPromptDef[] = [
  { identifier: 'main', name: 'Main Prompt', content: '', role: 'system', enabled: true, systemPrompt: true },
  { identifier: 'nsfw', name: 'NSFW Prompt', content: '', role: 'system', enabled: false, systemPrompt: true },
  { identifier: 'dialogueExamples', name: 'Dialogue Examples', content: '', role: 'system', enabled: true, marker: true },
  { identifier: 'jailbreak', name: 'Jailbreak', content: '', role: 'system', enabled: false, systemPrompt: true },
  { identifier: 'chatHistory', name: 'Chat History', content: '', role: 'system', enabled: true, marker: true },
  { identifier: 'worldInfoAfter', name: 'World Info (after)', content: '', role: 'system', enabled: true, marker: true },
  { identifier: 'worldInfoBefore', name: 'World Info (before)', content: '', role: 'system', enabled: true, marker: true },
  { identifier: 'enhanceDefinitions', name: 'Enhance Definitions', content: '', role: 'system', enabled: false, systemPrompt: true },
];

const DEFAULT_ORDER: PresetPromptOrderEntry[] = [
  { identifier: 'main', enabled: true },
  { identifier: 'nsfw', enabled: false },
  { identifier: 'dialogueExamples', enabled: true },
  { identifier: 'worldInfoBefore', enabled: true },
  { identifier: 'chatHistory', enabled: true },
  { identifier: 'worldInfoAfter', enabled: true },
  { identifier: 'enhanceDefinitions', enabled: false },
  { identifier: 'jailbreak', enabled: false },
];

interface OldOpenAIPreset {
  chat_completion_source?: string;
  openai_model?: string;
  claude_model?: string;
  openrouter_model?: string;
  google_model?: string;
  vertexai_model?: string;
  mistralai_model?: string;
  chutes_model?: string;
  electronhub_model?: string;
  ai21_model?: string;
  custom_model?: string;
  temperature?: number;
  openai_max_tokens?: number;
  top_p?: number;
  top_k?: number;
  top_a?: number;
  min_p?: number;
  repetition_penalty?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  openai_max_context?: number;
  prompts?: Array<{
    identifier?: string;
    name?: string;
    content?: string;
    role?: string;
    systemPrompt?: boolean;
    system_prompt?: boolean;
    marker?: boolean;
  }>;
  prompt_order?: Array<{
    character_id?: number;
    order?: Array<{ identifier?: string; enabled?: boolean }>;
  }>;
  promptOrder?: Array<{
    characterId?: number;
    order?: Array<{ identifier?: string; enabled?: boolean }>;
  }>;
  [key: string]: unknown;
}

function modelForSource(source: string, data: OldOpenAIPreset): string {
  switch (source) {
    case 'openai':
      return data.openai_model ?? '';
    case 'claude':
      return data.claude_model ?? '';
    case 'openrouter':
      return data.openrouter_model ?? '';
    case 'makersuite':
    case 'gemini':
      return data.google_model ?? '';
    case 'mistralai':
      return data.mistralai_model ?? '';
    case 'custom':
      return data.custom_model ?? '';
    default:
      return '';
  }
}

function mapOpenAIPrompts(data: OldOpenAIPreset): { prompts: PresetPromptDef[]; order: PresetPromptOrderEntry[] } {
  if (!data.prompts || data.prompts.length === 0) {
    return {
      prompts: DEFAULT_PROMPTS.map((p) => ({ ...p })),
      order: DEFAULT_ORDER.map((o) => ({ ...o })),
    };
  }

  const enabledSet = new Set<string>();
  const firstGroup = data.prompt_order?.[0] ?? data.promptOrder?.[0];
  if (firstGroup?.order) {
    for (const entry of firstGroup.order) {
      if (entry.enabled && entry.identifier) {
        enabledSet.add(entry.identifier);
      }
    }
  }

  const prompts: PresetPromptDef[] = data.prompts
    .filter((p): p is typeof p & { identifier: string } => !!p.identifier)
    .map((p) => ({
      identifier: p.identifier,
      name: p.name ?? '',
      content: p.content ?? '',
      role: (p.role as 'system' | 'user' | 'assistant' | undefined) ?? 'system',
      enabled: enabledSet.has(p.identifier),
      systemPrompt: p.systemPrompt ?? p.system_prompt ?? false,
      marker: p.marker ?? false,
    }));

  const order: PresetPromptOrderEntry[] =
    firstGroup?.order
      ?.filter((o) => o.identifier)
      .map((o) => ({
        identifier: o.identifier ?? '',
        enabled: o.enabled ?? true,
      })) ?? DEFAULT_ORDER.map((o) => ({ ...o }));

  return { prompts, order };
}

function mapOpenAIPreset(fileName: string, data: OldOpenAIPreset): { backendConfig: BackendConfigInsert; promptList: PromptListInsert } {
  const { prompts, order } = mapOpenAIPrompts(data);
  const source = data.chat_completion_source ?? 'openai';

  const coreKeys = new Set([
    'chat_completion_source', 'openai_model', 'claude_model', 'openrouter_model',
    'google_model', 'vertexai_model', 'mistralai_model', 'chutes_model',
    'electronhub_model', 'ai21_model', 'custom_model', 'temperature',
    'openai_max_tokens', 'top_p', 'top_k', 'top_a', 'min_p',
    'repetition_penalty', 'frequency_penalty', 'presence_penalty',
    'openai_max_context', 'prompts', 'prompt_order',
  ]);
  const providerParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!coreKeys.has(k)) providerParams[k] = v;
  }

  return {
    backendConfig: {
      name: fileName.replace(/\.json$/, ''),
      description: '',
      backendProvider: source,
      generationMode: 'chat',
      model: modelForSource(source, data),
      temperature: data.temperature ?? null,
      maxTokens: data.openai_max_tokens ?? null,
      topP: data.top_p ?? null,
      topK: data.top_k ?? null,
      minP: data.min_p ?? null,
      topA: data.top_a ?? null,
      repetitionPenalty: data.repetition_penalty ?? null,
      frequencyPenalty: data.frequency_penalty ?? null,
      presencePenalty: data.presence_penalty ?? null,
      instructTemplate: '',
      contextLength: data.openai_max_context ?? null,
      promptHistoryLimit: 50,
      providerParams: providerParams,
      stopStrings: [],
      openrouterProvider: null,
      logitBias: null,
    },
    promptList: {
      name: fileName.replace(/\.json$/, ''),
      description: '',
      prompts,
      promptOrder: order,
    },
  };
}

interface OldKoboldPreset {
  temp?: number;
  rep_pen?: number;
  rep_pen_range?: number;
  top_p?: number;
  top_k?: number;
  top_a?: number;
  min_p?: number;
  typical?: number;
  tfs?: number;
  repetition_penalty?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_length?: number;
  [key: string]: unknown;
}

function mapKoboldPreset(fileName: string, data: OldKoboldPreset): { backendConfig: BackendConfigInsert; promptList: PromptListInsert } {
  const providerParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!['temp', 'rep_pen', 'rep_pen_range', 'top_p', 'top_k', 'top_a', 'min_p', 'typical', 'tfs', 'repetition_penalty', 'frequency_penalty', 'presence_penalty', 'max_length'].includes(k)) {
      providerParams[k] = v;
    }
  }
  return {
    backendConfig: {
      name: fileName.replace(/\.json$/, ''),
      description: '',
      backendProvider: 'koboldcpp',
      generationMode: 'text',
      model: '',
      temperature: data.temp ?? null,
      maxTokens: data.max_length ?? null,
      topP: data.top_p ?? null,
      topK: data.top_k ?? null,
      minP: data.min_p ?? null,
      topA: data.top_a ?? null,
      repetitionPenalty: data.rep_pen ?? data.repetition_penalty ?? null,
      frequencyPenalty: data.frequency_penalty ?? null,
      presencePenalty: data.presence_penalty ?? null,
      instructTemplate: '',
      contextLength: null,
      promptHistoryLimit: 50,
      providerParams: providerParams,
      stopStrings: [],
      openrouterProvider: null,
      logitBias: null,
    },
    promptList: {
      name: fileName.replace(/\.json$/, ''),
      description: '',
      prompts: DEFAULT_PROMPTS.map((p) => ({ ...p })),
      promptOrder: DEFAULT_ORDER.map((o) => ({ ...o })),
    },
  };
}

interface OldTextGenPreset {
  temp?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  top_a?: number;
  min_p?: number;
  rep_pen?: number;
  repetition_penalty?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_length?: number;
  [key: string]: unknown;
}

function mapTextGenPreset(fileName: string, data: OldTextGenPreset): { backendConfig: BackendConfigInsert; promptList: PromptListInsert } {
  const providerParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!['temp', 'temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'rep_pen', 'repetition_penalty', 'frequency_penalty', 'presence_penalty', 'max_length'].includes(k)) {
      providerParams[k] = v;
    }
  }
  return {
    backendConfig: {
      name: fileName.replace(/\.json$/, ''),
      description: '',
      backendProvider: 'textgen',
      generationMode: 'text',
      model: '',
      temperature: (data.temp ?? data.temperature) ?? null,
      maxTokens: data.max_length ?? null,
      topP: data.top_p ?? null,
      topK: data.top_k ?? null,
      minP: data.min_p ?? null,
      topA: data.top_a ?? null,
      repetitionPenalty: data.rep_pen ?? data.repetition_penalty ?? null,
      frequencyPenalty: data.frequency_penalty ?? null,
      presencePenalty: data.presence_penalty ?? null,
      instructTemplate: '',
      contextLength: null,
      promptHistoryLimit: 50,
      providerParams: providerParams,
      stopStrings: [],
      openrouterProvider: null,
      logitBias: null,
    },
    promptList: {
      name: fileName.replace(/\.json$/, ''),
      description: '',
      prompts: DEFAULT_PROMPTS.map((p) => ({ ...p })),
      promptOrder: DEFAULT_ORDER.map((o) => ({ ...o })),
    },
  };
}

interface OldNovelAIPreset {
  temperature?: number;
  max_length?: number;
  top_k?: number;
  typical_p?: number;
  tail_free_sampling?: number;
  repetition_penalty?: number;
  repetition_penalty_range?: number;
  repetition_penalty_slope?: number;
  repetition_penalty_frequency?: number;
  repetition_penalty_presence?: number;
  max_context?: number;
  [key: string]: unknown;
}

function mapNovelAIPreset(fileName: string, data: OldNovelAIPreset): { backendConfig: BackendConfigInsert; promptList: PromptListInsert } {
  const providerParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!['temperature', 'max_length', 'top_k', 'typical_p', 'tail_free_sampling', 'repetition_penalty', 'repetition_penalty_range', 'repetition_penalty_slope', 'repetition_penalty_frequency', 'repetition_penalty_presence', 'max_context'].includes(k)) {
      providerParams[k] = v;
    }
  }
  return {
    backendConfig: {
      name: fileName.replace(/\.json$/, ''),
      description: '',
      backendProvider: 'novelai',
      generationMode: 'chat',
      model: '',
      temperature: data.temperature ?? null,
      maxTokens: data.max_length ?? null,
      topP: null,
      topK: data.top_k ?? null,
      minP: null,
      topA: null,
      repetitionPenalty: data.repetition_penalty ?? null,
      frequencyPenalty: data.repetition_penalty_frequency ?? null,
      presencePenalty: data.repetition_penalty_presence ?? null,
      instructTemplate: '',
      contextLength: data.max_context ?? null,
      promptHistoryLimit: 50,
      providerParams: providerParams,
      stopStrings: [],
      openrouterProvider: null,
      logitBias: null,
    },
    promptList: {
      name: fileName.replace(/\.json$/, ''),
      description: '',
      prompts: DEFAULT_PROMPTS.map((p) => ({ ...p })),
      promptOrder: DEFAULT_ORDER.map((o) => ({ ...o })),
    },
  };
}

// ---------- Main import ----------

export async function importLegacyData(
  opts: MigrateOptions,
): Promise<{ imported: boolean; stats: Record<string, number> }> {
  const { legacyDataDir, client, dataDir, backupSuffix = 'data-backup-pre-v2' } = opts;

  if (!existsSync(legacyDataDir)) {
    return { imported: false, stats: {} };
  }

  const entries = readdirSync(legacyDataDir, { withFileTypes: true });
  const userDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'));

  if (userDirs.length === 0) {
    return { imported: false, stats: {} };
  }

  const stats: {
    settings: number;
    characters: number;
    chats: number;
    messages: number;
    worlds: number;
    groups: number;
    quickReplies: number;
    personas: number;
    presets: number;
    backgrounds: number;
  } = {
    settings: 0,
    characters: 0,
    chats: 0,
    messages: 0,
    worlds: 0,
    groups: 0,
    quickReplies: 0,
    personas: 0,
    presets: 0,
    backgrounds: 0,
  };

  for (const userDir of userDirs) {
    const basePath = join(legacyDataDir, userDir.name);
    console.log(`[migrate] Processing user: ${userDir.name}`);

    // Maps to track old name-based identifiers → new UUIDs for this user
    const charNameToUuid = new Map<string, string>();
    const personaNameToUuid = new Map<string, string>();
    const chatKeyToUuid = new Map<string, string>();
    const groupNameToUuid = new Map<string, string>();
    const worldNameToUuid = new Map<string, string>();

    // ---------- Settings ----------
    const settingsPath = join(basePath, 'settings.json');
    if (existsSync(settingsPath)) {
      try {
        const raw = readFileSync(settingsPath, 'utf-8');
        const legacySettings = JSON.parse(raw) as LegacySettings;
        const blob = JSON.stringify(legacySettings);
        await client.execute({
          sql: `INSERT INTO settings (id, blob, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
          args: [0, blob, mtimeToUnix(settingsPath)],
        });
        stats.settings = Object.keys(legacySettings).length;
        console.log(`[migrate] Imported ${stats.settings} settings keys`);
      } catch (e) {
        console.error(`[migrate] Failed to import settings:`, e);
      }
    }

    // ---------- Personas ----------
    const avatarsDir = join(basePath, 'User Avatars');
    if (existsSync(avatarsDir)) {
      const avatarFiles = readdirSync(avatarsDir, { withFileTypes: true }).filter(
        (e) => e.isFile() && extname(e.name).toLowerCase() === '.png',
      );

      const personaDir = join(dataDir, 'files', 'personas');
      mkdirSync(personaDir, { recursive: true });

      for (const file of avatarFiles) {
        try {
          const oldName = basename(file.name, '.png');
          const personaId = randomUUID();
          personaNameToUuid.set(oldName, personaId);
          const srcPath = join(avatarsDir, file.name);
          const avatarFileName = `${randomUUID()}.png`;
          const destPath = join(personaDir, avatarFileName);
          copyFileSync(srcPath, destPath);

          const relPath = `files/personas/${avatarFileName}`;
          const now = mtimeToUnix(srcPath);
          await client.execute({
            sql: `INSERT OR REPLACE INTO personas (id, name, description, avatar_path, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [personaId, oldName, '', relPath, now, now],
          });
          stats.personas++;
        } catch (e) {
          console.error(`[migrate] Failed to import persona ${file.name}:`, e);
        }
      }
      console.log(`[migrate] Imported ${stats.personas} personas`);
    }

    // ---------- Presets ----------
    const presetDirs: { path: string; mapper: (name: string, data: unknown) => { backendConfig: BackendConfigInsert; promptList: PromptListInsert }; backend: string }[] = [
      { path: join(basePath, 'OpenAI Settings'), mapper: (n, d) => mapOpenAIPreset(n, d as OldOpenAIPreset), backend: 'openai' },
      { path: join(basePath, 'KoboldAI Settings'), mapper: (n, d) => mapKoboldPreset(n, d as OldKoboldPreset), backend: 'koboldcpp' },
      { path: join(basePath, 'TextGen Settings'), mapper: (n, d) => mapTextGenPreset(n, d as OldTextGenPreset), backend: 'textgen' },
      { path: join(basePath, 'NovelAI Settings'), mapper: (n, d) => mapNovelAIPreset(n, d as OldNovelAIPreset), backend: 'novelai' },
    ];

    for (const presetDir of presetDirs) {
      if (!existsSync(presetDir.path)) continue;
      const files = readdirSync(presetDir.path, { withFileTypes: true }).filter(
        (e) => e.isFile() && extname(e.name).toLowerCase() === '.json',
      );

      for (const file of files) {
        try {
          const raw = readFileSync(join(presetDir.path, file.name), 'utf-8');
          const parsed = JSON.parse(raw);
          const mapped = presetDir.mapper(file.name, parsed);
          const id = randomUUID();
          const now = Math.floor(Date.now() / 1000);

          await client.execute({
            sql: `INSERT INTO backend_configs (
              id, name, description, backend_provider, generation_mode, model,
              api_url, api_key,
              temperature, max_tokens, top_p, top_k, min_p, top_a,
              repetition_penalty, frequency_penalty, presence_penalty,
              instruct_template, context_length, prompt_history_limit,
              provider_params_json, stop_strings_json, openrouter_provider, logit_bias_json,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              id,
              mapped.backendConfig.name,
              mapped.backendConfig.description,
              mapped.backendConfig.backendProvider,
              mapped.backendConfig.generationMode,
              mapped.backendConfig.model,
              mapped.backendConfig.apiUrl ?? null,
              mapped.backendConfig.apiKey ?? null,
              mapped.backendConfig.temperature ?? null,
              mapped.backendConfig.maxTokens ?? null,
              mapped.backendConfig.topP ?? null,
              mapped.backendConfig.topK ?? null,
              mapped.backendConfig.minP ?? null,
              mapped.backendConfig.topA ?? null,
              mapped.backendConfig.repetitionPenalty ?? null,
              mapped.backendConfig.frequencyPenalty ?? null,
              mapped.backendConfig.presencePenalty ?? null,
              mapped.backendConfig.instructTemplate,
              mapped.backendConfig.contextLength ?? null,
              mapped.backendConfig.promptHistoryLimit ?? null,
              JSON.stringify(mapped.backendConfig.providerParams),
              JSON.stringify(mapped.backendConfig.stopStrings),
              mapped.backendConfig.openrouterProvider ?? null,
              mapped.backendConfig.logitBias ? JSON.stringify(mapped.backendConfig.logitBias) : null,
              now,
              now,
            ],
          });

          await client.execute({
            sql: `INSERT INTO prompt_lists (
              id, name, description, prompts_json, prompt_order_json,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
              id,
              mapped.promptList.name,
              mapped.promptList.description,
              JSON.stringify(mapped.promptList.prompts),
              JSON.stringify(mapped.promptList.promptOrder),
              now,
              now,
            ],
          });
          stats.presets++;
        } catch (e) {
          console.error(`[migrate] Failed to import preset ${file.name}:`, e);
        }
      }
    }
    if (stats.presets > 0) {
      console.log(`[migrate] Imported ${stats.presets} presets`);
    }

    // ---------- Backgrounds ----------
    const backgroundsDir = join(basePath, 'backgrounds');
    if (existsSync(backgroundsDir)) {
      const bgFiles = readdirSync(backgroundsDir, { withFileTypes: true }).filter((e) => e.isFile());
      const bgDestDir = join(dataDir, 'files', 'backgrounds');
      mkdirSync(bgDestDir, { recursive: true });

      for (const file of bgFiles) {
        try {
          copyFileSync(join(backgroundsDir, file.name), join(bgDestDir, file.name));
          stats.backgrounds++;
        } catch (e) {
          console.error(`[migrate] Failed to copy background ${file.name}:`, e);
        }
      }
      console.log(`[migrate] Imported ${stats.backgrounds} backgrounds`);
    }

    // ---------- Characters ----------
    const charsDir = join(basePath, 'characters');
    if (existsSync(charsDir)) {
      const charFiles = readdirSync(charsDir, { withFileTypes: true }).filter(
        (e) => e.isFile() && extname(e.name).toLowerCase() === '.png',
      );

      const stmts = [];
      for (const file of charFiles) {
        const filePath = join(charsDir, file.name);
        try {
          const meta = parsePngMetadata(filePath);
          const raw = meta.v3 ?? meta.v2;
          if (!raw) continue;

          const card = JSON.parse(raw);
          const data = card.data ?? card;
          const pngBuf = readFileSync(filePath);
          const now = mtimeToUnix(filePath);

          const oldCharName = basename(file.name, '.png');
          const charId = randomUUID();
          charNameToUuid.set(oldCharName, charId);

          const avatarFileName = `${randomUUID()}.png`;
          const avatarPath = `files/avatars/${avatarFileName}`;
          mkdirSync(join(dataDir, 'files', 'avatars'), { recursive: true });
          writeFileSync(join(dataDir, avatarPath), pngBuf);

          // Import embedded character_book as a world_info book
          let worldInfoId: string | null = null;
          const charBook = data.character_book;
          if (charBook && charBook.entries) {
            worldInfoId = `char:${charId}:book`;
            const bookEntries: WorldInfoEntry[] = [];
            for (const uid of Object.keys(charBook.entries)) {
              const e: LegacyWorldInfoEntry = charBook.entries[uid];
              const position = legacyPositionToEnum(e.position ?? 0);
              const entry: WorldInfoEntry = {
                id: String(e.uid),
                keys: e.key,
                content: e.content ?? '',
                comment: e.comment ?? '',
                order: e.order ?? 100,
                position,
                probability: e.probability ?? 100,
                constant: e.constant ?? false,
                selective: e.selective ?? false,
                secondaryKeys: e.keysecondary ?? [],
                addMemo: e.addMemo ?? false,
                disable: e.disable ?? false,
                regex: e.useRegex ?? false,
                recursive: e.recursive ?? false,
                retrievalMode: e.vectorized ? 'semantic' : e.constant ? 'constant' : 'keyword',
              };
              if (position === 'atDepth') {
                entry.depth = e.depth ?? 0;
                entry.role = legacyRoleToEnum(e.role);
              }
              bookEntries.push(entry);
            }
            stmts.push({
              sql: `INSERT OR REPLACE INTO world_info (id, name, entries, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
              args: [
                worldInfoId,
                charBook.name ?? `${data.name ?? oldCharName} Book`,
                JSON.stringify(bookEntries),
                now,
                now,
              ],
            });
          }

          // v1 scoped regex scripts (extensions.regex_scripts) → v2 rules
          // (extensions.regexScripts), applied after global regex rules.
          const extensions: Record<string, unknown> = { ...(data.extensions ?? {}) };
          const legacyScopedScripts = convertLegacyScopedScripts(extensions);
          if (legacyScopedScripts.length > 0) {
            extensions['regexScripts'] = legacyScopedScripts;
          }

          stmts.push({
            sql: `INSERT OR REPLACE INTO characters (
              id, name, description, personality, scenario, first_mes, mes_example,
              creator, character_version, tags, avatar_path,
              creator_notes, system_prompt, post_history_instructions,
              alternate_greetings, group_only_greetings, nickname,
              creator_notes_multilingual, source, extensions,
              create_date, world_info_id,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              charId,
              data.name ?? card.name ?? oldCharName,
              data.description ?? '',
              data.personality ?? '',
              data.scenario ?? '',
              data.first_mes ?? '',
              data.mes_example ?? '',
              data.creator ?? '',
              data.character_version ?? '',
              JSON.stringify(data.tags ?? []),
              avatarPath,
              data.creator_notes ?? '',
              data.system_prompt ?? '',
              data.post_history_instructions ?? '',
              JSON.stringify(data.alternate_greetings ?? []),
              JSON.stringify(data.group_only_greetings ?? []),
              data.nickname ?? '',
              JSON.stringify(data.creator_notes_multilingual ?? {}),
              JSON.stringify(data.source ?? []),
              JSON.stringify(extensions),
              card.create_date ?? new Date(now * 1000).toISOString(),
              worldInfoId,
              now,
              now,
            ],
          });
          stats.characters++;
        } catch (e) {
          console.error(`[migrate] Failed to import character ${file.name}:`, e);
        }
      }
      if (stmts.length > 0) {
        await client.batch(stmts, 'write');
      }
      console.log(`[migrate] Imported ${stats.characters} characters`);
    }

    // ---------- Chats ----------
    const chatsDir = join(basePath, 'chats');
    if (existsSync(chatsDir)) {
      const charChatDirs = readdirSync(chatsDir, { withFileTypes: true }).filter((e) => e.isDirectory());

      for (const charDir of charChatDirs) {
        const charChatPath = join(chatsDir, charDir.name);
        const chatFiles = readdirSync(charChatPath, { withFileTypes: true }).filter(
          (e) => e.isFile() && extname(e.name).toLowerCase() === '.jsonl',
        );

        for (const chatFile of chatFiles) {
          const chatFilePath = join(charChatPath, chatFile.name);
          try {
            const lines = readFileSync(chatFilePath, 'utf-8')
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length > 0);

            if (lines.length === 0) continue;

            const oldChatName = basename(chatFile.name, '.jsonl');
            const chatId = randomUUID();
            const chatKey = `${charDir.name}/${oldChatName}`;
            chatKeyToUuid.set(chatKey, chatId);
            const characterId = charNameToUuid.get(charDir.name);
            if (!characterId) {
              console.warn(`[migrate] Skipping chat ${oldChatName}: character ${charDir.name} not found`);
              continue;
            }
            const chatMtime = mtimeToUnix(chatFilePath);

            let metadata: Record<string, unknown> = {};
            let headerOffset = 0;
            try {
              const header = JSON.parse(lines[0]!);
              if (header.chat_metadata) {
                metadata = header.chat_metadata;
                headerOffset = 1;
              }
            } catch {
              // Line 0 wasn't a header
            }

            try {
              await client.execute({
                sql: `INSERT OR REPLACE INTO chats (id, character_id, name, head_message_id, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                args: [chatId, characterId, oldChatName, null, chatMtime, chatMtime, JSON.stringify(metadata)],
              });
              stats.chats++;
            } catch (fkErr: unknown) {
              const msg = fkErr instanceof Error ? fkErr.message : String(fkErr);
              if (msg.includes('FOREIGN KEY')) {
                console.warn(`[migrate] Skipping chat ${oldChatName}: character ${charDir.name} not found`);
                continue;
              }
              throw fkErr;
            }

            let parentId: number | null = null;
            let lastMessageId: number | null = null;
            let lastMessageParentId: number | null = null;
            const msgLines = lines.slice(headerOffset);

            for (let i = 0; i < msgLines.length; i++) {
              try {
                const msg: LegacyMessage = JSON.parse(msgLines[i]!);
                const role: 'user' | 'assistant' | 'system' = (msg.is_system ?? msg.isSystem)
                  ? 'system'
                  : msg.is_user
                    ? 'user'
                    : 'assistant';

                const swipeId = msg.swipe_id ?? msg.swipeId ?? 0;
                const swipes = msg.swipes ?? [msg.mes ?? ''];
                const swipeInfo: LegacyMessage['swipe_info'] =
                  msg.swipe_info ??
                  swipes.map(() => ({ send_date: msg.send_date ?? msg.sendDate, gen_started: 0, gen_finished: 0, extra: {} }));

                // Insert active swipe on the main chain
                const activeText = swipes[swipeId] ?? msg.mes ?? '';
                const activeSwipeInfo = swipeInfo[swipeId] ?? {};
                const activeParts = [{ type: 'text', text: activeText }];
                const activeExtra: Record<string, unknown> = { ...msg.extra };

                const insertRs = await client.execute({
                  sql: `INSERT INTO messages (parent_id, role, content, extra, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?)
                         RETURNING id`,
                  args: [
                    parentId,
                    role,
                    activeText,
                    JSON.stringify(activeExtra),
                    safeDateToUnix((activeSwipeInfo.send_date ?? activeSwipeInfo.sendDate) as string | undefined, chatMtime),
                    chatMtime,
                  ],
                });
                const activeMsgId = (insertRs.rows[0] as Record<string, unknown>).id as number;
                await insertMessageParts(client, activeMsgId, activeParts as ContentPart[]);
                stats.messages++;

                // Insert inactive swipes as siblings (same parent_id)
                for (let s = 0; s < swipes.length; s++) {
                  if (s === swipeId) continue;
                  const info = swipeInfo[s] ?? {};
                  const swipeText = swipes[s] ?? '';
                  const swipeRs = await client.execute({
                    sql: `INSERT INTO messages (parent_id, role, content, extra, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?)
                           RETURNING id`,
                    args: [
                      parentId,
                      role,
                      swipeText,
                      JSON.stringify({ ...msg.extra, swipe: true }),
                      safeDateToUnix((info.send_date ?? info.sendDate) as string | undefined, chatMtime),
                      chatMtime,
                    ],
                  });
                  const swipeMsgId = (swipeRs.rows[0] as Record<string, unknown>).id as number;
                  await insertMessageParts(client, swipeMsgId, [
                    { type: 'text', text: swipeText },
                  ] as ContentPart[]);
                  stats.messages++;
                }

                // Track leaf for active_child_id / head_message_id
                lastMessageParentId = parentId;
                lastMessageId = activeMsgId;

                // Next message's parent is the active message
                parentId = activeMsgId;
              } catch (e) {
                console.error(`[migrate] Failed to parse message line ${i} in ${chatFilePath}:`, e);
              }
            }

            // Schema invariant: active_child_id = leaf message, head_message_id = parent of leaf
            if (lastMessageId !== null) {
              await client.execute({
                sql: `UPDATE chats SET active_child_id = ?, head_message_id = ? WHERE id = ?`,
                args: [lastMessageId, lastMessageParentId, chatId],
              });
            }
          } catch (e) {
            console.error(`[migrate] Failed to import chat ${chatFilePath}:`, e);
          }
        }
      }
      console.log(`[migrate] Imported ${stats.chats} chats with ${stats.messages} messages`);
    }

    // ---------- Group Chats ----------
    const groupChatsDir = join(basePath, 'group chats');
    const groupsDir = join(basePath, 'groups');
    if (existsSync(groupsDir)) {
      const groupFiles = readdirSync(groupsDir, { withFileTypes: true }).filter(
        (e) => e.isFile() && extname(e.name).toLowerCase() === '.json',
      );

      for (const file of groupFiles) {
        const filePath = join(groupsDir, file.name);
        try {
          const raw = readFileSync(filePath, 'utf-8');
          const group = JSON.parse(raw);
          const oldGroupId = group.chatId ?? basename(file.name, '.json');
          const chatId = randomUUID();
          groupNameToUuid.set(oldGroupId, chatId);
          const mtime = mtimeToUnix(filePath);

          const members: string[] = group.members ?? [];
          const disabledMembers: string[] = group.disabled_members ?? [];

          // Map activation strategy numbers to strings
          const strategyMap: Record<number, string> = {
            0: 'NATURAL',
            1: 'LIST',
            2: 'MANUAL',
            3: 'POOLED',
          };

          const groupChatSettings = {
            activationStrategy: strategyMap[group.activation_strategy] ?? 'NATURAL',
            autoModeEnabled: Boolean(group.auto_mode),
            autoModeIntervalSeconds: Number(group.auto_mode_delay ?? 5),
            manualCharacterId: null,
            pooledMinMembers: 1,
            pooledMaxMembers: 3,
            cooldownTurns: 0,
          };

          await client.execute({
            sql: `INSERT OR REPLACE INTO chats (id, character_id, name, head_message_id, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
              chatId,
              null,
              group.name ?? oldGroupId,
              null,
              mtime,
              mtime,
              JSON.stringify({ group: true, groupChatSettings }),
            ],
          });
          stats.groups++;

          // Populate chat_members from legacy group member list
          // Old ST stores members as avatar filenames (e.g., "Seraphina.png").
          // Resolve via the character name→UUID map built during character import.
          for (const memberAvatar of members) {
            const charName = basename(memberAvatar, '.png');
            const characterId = charNameToUuid.get(charName);
            if (!characterId) {
              console.warn(`[migrate] Skipping group member ${charName}: character not found`);
              continue;
            }
            const isEnabled = !disabledMembers.includes(memberAvatar);
            await client.execute({
              sql: `INSERT OR REPLACE INTO chat_members (chat_id, character_id, talkativeness, depth_prompt, depth_prompt_depth, enabled) VALUES (?, ?, ?, ?, ?, ?)`,
              args: [chatId, characterId, 1.0, '', 4, isEnabled ? 1 : 0],
            });
          }

          const gcPath = join(groupChatsDir, `${oldGroupId}.jsonl`);
          if (existsSync(gcPath)) {
            const lines = readFileSync(gcPath, 'utf-8')
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length > 0);

            let headerOffset = 0;
            try {
              const header = JSON.parse(lines[0]!);
              if (header.chat_metadata) headerOffset = 1;
            } catch {
              /* no header */
            }

            let parentId: number | null = null;
            let lastMessageId: number | null = null;
            let lastMessageParentId: number | null = null;
            const msgLines = lines.slice(headerOffset);

            for (let i = 0; i < msgLines.length; i++) {
              try {
                const msg: LegacyMessage = JSON.parse(msgLines[i]!);
                const role = msg.isSystem ? 'system' : msg.is_user ? 'user' : 'assistant';

                const groupText = msg.mes ?? '';
                const insertRs = await client.execute({
                  sql: `INSERT INTO messages (parent_id, role, content, extra, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?)
                         RETURNING id`,
                  args: [
                    parentId,
                    role,
                    groupText,
                    JSON.stringify({ ...msg.extra }),
                    safeDateToUnix((msg.send_date ?? msg.sendDate) as string | undefined, mtime),
                    mtime,
                  ],
                });
                const msgId = (insertRs.rows[0] as Record<string, unknown>).id as number;
                await insertMessageParts(client, msgId, [{ type: 'text', text: groupText }] as ContentPart[]);
                lastMessageParentId = parentId;
                lastMessageId = msgId;
                parentId = msgId;
                stats.messages++;
              } catch (e) {
                console.error(`[migrate] Failed to parse group message line ${i}:`, e);
              }
            }

            if (lastMessageId !== null) {
              await client.execute({
                sql: `UPDATE chats SET active_child_id = ?, head_message_id = ? WHERE id = ?`,
                args: [lastMessageId, lastMessageParentId, chatId],
              });
            }
          }
        } catch (e) {
          console.error(`[migrate] Failed to import group ${file.name}:`, e);
        }
      }
      console.log(`[migrate] Imported ${stats.groups} groups`);
    }

    // ---------- Quick Replies ----------
    const qrDir = join(basePath, 'quickreplies');
    if (existsSync(qrDir)) {
      const qrFiles = readdirSync(qrDir, { withFileTypes: true }).filter(
        (e) => e.isFile() && extname(e.name).toLowerCase() === '.json',
      );

      for (const file of qrFiles) {
        try {
          const raw = readFileSync(join(qrDir, file.name), 'utf-8');
          const legacy = JSON.parse(raw);
          const setName = legacy.name ?? basename(file.name, '.json');
          const qrList = legacy.qrList ?? [];

          for (const qr of qrList) {
            const id = randomUUID();
            await client.execute({
              sql: `INSERT INTO quick_replies (id, scope, scope_id, label, icon, color, script, language, auto_execute, order_index, created_at, updated_at)
                    VALUES (?, 'global', ?, ?, ?, ?, ?, 'stscript', ?, ?, ?, ?)`,
              args: [
                id,
                setName,
                qr.label ?? 'Unnamed',
                qr.icon ?? '',
                qr.color ?? '',
                qr.message ?? '',
                qr.executeOnStartup ||
                qr.executeOnUser ||
                qr.executeOnAi ||
                qr.executeOnChatChange ||
                qr.executeOnNewChat ||
                qr.executeBeforeGeneration
                  ? 1
                  : 0,
                qr.order ?? 0,
                Math.floor(Date.now() / 1000),
                Math.floor(Date.now() / 1000),
              ],
            });
            stats.quickReplies++;
          }
        } catch (e) {
          console.error(`[migrate] Failed to import quick reply set ${file.name}:`, e);
        }
      }
      console.log(`[migrate] Imported ${stats.quickReplies} legacy quick replies`);
    }

    // ---------- World Info ----------
    const worldsDir = join(basePath, 'worlds');
    if (existsSync(worldsDir)) {
      const worldFiles = readdirSync(worldsDir, { withFileTypes: true }).filter(
        (e) => e.isFile() && extname(e.name).toLowerCase() === '.json',
      );

      const stmts = [];
      for (const file of worldFiles) {
        const filePath = join(worldsDir, file.name);
        try {
          const raw = readFileSync(filePath, 'utf-8');
          const legacy = JSON.parse(raw);
          const mtime = mtimeToUnix(filePath);

          const entries: WorldInfoEntry[] = [];
          const legacyEntries = legacy.entries ?? {};
          for (const uid of Object.keys(legacyEntries)) {
            const e: LegacyWorldInfoEntry = legacyEntries[uid];
            const position = legacyPositionToEnum(e.position ?? 0);
            const entry: WorldInfoEntry = {
              id: String(e.uid),
              keys: e.key,
              content: e.content ?? '',
              comment: e.comment ?? '',
              order: e.order ?? 100,
              position,
              probability: e.probability ?? 100,
              constant: e.constant ?? false,
              selective: e.selective ?? false,
              secondaryKeys: e.keysecondary ?? [],
              addMemo: e.addMemo ?? false,
              disable: e.disable ?? false,
              regex: e.useRegex ?? false,
              recursive: e.recursive ?? false,
              retrievalMode: e.vectorized ? 'semantic' : e.constant ? 'constant' : 'keyword',
            };
            if (position === 'atDepth') {
              entry.depth = e.depth ?? 0;
              entry.role = legacyRoleToEnum(e.role);
            }
            entries.push(entry);
          }

          const oldWorldName = basename(file.name, '.json');
          const worldId = randomUUID();
          worldNameToUuid.set(oldWorldName, worldId);
          stmts.push({
            sql: `INSERT OR REPLACE INTO world_info (id, name, entries, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
            args: [
              worldId,
              legacy.name ?? oldWorldName,
              JSON.stringify(entries),
              mtime,
              mtime,
            ],
          });
          stats.worlds++;
        } catch (e) {
          console.error(`[migrate] Failed to import world ${file.name}:`, e);
        }
      }
      if (stmts.length > 0) {
        await client.batch(stmts, 'write');
      }
      console.log(`[migrate] Imported ${stats.worlds} world info books`);
    }
  }

  // ---------- Backup old data ----------
  const backupDir = `${legacyDataDir}-${backupSuffix}`;
  if (!existsSync(backupDir)) {
    renameSync(legacyDataDir, backupDir);
    console.log(`[migrate] Backed up legacy data to ${backupDir}`);
  } else {
    console.log(`[migrate] Backup dir already exists at ${backupDir}, skipping rename`);
  }

  return { imported: true, stats };
}

// ---------- Auto-detect helper ----------

export async function maybeImportLegacyData(
  client: Client,
  dataDir: string,
  legacyDataDir = DEFAULT_LEGACY_DATA_DIR,
): Promise<void> {
  if (!existsSync(legacyDataDir)) return;

  // Check if DB already has any user data
  const checks = await Promise.all([
    client.execute('SELECT COUNT(*) as c FROM characters'),
    client.execute('SELECT COUNT(*) as c FROM chats'),
    client.execute('SELECT COUNT(*) as c FROM personas'),
    client.execute('SELECT COUNT(*) as c FROM backend_configs'),
    client.execute('SELECT COUNT(*) as c FROM prompt_lists'),
  ]);
  const total = checks.reduce((sum, rs) => sum + Number((rs.rows[0] as Record<string, unknown>).c), 0);
  if (total > 0) {
    console.log('[migrate] Database already has data, skipping legacy import');
    return;
  }

  console.log('[migrate] Legacy data detected, starting import...');
  const result = await importLegacyData({ legacyDataDir, client, dataDir });
  if (result.imported) {
    console.log('[migrate] Legacy import complete. Stats:', result.stats);
  } else {
    console.log('[migrate] No legacy data found to import');
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const legacyDir = process.argv[2] ?? DEFAULT_LEGACY_DATA_DIR;
  const dbPath = process.argv[3] ?? './data/tamari.db';

  mkdirSync(dbPath.substring(0, dbPath.lastIndexOf('/')), { recursive: true });

  // Run base migration first (returns the connected client)
  const { initDatabase } = await import('./index.js');
  const dataDir = dirname(dbPath);
  const client = await initDatabase({ path: dbPath, dataDir });

  const result = await importLegacyData({ legacyDataDir: legacyDir, client, dataDir });
  if (result.imported) {
    console.log('[migrate] Done. Stats:', result.stats);
  } else {
    console.log('[migrate] No legacy data found.');
  }
  process.exit(0);
}
