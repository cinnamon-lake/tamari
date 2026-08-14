/**
 * Character workbench tool template.
 *
 * Card-authoring surface for the model: read/create/update characters (by id —
 * no instance-wide listing), manage the character's own lorebook (treated as
 * 1:1 with the card: writes auto-create and link a book, no standalone book
 * management), character-scoped regex rules, raw RisuAI modules, character
 * assets, and the card-coupled backend script.
 *
 * Character mutations share their validation/broadcast logic with the Lua
 * `st` API via services/characterMutations.ts; lorebook mutations mirror
 * the dispatcher's worldinfo.* handlers, including the RAG re-index.
 * Group-chat membership lives in the Chat Workbench (chat_workbench).
 *
 * All errors are returned as `content` strings, never thrown.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Character, CharacterAsset, RegexRule, WorldInfo, WorldInfoEntry } from '@tamari/types';
import { WorldInfoEntryInsertSchema, WorldInfoEntryUpdateSchema } from '@tamari/types';
import { formatZodIssues, type ToolContext, type ToolExecuteResult } from '../ToolTemplate.js';
import type { EventBus } from '../../bus/EventBus.js';
import type { ICharacterRepository } from '../../repos/CharacterRepository.js';
import type { IWorldInfoRepository } from '../../repos/WorldInfoRepository.js';
import type { ISettingsRepository } from '../../repos/SettingsRepository.js';
import type { IAttachmentRepository } from '../../repos/AttachmentRepository.js';
import type { ICharacterAssetRepository } from '../../repos/CharacterAssetRepository.js';
import type { FileStorage } from '../FileStorage.js';
import type { RAGService } from '../RAGService.js';
import { createCharacter, updateCharacter } from '../characterMutations.js';
import { setCharacterAvatarFromBuffer } from '../characterAvatar.js';
import { validateVfsPath } from '../../scripting/LuaVfs.js';
import { validateLuaSource as validateLuaSourceInSandbox } from '../../scripting/validateLuaSource.js';
import { gameLibFiles } from './gameLib.js';
import { getCharacterRegexRules, mergeRegexRules, getGlobalRegexRules, CHARACTER_REGEX_EXTENSION_KEY } from '../characterRegex.js';
import { applyRules, filterRulesByRole, parseRegexString } from '../RegexEngine.js';
import {
  listRisuModuleMeta,
  loadRisuModule,
  removeRisuModule,
  getRisuModuleSection,
  CHARACTER_RISU_MODULES_EXTENSION_KEY,
  type RisuModuleMeta,
} from '../characterRisuModules.js';
import {
  CHARACTER_BACKEND_EXTENSION_KEY,
} from '../../backends/customBackendFactory.js';
import type { RisuModuleData } from '../../lib/risum.js';
import type { LuaRuntime } from '../../scripting/LuaRuntime.js';
import { dryRunBackendScript } from '../../backends/customBackendDryRun.js';
import { toCharacterSummary, withCharacterAssets, withCharacterAvatar } from '../../lib/summaries.js';
import { getLogger } from '../../lib/logger.js';

const log = getLogger('character-workbench');

export interface CharacterWorkbenchDeps {
  characters: ICharacterRepository;
  worldInfo: IWorldInfoRepository;
  settings: ISettingsRepository;
  attachments: IAttachmentRepository;
  characterAssets: ICharacterAssetRepository;
  storage: FileStorage;
  bus: EventBus;
  /** Lua runtime for backend_logic_test dry-runs. */
  luaRuntime: LuaRuntime;
  /** Optional: keeps the semantic-search index in sync, like the dispatcher does. */
  ragService?: Pick<RAGService, 'indexWorldInfoEntries'>;
}

const CHARACTER_ID = 'Character id (a UUID — from the chat context, the user, or a previous tool result).';

function invalidArgs(error: z.ZodError): ToolExecuteResult {
  return { content: `Error: invalid arguments — ${formatZodIssues(error)}` };
}

const characterFields = {
  description: z.string().optional(),
  personality: z.string().optional(),
  scenario: z.string().optional(),
  firstMes: z.string().optional().describe('First message / greeting.'),
  mesExample: z.string().optional().describe('Example dialogue, formatted with {{char}} and {{user}}.'),
  systemPrompt: z.string().optional(),
  postHistoryInstructions: z.string().optional(),
  creatorNotes: z.string().optional(),
  nickname: z.string().optional().describe('Nickname / short name (V3 card field).'),
  alternateGreetings: z.array(z.string()).optional().describe('Alternate first messages (swipeable greetings).'),
  tags: z.array(z.string()).optional(),
};

const CharacterGetArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
});

const CharacterCreateArgs = z.object({
  name: z.string().min(1).max(512),
  ...characterFields,
});

const CharacterCloneArgs = z.object({
  sourceCharacterId: z.string().describe('Character id of the card to clone.'),
  name: z.string().min(1).max(512).optional().describe('Name for the clone. Defaults to "<source name> (Copy)". Must not collide with an existing character.'),
});

const CharacterUpdateArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  patch: z
    .object({
      name: z.string().min(1).max(512).optional().describe('Rename the character. Fails if another character already has that name.'),
      ...characterFields,
    })
    .describe('Fields to update. Only the listed fields are writable.'),
});

const CharacterSetAvatarArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  attachmentId: z
    .string()
    .optional()
    .describe('Attachment id of the image (e.g. generated by a media tool — see the attachment url/id in its result).'),
  sourceCharacterId: z
    .string()
    .optional()
    .describe("Copy the avatar from this character's card instead of using an attachment. Pass exactly one of attachmentId / sourceCharacterId."),
});

// ---------- Character lorebook (1:1 with the card, created on first write) ----------

const LorebookGetArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
});

const LorebookEntryAddArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  entry: WorldInfoEntryInsertSchema,
});

const LorebookEntryUpdateArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  entryId: z.string().describe('Entry id (from lorebook_get).'),
  patch: WorldInfoEntryUpdateSchema.describe('Entry fields to update.'),
});

const LorebookEntryRemoveArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  entryId: z.string().describe('Entry id (from lorebook_get).'),
});

const LorebookEntryMoveArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  entryId: z.string().describe('Entry id (from lorebook_get).'),
  index: z.number().int().min(0).describe('Target 0-based position in the entry list (clamped to the list bounds).'),
});

// ---------- Character-scoped regex rules ----------

const RegexRuleInput = z.object({
  name: z.string().min(1).describe('Rule name.'),
  findRegex: z
    .string()
    .optional()
    .describe(
      'JS-style delimited pattern, e.g. "/foo/gi". Bare patterns are rejected. Omit (or pass "") to create an inert placeholder rule — it is stored but does nothing until a pattern is set.',
    ),
  replaceString: z
    .string()
    .optional()
    .describe(
      'Replacement; supports $1..$9, $&, $$. Omit (or pass "") to delete matches. Ignored when replaceLua is set.',
    ),
  replaceLua: z
    .string()
    .optional()
    .describe(
      'Optional Lua replacement (takes precedence over replaceString): source defining `function replace(match, captures) return ... end` — captures is a 1-indexed array of capture groups (nil for unmatched). Non-string return keeps the original match. Use for conditional logic, arithmetic, or lookups plain regex cannot express.',
    ),
  disabled: z.boolean().optional().describe('Disabled rules are stored but not applied. Default false.'),
  userInput: z.boolean().optional().describe('Apply only to user messages. Default false (all roles).'),
  aiOutput: z.boolean().optional().describe('Apply only to assistant messages. Default false (all roles).'),
  prompt: z.boolean().optional().describe('Apply when building the LLM prompt. Default true.'),
  display: z.boolean().optional().describe('Apply when rendering messages in the UI. Default true.'),
});

const RegexRulePatch = RegexRuleInput.partial();

const RegexListArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
});

const RegexAddArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  rule: RegexRuleInput,
});

const RegexUpdateArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  ruleId: z.string().describe('Rule id (from regex_list).'),
  patch: RegexRulePatch,
});

const RegexRemoveArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  ruleId: z.string().describe('Rule id (from regex_list).'),
});

const RegexTestArgs = z.object({
  characterId: z.string().optional().describe('Character whose scoped rules to include (always merged after global rules). Omit to test global rules only.'),
  text: z.string().describe('Sample text to run through the rules.'),
  role: z.enum(['user', 'assistant']).optional().describe('Role to test as, for role-filtered rules. Default assistant.'),
});

// ---------- Raw RisuAI modules (porting workflow) ----------

const RisuModuleListArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
});

const RisuModuleGetArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  moduleId: z.string().describe('Module id (from risu_module_list).'),
  section: z
    .enum(['info', 'triggers', 'trigger', 'regex', 'lorebook', 'assets'])
    .describe(
      'Which part of the raw module to return: info (name/description/namespace/toggles), triggers (summaries), trigger (one full trigger incl. Lua source — requires index), regex, lorebook, assets (metadata only).',
    ),
  index: z.number().int().min(0).optional().describe('Trigger index (from risu_module_get section=triggers). Required for section=trigger.'),
});

const RisuModuleRemoveArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  moduleId: z.string().describe('Module id (from risu_module_list).'),
});

const RisuModuleAssetsCopyArgs = z.object({
  characterId: z.string().describe('Target character id — the card receiving the assets.'),
  sourceCharacterId: z.string().describe('Source character id — the card holding the module.'),
  moduleId: z.string().describe('Module id on the source character (from risu_module_list).'),
});

// ---------- Character assets ----------

const CharacterAssetListArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
});

const CharacterAssetAddArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  attachmentId: z.string().describe('Attachment id of the file to import as a character asset (e.g. generated by a media tool).'),
  name: z.string().min(1).optional().describe('Asset name. Defaults to the attachment id.'),
  type: z.string().optional().describe('Asset type (e.g. image, audio, video, other). Defaults to a value derived from the attachment MIME type.'),
});

const CharacterAssetRemoveArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  assetId: z.string().describe('Asset id (from character_asset_list).'),
});

const CharacterAssetCopyArgs = z.object({
  characterId: z.string().describe('Target character id — the card receiving the asset.'),
  sourceCharacterId: z.string().describe('Source character id — the card to copy from.'),
  assetId: z.string().describe('Asset id on the source character (from character_asset_list).'),
});

const CharacterAssetsCopyArgs = z.object({
  characterId: z.string().describe('Target character id — the card receiving the assets.'),
  sourceCharacterId: z.string().describe('Source character id — the card to copy from.'),
});

// ---------- Character-coupled backend logic (contextual backends) ----------

const BackendLogicGetArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  offset: z.number().int().min(1).optional().describe('First source line to return (1-indexed). Omit for the full source.'),
  limit: z.number().int().min(1).optional().describe('Max source lines to return. Omit for the full source.'),
});

const BackendLogicSetArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  luaSource: z.string().optional().describe('Lua source implementing generate(prompt, ctx). Omit to keep the current script.'),
  enabled: z.boolean().optional().describe('Activate/deactivate the card logic. Omit to keep the current state. Default for new scripts: false.'),
});

const BackendLogicEditArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  oldString: z
    .string()
    .min(1)
    .describe('Exact text to find in the Lua source. Must match exactly once unless replaceAll is set.'),
  newString: z.string().describe('Replacement text (may be empty to delete the match).'),
  replaceAll: z
    .boolean()
    .optional()
    .describe('Replace every occurrence. Default false — a non-unique oldString is an error.'),
});

const BackendLogicTestArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  input: z.string().min(1).describe('Sample user message fed to generate() as the last prompt message.'),
  luaSource: z.string().optional().describe('Test this Lua source instead of the character\'s stored script — iterate without saving.'),
  state: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    // Models keep passing the snapshot as a parsed object — accept both and
    // normalize to the raw string format dryRunBackendScript expects.
    .transform((v) => (typeof v === 'string' || v === undefined ? v : JSON.stringify(v)))
    .describe('Canned script-state snapshot injected as the `state` global — a JSON string OR a plain object (serialized for you), e.g. the stateOut of a previous dry-run.'),
  delegateResponse: z
    .union([z.string(), z.object({ error: z.string() }), z.object({ text: z.string() })])
    .optional()
    // { text } unwraps to a plain canned-text response.
    .transform((v) => (typeof v === 'object' && 'text' in v ? v.text : v))
    .describe('Canned answer for every delegated backends.generate() call — text, { "text": "..." }, or { "error": "..." } to test delegation failures. Defaults to a placeholder.'),
  history: z
    .array(z.object({ role: z.string(), content: z.string() }))
    .optional()
    .describe('Canned full branch history (oldest first) backing the `chat` global. Omit → `chat` is nil in the dry-run.'),
});

const BackendFilePathArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  path: z.string().describe('Module path inside backend_logic/ (e.g. lib/utils.lua). Slash-separated; the .lua extension is appended when omitted.'),
});

const BackendFileSetArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  path: z.string().describe('Module path inside backend_logic/ (e.g. lib/utils.lua).'),
  luaSource: z.string().describe('Lua module source. The chunk\'s return value is the module; top-level return is allowed.'),
});

const BackendFileEditArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
  path: z.string().describe('Module path inside backend_logic/ (e.g. lib/utils.lua).'),
  oldString: z
    .string()
    .min(1)
    .describe('Exact text to find in the module source. Must match exactly once unless replaceAll is set.'),
  newString: z.string().describe('Replacement text (may be empty to delete the match).'),
  replaceAll: z
    .boolean()
    .optional()
    .describe('Replace every occurrence. Default false — a non-unique oldString is an error.'),
});

const BackendLogicAddGameLibArgs = z.object({
  characterId: z.string().describe(CHARACTER_ID),
});

/** Map a MIME type to a file extension for asset storage/URLs. */
function extFromMime(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.toLowerCase() ?? '';
  const known: Record<string, string> = { 'jpeg': 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico' };
  return known[subtype] ?? (subtype || 'bin');
}

/** Map a MIME type to a coarse asset type. */
function typeFromMime(mimeType: string): string {
  const major = mimeType.split('/')[0]?.toLowerCase() ?? '';
  return ['image', 'audio', 'video'].includes(major) ? major : 'other';
}

export class CharacterWorkbench {

  constructor(private deps: CharacterWorkbenchDeps) {}

  async execute(toolName: string, args: Record<string, unknown>, _context?: ToolContext): Promise<ToolExecuteResult> {
    try {
      switch (toolName) {
        case 'character_get':
          return await this.getCharacter(args);
        case 'character_clone':
          return await this.characterClone(args);
        case 'character_create':
          return await this.createCharacter(args);
        case 'character_update':
          return await this.updateCharacter(args);
        case 'character_set_avatar':
          return await this.setAvatar(args);
        case 'lorebook_get':
          return await this.lorebookGet(args);
        case 'lorebook_entry_add':
          return await this.lorebookEntryAdd(args);
        case 'lorebook_entry_update':
          return await this.lorebookEntryUpdate(args);
        case 'lorebook_entry_remove':
          return await this.lorebookEntryRemove(args);
        case 'lorebook_entry_move':
          return await this.lorebookEntryMove(args);
        case 'regex_list':
          return await this.regexList(args);
        case 'regex_add':
          return await this.regexAdd(args);
        case 'regex_update':
          return await this.regexUpdate(args);
        case 'regex_remove':
          return await this.regexRemove(args);
        case 'regex_test':
          return await this.regexTest(args);
        case 'risu_module_list':
          return await this.risuModuleList(args);
        case 'risu_module_get':
          return await this.risuModuleGet(args);
        case 'risu_module_remove':
          return await this.risuModuleRemove(args);
        case 'risu_module_assets_copy':
          return await this.risuModuleAssetsCopy(args);
        case 'character_asset_list':
          return await this.characterAssetList(args);
        case 'character_asset_add':
          return await this.characterAssetAdd(args);
        case 'character_asset_remove':
          return await this.characterAssetRemove(args);
        case 'character_asset_copy':
          return await this.characterAssetCopy(args);
        case 'character_assets_copy':
          return await this.characterAssetsCopy(args);
        case 'backend_logic_get':
          return await this.backendLogicGet(args);
        case 'backend_logic_set':
          return await this.backendLogicSet(args);
        case 'backend_logic_edit':
          return await this.backendLogicEdit(args);
        case 'backend_logic_test':
          return await this.backendLogicTest(args);
        case 'backend_file_list':
          return await this.backendFileList(args);
        case 'backend_file_get':
          return await this.backendFileGet(args);
        case 'backend_file_set':
          return await this.backendFileSet(args);
        case 'backend_file_remove':
          return await this.backendFileRemove(args);
        case 'backend_file_edit':
          return await this.backendFileEdit(args);
        case 'backend_logic_add_game_lib':
          return await this.backendLogicAddGameLib(args);
        default:
          return { content: `Error: unknown tool ${toolName}` };
      }
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async getCharacter(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CharacterGetArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };
    return { content: JSON.stringify(withCharacterAvatar(character)) };
  }

  private async createCharacter(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CharacterCreateArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await createCharacter(this.deps, parsed.data);
    // Mirror the character.create dispatcher handler: created + snapshot + listed
    // (created/listed come from the shared mutation, snapshot is added here).
    this.deps.bus.broadcast({ type: 'character.snapshot', character: withCharacterAvatar(character) });
    // Slim result: the model wrote these fields itself — it needs the id, not an echo.
    return { content: JSON.stringify({ id: character.id, name: character.name }) };
  }

  /**
   * Deep-copy a character onto a new card: fields, extensions (regex rules,
   * backend logic, raw RisuAI module files), avatar files, the linked lorebook
   * (new book, same entries), and all character assets.
   */
  private async characterClone(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CharacterCloneArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const source = await this.deps.characters.getById(parsed.data.sourceCharacterId);
    if (!source) return { content: `Error: character "${parsed.data.sourceCharacterId}" not found` };

    const name = parsed.data.name ?? `${source.name} (Copy)`;
    const clash = await this.deps.characters.getByName(name);
    if (clash) return { content: `Error: character "${name}" already exists — pass a different name` };

    const id = randomUUID();

    // Lorebook first: the clone links to its own copy of the book.
    let worldInfoId: string | null = null;
    let lorebookEntries = 0;
    const sourceBook = await this.getCharacterLorebook(source);
    if (sourceBook) {
      worldInfoId = randomUUID();
      lorebookEntries = sourceBook.entries.length;
      const book = await this.deps.worldInfo.create(worldInfoId, { name: sourceBook.name, entries: sourceBook.entries });
      await this.broadcastBook('created', book);
    }

    // Avatar files (copy, not share — deleting the original must not break the clone).
    let avatarPath: string | null = null;
    let avatarThumbnailPath: string | null = null;
    if (source.avatarPath && this.deps.storage.exists(source.avatarPath)) {
      avatarPath = this.deps.storage.write('avatars', `${randomUUID()}.png`, new Uint8Array(this.deps.storage.read(source.avatarPath)));
    }
    if (source.avatarThumbnailPath && this.deps.storage.exists(source.avatarThumbnailPath)) {
      avatarThumbnailPath = this.deps.storage.write('avatars/thumbs', `${randomUUID()}.png`, new Uint8Array(this.deps.storage.read(source.avatarThumbnailPath)));
    }

    // Extensions: deep copy; raw RisuAI module files are duplicated and their
    // meta filePaths rewritten to the clone's directory.
    const extensions = structuredClone(source.extensions);
    let modulesCopied = 0;
    const moduleMetas = listRisuModuleMeta(source);
    if (moduleMetas.length > 0) {
      const newMetas: RisuModuleMeta[] = [];
      for (const meta of moduleMetas) {
        if (!this.deps.storage.exists(meta.filePath)) continue;
        const newPath = this.deps.storage.write(
          `character_modules/${id}`,
          `${meta.id}.json`,
          new Uint8Array(this.deps.storage.read(meta.filePath)),
        );
        newMetas.push({ ...meta, filePath: newPath });
        modulesCopied++;
      }
      extensions[CHARACTER_RISU_MODULES_EXTENSION_KEY] = newMetas;
    }

    const created = await this.deps.characters.create(id, {
      name,
      description: source.description,
      personality: source.personality,
      scenario: source.scenario,
      firstMes: source.firstMes,
      mesExample: source.mesExample,
      creator: source.creator,
      characterVersion: source.characterVersion,
      tags: [...source.tags],
      avatarPath,
      avatarThumbnailPath,
      creatorNotes: source.creatorNotes,
      systemPrompt: source.systemPrompt,
      postHistoryInstructions: source.postHistoryInstructions,
      alternateGreetings: [...source.alternateGreetings],
      groupOnlyGreetings: [...source.groupOnlyGreetings],
      nickname: source.nickname,
      creatorNotesMultilingual: { ...source.creatorNotesMultilingual },
      source: [...source.source],
      extensions,
      createDate: new Date().toISOString(),
      worldInfoId,
    });

    // Assets: duplicate files + records (new ids so the clone owns its copies).
    const sourceAssets = await this.deps.characterAssets.listForCharacter(source.id);
    let assetsCopied = 0;
    for (const asset of sourceAssets) {
      const copy = await this.copyAssetTo(id, asset);
      if (copy) assetsCopied++;
    }

    // Same enrichment + broadcast set as the import/avatar paths.
    const assetList = await this.deps.characterAssets.listForCharacter(id);
    const enriched = withCharacterAssets(withCharacterAvatar(created), assetList);
    this.deps.bus.broadcast({ type: 'character.created', character: enriched });
    this.deps.bus.broadcast({ type: 'character.snapshot', character: enriched });
    const list = await this.deps.characters.listSummaries();
    this.deps.bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) });

    return { content: JSON.stringify({ id, name, lorebookEntries, assetsCopied, modulesCopied }) };
  }

  private async updateCharacter(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CharacterUpdateArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await updateCharacter(this.deps, parsed.data.characterId, parsed.data.patch);
    // Same snapshot event as the character.update dispatcher handler.
    this.deps.bus.broadcast({ type: 'character.snapshot', character: withCharacterAvatar(character) });
    return { content: JSON.stringify({ id: character.id, name: character.name }) };
  }

  /** Set a character's avatar from an attachment image or another card's avatar (shared pipeline with the REST upload route). */
  private async setAvatar(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CharacterSetAvatarArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, attachmentId, sourceCharacterId } = parsed.data;
    if (attachmentId !== undefined && sourceCharacterId !== undefined) {
      return { content: 'Error: pass exactly one of attachmentId or sourceCharacterId' };
    }

    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };

    let buffer: Buffer;
    if (attachmentId !== undefined) {
      const attachment = await this.deps.attachments.getById(attachmentId);
      if (!attachment) return { content: `Error: attachment "${attachmentId}" not found` };
      if (!attachment.mimeType.startsWith('image/')) {
        return { content: `Error: attachment "${attachmentId}" is not an image (${attachment.mimeType})` };
      }
      try {
        buffer = this.deps.storage.read(attachment.filePath);
      } catch {
        return { content: `Error: attachment file for "${attachmentId}" is missing on disk` };
      }
    } else if (sourceCharacterId !== undefined) {
      const source = await this.deps.characters.getById(sourceCharacterId);
      if (!source) return { content: `Error: character "${sourceCharacterId}" not found` };
      if (!source.avatarPath) return { content: `Error: character "${sourceCharacterId}" has no avatar to copy` };
      try {
        buffer = this.deps.storage.read(source.avatarPath);
      } catch {
        return { content: `Error: avatar file for character "${sourceCharacterId}" is missing on disk` };
      }
    } else {
      return { content: 'Error: pass exactly one of attachmentId or sourceCharacterId' };
    }

    try {
      const enriched = await setCharacterAvatarFromBuffer(
        { characters: this.deps.characters, characterAssets: this.deps.characterAssets, storage: this.deps.storage, bus: this.deps.bus },
        character,
        buffer,
      );
      // Slim result: id + the new avatar URLs, not the full card with its asset list.
      return {
        content: JSON.stringify({
          id: character.id,
          avatarUrl: enriched.avatarPath ? `/${enriched.avatarPath}` : null,
          thumbnailUrl: enriched.avatarThumbnailPath ? `/${enriched.avatarThumbnailPath}` : null,
        }),
      };
    } catch (err) {
      return { content: `Error: failed to process avatar image: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ---------- Shared broadcast helpers ----------

  /** The character.updated + character.snapshot + character.listed triplet other mutation paths emit. */
  private async broadcastCharacterMutation(updated: Character): Promise<void> {
    const enriched = withCharacterAvatar(updated);
    this.deps.bus.broadcast({ type: 'character.updated', character: enriched });
    this.deps.bus.broadcast({ type: 'character.snapshot', character: enriched });
    const list = await this.deps.characters.listSummaries();
    this.deps.bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) });
  }

  /** Same broadcast triplet + RAG re-index as the dispatcher's worldinfo.* handlers. */
  private async broadcastBook(kind: 'created' | 'updated', book: WorldInfo): Promise<void> {
    this.deps.ragService?.indexWorldInfoEntries(book.id, book.entries).catch((err) => log.warn({ err }, 'rag index failed'));
    this.deps.bus.broadcast({ type: `worldinfo.${kind}`, book });
    this.deps.bus.broadcast({ type: 'worldinfo.snapshot', book });
    const list = await this.deps.worldInfo.list();
    this.deps.bus.broadcast({ type: 'worldinfo.listed', books: list });
  }

  // ---------- Character lorebook (1:1 with the card) ----------

  private async getCharacterLorebook(character: Character): Promise<WorldInfo | null> {
    if (!character.worldInfoId) return null;
    return (await this.deps.worldInfo.getById(character.worldInfoId)) ?? null;
  }

  /**
   * Resolve the character's lorebook for a WRITE, creating and linking an empty
   * book on first use. The model never manages standalone books: from its
   * perspective every card simply has a lorebook once it has entries.
   */
  private async requireLorebookForWrite(character: Character): Promise<WorldInfo> {
    const existing = await this.getCharacterLorebook(character);
    if (existing) return existing;
    const book = await this.deps.worldInfo.create(randomUUID(), { name: character.name, entries: [] });
    const updated = await this.deps.characters.update(character.id, { worldInfoId: book.id });
    await this.broadcastCharacterMutation(updated);
    await this.broadcastBook('created', book);
    return book;
  }

  private async lorebookGet(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = LorebookGetArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };
    const book = await this.getCharacterLorebook(character);
    return { content: JSON.stringify({ name: book?.name ?? null, entries: book?.entries ?? [] }) };
  }

  private async lorebookEntryAdd(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = LorebookEntryAddArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };
    const book = await this.requireLorebookForWrite(character);
    const newEntry: WorldInfoEntry = { id: randomUUID(), ...parsed.data.entry };
    const updated = await this.deps.worldInfo.update(book.id, { entries: [...book.entries, newEntry] });
    await this.broadcastBook('updated', updated);
    return { content: JSON.stringify(newEntry) };
  }

  /** Resolve character + its lorebook + the target entry, or return an error result. */
  private async resolveLorebookEntry(
    characterId: string,
    entryId: string,
  ): Promise<{ error: string } | { book: WorldInfo; entry: WorldInfoEntry }> {
    const character = await this.deps.characters.getById(characterId);
    if (!character) return { error: `Error: character "${characterId}" not found` };
    const book = await this.getCharacterLorebook(character);
    if (!book) return { error: `Error: character "${characterId}" has no lorebook yet — add an entry with lorebook_entry_add first` };
    const entry = book.entries.find((e) => e.id === entryId);
    if (!entry) return { error: `Error: entry "${entryId}" not found in the character's lorebook` };
    return { book, entry };
  }

  private async lorebookEntryUpdate(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = LorebookEntryUpdateArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, entryId, patch } = parsed.data;
    const resolved = await this.resolveLorebookEntry(characterId, entryId);
    if ('error' in resolved) return { content: resolved.error };
    // makeUpdateSchema erases field types (ZodTypeAny) — the shape is validated, cast to the domain patch type.
    const entryPatch = patch as Partial<WorldInfoEntry>;
    const updatedEntry: WorldInfoEntry = { ...resolved.entry, ...entryPatch };
    const nextEntries = resolved.book.entries.map((e) => (e.id === entryId ? updatedEntry : e));
    const updated = await this.deps.worldInfo.update(resolved.book.id, { entries: nextEntries });
    await this.broadcastBook('updated', updated);
    return { content: JSON.stringify(updatedEntry) };
  }

  private async lorebookEntryRemove(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = LorebookEntryRemoveArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, entryId } = parsed.data;
    const resolved = await this.resolveLorebookEntry(characterId, entryId);
    if ('error' in resolved) return { content: resolved.error };
    const updated = await this.deps.worldInfo.update(resolved.book.id, {
      entries: resolved.book.entries.filter((e) => e.id !== entryId),
    });
    await this.broadcastBook('updated', updated);
    return { content: JSON.stringify({ removed: entryId }) };
  }

  private async lorebookEntryMove(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = LorebookEntryMoveArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, entryId, index } = parsed.data;
    const resolved = await this.resolveLorebookEntry(characterId, entryId);
    if ('error' in resolved) return { content: resolved.error };
    const rest = resolved.book.entries.filter((e) => e.id !== entryId);
    const clamped = Math.min(index, rest.length);
    rest.splice(clamped, 0, resolved.entry);
    const updated = await this.deps.worldInfo.update(resolved.book.id, { entries: rest });
    await this.broadcastBook('updated', updated);
    return { content: JSON.stringify({ entryId, index: clamped, entryOrder: rest.map((e) => e.id) }) };
  }

  // ---------- Character-scoped regex rules ----------

  /** Persist the character's regex rules and broadcast the character triplet. */
  private async saveRegexRules(character: Character, rules: RegexRule[]): Promise<void> {
    const updated = await this.deps.characters.update(character.id, {
      extensions: { ...character.extensions, [CHARACTER_REGEX_EXTENSION_KEY]: rules },
    });
    await this.broadcastCharacterMutation(updated);
  }

  private validateFindRegex(findRegex: string): string | null {
    return parseRegexString(findRegex) ? null : `Error: invalid findRegex "${findRegex}" — use JS-style delimiters, e.g. "/pattern/gi"`;
  }

  private async regexList(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = RegexListArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };
    return { content: JSON.stringify(getCharacterRegexRules(character)) };
  }

  private async regexAdd(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = RegexAddArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, rule } = parsed.data;
    // Empty findRegex is allowed (inert placeholder); non-empty must parse.
    if (rule.findRegex) {
      const invalid = this.validateFindRegex(rule.findRegex);
      if (invalid) return { content: invalid };
    }

    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };
    const newRule: RegexRule = {
      id: randomUUID(),
      name: rule.name,
      findRegex: rule.findRegex ?? '',
      replaceString: rule.replaceString ?? '',
      ...(rule.replaceLua !== undefined ? { replaceLua: rule.replaceLua } : {}),
      disabled: rule.disabled ?? false,
      userInput: rule.userInput ?? false,
      aiOutput: rule.aiOutput ?? false,
      prompt: rule.prompt ?? true,
      display: rule.display ?? true,
    };
    await this.saveRegexRules(character, [...getCharacterRegexRules(character), newRule]);
    return { content: JSON.stringify(newRule) };
  }

  private async regexUpdate(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = RegexUpdateArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, ruleId, patch } = parsed.data;
    if (patch.findRegex) {
      const invalid = this.validateFindRegex(patch.findRegex);
      if (invalid) return { content: invalid };
    }

    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };
    const rules = getCharacterRegexRules(character);
    const existing = rules.find((r) => r.id === ruleId);
    if (!existing) return { content: `Error: regex rule "${ruleId}" not found on character "${characterId}"` };
    const updatedRule: RegexRule = { ...existing, ...patch };
    await this.saveRegexRules(character, rules.map((r) => (r.id === ruleId ? updatedRule : r)));
    return { content: JSON.stringify(updatedRule) };
  }

  private async regexRemove(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = RegexRemoveArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, ruleId } = parsed.data;

    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };
    const rules = getCharacterRegexRules(character);
    if (!rules.some((r) => r.id === ruleId)) {
      return { content: `Error: regex rule "${ruleId}" not found on character "${characterId}"` };
    }
    await this.saveRegexRules(character, rules.filter((r) => r.id !== ruleId));
    return { content: JSON.stringify({ removed: ruleId }) };
  }

  /** Preview merged rules (global + character-scoped) against sample text. */
  private async regexTest(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = RegexTestArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, text } = parsed.data;
    const role = parsed.data.role ?? 'assistant';

    let rules = getGlobalRegexRules(await this.deps.settings.list());
    if (characterId !== undefined) {
      const character = await this.deps.characters.getById(characterId);
      if (!character) return { content: `Error: character "${characterId}" not found` };
      rules = mergeRegexRules(rules, character);
    }

    const promptOut = await applyRules(text, filterRulesByRole(rules, 'prompt', role));
    const displayOut = await applyRules(text, filterRulesByRole(rules, 'display', role));
    return {
      content: JSON.stringify({
        role,
        ruleCount: rules.filter((r) => !r.disabled).length,
        prompt: promptOut,
        display: displayOut,
      }),
    };
  }

  // ---------- Raw RisuAI modules (porting workflow) ----------

  /** Resolve character + module meta + raw module JSON, or return an error result. */
  private async resolveRisuModule(
    characterId: string,
    moduleId: string,
  ): Promise<{ error: string } | { character: Character; meta: RisuModuleMeta; module: RisuModuleData }> {
    const character = await this.deps.characters.getById(characterId);
    if (!character) return { error: `Error: character "${characterId}" not found` };
    const meta = listRisuModuleMeta(character).find((m) => m.id === moduleId);
    if (!meta) return { error: `Error: risu module "${moduleId}" not found on character "${characterId}"` };
    const module = loadRisuModule(this.deps.storage, meta);
    if (!module) return { error: `Error: stored data for risu module "${moduleId}" is missing on disk` };
    return { character, meta, module };
  }

  private async risuModuleList(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = RisuModuleListArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };
    const metas = listRisuModuleMeta(character);
    return { content: JSON.stringify({ total: metas.length, modules: metas }) };
  }

  private async risuModuleGet(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = RisuModuleGetArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, moduleId, section, index } = parsed.data;
    const resolved = await this.resolveRisuModule(characterId, moduleId);
    if ('error' in resolved) return { content: resolved.error };
    const result = getRisuModuleSection(resolved.module, section, index);
    if (!result.ok) return { content: `Error: ${result.error}` };
    return { content: JSON.stringify(result.data) };
  }

  private async risuModuleRemove(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = RisuModuleRemoveArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, moduleId } = parsed.data;
    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };
    if (!listRisuModuleMeta(character).some((m) => m.id === moduleId)) {
      return { content: `Error: risu module "${moduleId}" not found on character "${characterId}"` };
    }
    const remaining = removeRisuModule(this.deps.storage, character, moduleId);
    const updated = await this.deps.characters.update(characterId, {
      extensions: { ...character.extensions, [CHARACTER_RISU_MODULES_EXTENSION_KEY]: remaining },
    });
    await this.broadcastCharacterMutation(updated);
    return { content: JSON.stringify({ removed: moduleId }) };
  }

  private async risuModuleAssetsCopy(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = RisuModuleAssetsCopyArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, sourceCharacterId, moduleId } = parsed.data;
    const resolved = await this.resolveCopyCharacters(characterId, sourceCharacterId);
    if ('error' in resolved) return { content: resolved.error };
    const meta = listRisuModuleMeta(resolved.source).find((m) => m.id === moduleId);
    if (!meta) return { content: `Error: risu module "${moduleId}" not found on character "${sourceCharacterId}"` };

    // .risum-attached module payloads are stored as ordinary character assets
    // tagged with the module id (storeRisuModuleAssets). CharX-embedded modules
    // have no separately-stored payloads — their assets ARE the card's assets.
    const assets = (await this.deps.characterAssets.listForCharacter(sourceCharacterId)).filter(
      (a) => a.meta['moduleId'] === moduleId,
    );
    if (assets.length === 0) {
      return {
        content: `Error: no separately-stored assets for module "${meta.name}" — CharX-embedded modules share the card's regular assets; use character_assets_copy instead`,
      };
    }
    const result = await this.copyAssets(characterId, resolved.target, assets);
    return { content: JSON.stringify(result) };
  }

  // ---------- Character assets ----------

  private toAssetSummary(characterId: string, a: CharacterAsset): Record<string, unknown> {
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      ext: a.ext,
      assetUrl: a.filePath ? `/api/characters/${characterId}/assets/${a.id}.${a.ext}` : null,
      origin: typeof a.meta['origin'] === 'string' ? a.meta['origin'] : 'card',
    };
  }

  private async characterAssetList(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CharacterAssetListArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };
    const assets = await this.deps.characterAssets.listForCharacter(character.id);
    return {
      content: JSON.stringify({
        total: assets.length,
        assets: assets.map((a) => this.toAssetSummary(character.id, a)),
      }),
    };
  }

  private async characterAssetAdd(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CharacterAssetAddArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, attachmentId, name, type } = parsed.data;
    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };
    const attachment = await this.deps.attachments.getById(attachmentId);
    if (!attachment) return { content: `Error: attachment "${attachmentId}" not found` };

    let buffer: Buffer;
    try {
      buffer = this.deps.storage.read(attachment.filePath);
    } catch {
      return { content: `Error: attachment file for "${attachmentId}" is missing on disk` };
    }

    const assetId = randomUUID();
    const ext = extFromMime(attachment.mimeType);
    const relPath = this.deps.storage.write(`character_assets/${characterId}`, `${assetId}.${ext}`, new Uint8Array(buffer));
    const asset = await this.deps.characterAssets.create(characterId, {
      id: assetId,
      name: name ?? attachmentId,
      type: type ?? typeFromMime(attachment.mimeType),
      ext,
      filePath: relPath,
      meta: { origin: 'workbench' },
    });
    await this.broadcastCharacterMutation(character);
    return { content: JSON.stringify(this.toAssetSummary(characterId, asset)) };
  }

  private async characterAssetRemove(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CharacterAssetRemoveArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, assetId } = parsed.data;
    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };
    const asset = await this.deps.characterAssets.getById(assetId);
    if (!asset || asset.characterId !== characterId) {
      return { content: `Error: asset "${assetId}" not found on character "${characterId}"` };
    }
    if (asset.filePath) this.deps.storage.delete(asset.filePath);
    await this.deps.characterAssets.delete(assetId);
    await this.broadcastCharacterMutation(character);
    return { content: JSON.stringify({ removed: assetId }) };
  }

  // ---------- Asset copying (clone/port workflow) ----------

  /** Resolve target + source characters for a copy, rejecting self-copies. */
  private async resolveCopyCharacters(
    characterId: string,
    sourceCharacterId: string,
  ): Promise<{ error: string } | { target: Character; source: Character }> {
    if (characterId === sourceCharacterId) return { error: 'Error: source and target character are the same' };
    const target = await this.deps.characters.getById(characterId);
    if (!target) return { error: `Error: character "${characterId}" not found` };
    const source = await this.deps.characters.getById(sourceCharacterId);
    if (!source) return { error: `Error: character "${sourceCharacterId}" not found` };
    return { target, source };
  }

  /**
   * Duplicate one asset's file + record onto the target character (new id, so
   * the target owns its copy). Returns null when the source has no readable file.
   */
  private async copyAssetTo(targetCharacterId: string, source: CharacterAsset): Promise<CharacterAsset | null> {
    if (!source.filePath) return null;
    let buffer: Buffer;
    try {
      buffer = this.deps.storage.read(source.filePath);
    } catch {
      return null;
    }
    const assetId = randomUUID();
    const relPath = this.deps.storage.write(`character_assets/${targetCharacterId}`, `${assetId}.${source.ext}`, new Uint8Array(buffer));
    return await this.deps.characterAssets.create(targetCharacterId, {
      id: assetId,
      name: source.name,
      type: source.type,
      ext: source.ext,
      filePath: relPath,
      meta: { ...source.meta },
    });
  }

  /** Copy a set of assets onto the target character, broadcast, and summarize. */
  private async copyAssets(
    characterId: string,
    target: Character,
    assets: CharacterAsset[],
  ): Promise<Record<string, unknown>> {
    const created: CharacterAsset[] = [];
    let skipped = 0;
    for (const asset of assets) {
      const copy = await this.copyAssetTo(characterId, asset);
      if (copy) created.push(copy);
      else skipped++;
    }
    await this.broadcastCharacterMutation(target);
    return {
      copied: created.length,
      skipped,
      assets: created.map((a) => this.toAssetSummary(characterId, a)),
    };
  }

  private async characterAssetCopy(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CharacterAssetCopyArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, sourceCharacterId, assetId } = parsed.data;
    const resolved = await this.resolveCopyCharacters(characterId, sourceCharacterId);
    if ('error' in resolved) return { content: resolved.error };
    const asset = await this.deps.characterAssets.getById(assetId);
    if (!asset || asset.characterId !== sourceCharacterId) {
      return { content: `Error: asset "${assetId}" not found on character "${sourceCharacterId}"` };
    }
    const created = await this.copyAssetTo(characterId, asset);
    if (!created) return { content: `Error: asset "${assetId}" has no stored file to copy` };
    await this.broadcastCharacterMutation(resolved.target);
    return { content: JSON.stringify(this.toAssetSummary(characterId, created)) };
  }

  private async characterAssetsCopy(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = CharacterAssetsCopyArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, sourceCharacterId } = parsed.data;
    const resolved = await this.resolveCopyCharacters(characterId, sourceCharacterId);
    if ('error' in resolved) return { content: resolved.error };
    const assets = await this.deps.characterAssets.listForCharacter(sourceCharacterId);
    if (assets.length === 0) return { content: `Error: character "${sourceCharacterId}" has no assets to copy` };
    const result = await this.copyAssets(characterId, resolved.target, assets);
    return { content: JSON.stringify(result) };
  }

  // ---------- Character-coupled backend logic (contextual backends) ----------

  private async backendLogicGet(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendLogicGetArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };
    const raw = character.extensions[CHARACTER_BACKEND_EXTENSION_KEY];
    const ext = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const enabled = ext['enabled'] === true;
    const luaSource = typeof ext['luaSource'] === 'string' ? ext['luaSource'] : '';

    const { offset, limit } = parsed.data;
    if (offset !== undefined || limit !== undefined) {
      const lines = luaSource.split('\n');
      const start = (offset ?? 1) - 1;
      const slice = lines.slice(start, limit !== undefined ? start + limit : undefined);
      const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join('\n');
      return { content: JSON.stringify({ enabled, totalLines: lines.length, offset: start + 1, luaSource: numbered }) };
    }
    return { content: JSON.stringify({ enabled, luaSource }) };
  }

  private async backendLogicSet(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendLogicSetArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, luaSource, enabled } = parsed.data;
    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };

    const raw = character.extensions[CHARACTER_BACKEND_EXTENSION_KEY];
    const existing = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    // Spread the stored extension so sibling keys (the `files` module map)
    // survive a source/toggle update.
    const next = {
      ...existing,
      enabled: enabled ?? existing['enabled'] === true,
      luaSource: luaSource ?? (typeof existing['luaSource'] === 'string' ? existing['luaSource'] : ''),
    };

    // Source writes are load-validated (against the card's module map, so
    // top-level require resolves) before saving — a bare enabled toggle is not.
    if (luaSource !== undefined) {
      const invalid = await this.validateBackendSource(next.luaSource, this.getBackendFiles(character));
      if (invalid !== null) {
        return { content: `Error: write rejected (NOT saved) — the script fails to load: ${invalid}` };
      }
    }

    const updated = await this.deps.characters.update(characterId, {
      extensions: { ...character.extensions, [CHARACTER_BACKEND_EXTENSION_KEY]: next },
    });
    await this.broadcastCharacterMutation(updated);
    return { content: JSON.stringify(next) };
  }

  /** Load-check Lua via the shared validator (scripting/validateLuaSource.ts). */
  private validateLuaSource(source: string, files: Record<string, string>, needsGenerate: boolean): Promise<string | null> {
    return validateLuaSourceInSandbox(this.deps.luaRuntime, source, files, needsGenerate);
  }

  /** Load-check a backend script: must load and define generate(). */
  private validateBackendSource(source: string, files: Record<string, string>): Promise<string | null> {
    return this.validateLuaSource(source, files, true);
  }

  private async backendLogicEdit(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendLogicEditArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, oldString, newString, replaceAll } = parsed.data;
    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };

    const raw = character.extensions[CHARACTER_BACKEND_EXTENSION_KEY];
    const ext = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const source = typeof ext['luaSource'] === 'string' ? ext['luaSource'] : '';
    if (source.length === 0) {
      return { content: 'Error: no stored backend logic to edit — create one with backend_logic_set first' };
    }

    const occurrences = source.split(oldString).length - 1;
    if (occurrences === 0) return { content: 'Error: oldString not found in the backend logic' };
    if (occurrences > 1 && replaceAll !== true) {
      return {
        content: `Error: oldString matches ${occurrences} locations — provide more surrounding context for a unique match, or set replaceAll: true`,
      };
    }
    const nextSource = source.split(oldString).join(newString);

    const invalid = await this.validateBackendSource(nextSource, this.getBackendFiles(character));
    if (invalid !== null) {
      return { content: `Error: edit rejected (NOT saved) — the edited script fails to load: ${invalid}` };
    }

    const next = { ...ext, enabled: ext['enabled'] === true, luaSource: nextSource };
    const updated = await this.deps.characters.update(characterId, {
      extensions: { ...character.extensions, [CHARACTER_BACKEND_EXTENSION_KEY]: next },
    });
    await this.broadcastCharacterMutation(updated);
    return {
      content: JSON.stringify({ replacements: occurrences, lines: nextSource.split('\n').length, enabled: next.enabled }),
    };
  }

  private async backendLogicTest(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendLogicTestArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const { characterId, input, luaSource, state, delegateResponse, history } = parsed.data;
    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };

    let source = luaSource;
    if (source === undefined) {
      const raw = character.extensions[CHARACTER_BACKEND_EXTENSION_KEY];
      const ext = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      source = typeof ext['luaSource'] === 'string' ? ext['luaSource'] : '';
      if (source.length === 0) {
        return { content: 'Error: character has no stored backend logic — pass luaSource to test unsaved source' };
      }
    }

    const files = this.getBackendFiles(character);
    const outcome = await dryRunBackendScript(this.deps.luaRuntime, {
      luaSource: source,
      input,
      state,
      delegateResponse,
      history,
      files: Object.keys(files).length > 0 ? files : undefined,
      character: {
        id: character.id,
        name: character.name,
        description: character.description,
        firstMes: character.firstMes,
      },
    });
    return { content: JSON.stringify(outcome) };
  }

  // ── backend_logic/ module files (the card VFS behind `require`) ────────

  /** Tolerant read of the stored module map (string→string entries only). */
  private getBackendFiles(character: Character): Record<string, string> {
    const raw = character.extensions[CHARACTER_BACKEND_EXTENSION_KEY];
    const ext = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const rawFiles = ext['files'];
    if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) return {};
    const files: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawFiles as Record<string, unknown>)) {
      if (typeof value === 'string') files[key] = value;
    }
    return files;
  }

  /** Persist a new module map, preserving every other extension key. */
  private async setBackendFiles(character: Character, files: Record<string, string>): Promise<void> {
    const raw = character.extensions[CHARACTER_BACKEND_EXTENSION_KEY];
    const ext = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const updated = await this.deps.characters.update(character.id, {
      extensions: { ...character.extensions, [CHARACTER_BACKEND_EXTENSION_KEY]: { ...ext, files } },
    });
    await this.broadcastCharacterMutation(updated);
  }

  private async backendFileList(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendFilePathArgs.pick({ characterId: true }).safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };
    return { content: JSON.stringify({ files: Object.keys(this.getBackendFiles(character)).sort() }) };
  }

  private async backendFileGet(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendFilePathArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const key = validateVfsPath(parsed.data.path);
    if (key === null) return { content: `Error: invalid module path "${parsed.data.path}"` };
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };
    const luaSource = this.getBackendFiles(character)[key];
    if (luaSource === undefined) return { content: `Error: no such module: ${key}` };
    return { content: JSON.stringify({ path: key, luaSource }) };
  }

  /** Load-check a module: the chunk must load (top-level return allowed —
      the generate() requirement applies to main.lua only). */
  private validateModuleSource(source: string, files: Record<string, string>): Promise<string | null> {
    return this.validateLuaSource(source, files, false);
  }

  private async backendFileSet(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendFileSetArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const key = validateVfsPath(parsed.data.path);
    if (key === null) {
      return { content: `Error: invalid module path "${parsed.data.path}" — use slash-separated segments of [A-Za-z0-9_-] with a .lua extension (no "..", no leading "/")` };
    }
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };

    const files = { ...this.getBackendFiles(character), [key]: parsed.data.luaSource };
    const invalid = await this.validateModuleSource(parsed.data.luaSource, files);
    if (invalid !== null) {
      return { content: `Error: write rejected (NOT saved) — the module fails to load: ${invalid}` };
    }

    await this.setBackendFiles(character, files);
    return { content: JSON.stringify({ path: key, lines: parsed.data.luaSource.split('\n').length }) };
  }

  private async backendFileRemove(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendFilePathArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const key = validateVfsPath(parsed.data.path);
    if (key === null) return { content: `Error: invalid module path "${parsed.data.path}"` };
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };
    const files = this.getBackendFiles(character);
    if (files[key] === undefined) return { content: `Error: no such module: ${key}` };
    const { [key]: _removed, ...rest } = files;
    await this.setBackendFiles(character, rest);
    return { content: JSON.stringify({ removed: key }) };
  }

  private async backendFileEdit(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendFileEditArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const key = validateVfsPath(parsed.data.path);
    if (key === null) return { content: `Error: invalid module path "${parsed.data.path}"` };
    const { characterId, oldString, newString, replaceAll } = parsed.data;
    const character = await this.deps.characters.getById(characterId);
    if (!character) return { content: `Error: character "${characterId}" not found` };

    const source = this.getBackendFiles(character)[key];
    if (source === undefined) {
      return { content: `Error: no such module: ${key} — create it with a write first` };
    }

    const occurrences = source.split(oldString).length - 1;
    if (occurrences === 0) return { content: 'Error: oldString not found in the module' };
    if (occurrences > 1 && replaceAll !== true) {
      return {
        content: `Error: oldString matches ${occurrences} locations — provide more surrounding context for a unique match, or set replaceAll: true`,
      };
    }
    const nextSource = source.split(oldString).join(newString);

    const files = { ...this.getBackendFiles(character), [key]: nextSource };
    const invalid = await this.validateModuleSource(nextSource, files);
    if (invalid !== null) {
      return { content: `Error: edit rejected (NOT saved) — the edited module fails to load: ${invalid}` };
    }

    await this.setBackendFiles(character, files);
    return {
      content: JSON.stringify({ path: key, replacements: occurrences, lines: nextSource.split('\n').length }),
    };
  }

  /**
   * Vendor the game lib (docs/design/examples/game-lib/*.lua) into the card's
   * backend_logic/lib/ VFS. Overwrites lib/<module>.lua keys only — the card's
   * own modules, luaSource, and enabled flag are preserved. Re-running after
   * editing a lib copy restores the canonical module; editing lib/loop.lua
   * afterward keeps the card's copy pinned until then.
   */
  private async backendLogicAddGameLib(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = BackendLogicAddGameLibArgs.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);
    const character = await this.deps.characters.getById(parsed.data.characterId);
    if (!character) return { content: `Error: character "${parsed.data.characterId}" not found` };

    const lib = gameLibFiles();
    const files = { ...this.getBackendFiles(character), ...lib };
    await this.setBackendFiles(character, files);
    return { content: JSON.stringify({ added: Object.keys(lib).sort(), total: Object.keys(files).length }) };
  }
}
