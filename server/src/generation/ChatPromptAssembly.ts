/**
 * ChatPromptAssembly — the full chat-prompt assembly policy, shared by every
 * target that builds a "real" chat prompt (AssistantMessageTarget,
 * DraftTarget, TranscriptTarget with assembly 'chat').
 *
 * Moved verbatim from GenerationService.buildGenerationPrompt (plus its
 * private helpers) as part of the generation-runner migration
 * (docs/design/generation-runner.md): the machinery is constructor-injected
 * and shared; targets supply identity (chat/character) and per-kind options.
 *
 * The old `impersonatePrompt` / `syntheticUserText` options are unified into
 * `trailingSeed` — a synthetic trailing history message appended after the
 * resolved branch (role 'system' for impersonate, 'user' for quiet gens).
 */

import { getLogger, logger } from '../lib/logger.js';
import { str } from '../lib/coerce.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { IAttachmentRepository } from '../repos/AttachmentRepository.js';
import type { IWorldInfoRepository } from '../repos/WorldInfoRepository.js';
import type { ICharacterAssetRepository } from '../repos/CharacterAssetRepository.js';
import type { PromptBuilder, AuthorsNoteConfig } from '../pipeline/PromptBuilder.js';
import type { InstructTemplate } from '../pipeline/renderers/InstructTemplate.js';
import type { ToolRegistry } from '../services/ToolRegistry.js';
import type { IToolsetRepository } from '../repos/ToolsetRepository.js';
import type { RAGService } from '../services/RAGService.js';
import type { MemoryService } from '../services/MemoryService.js';
import type { FileStorage } from '../services/FileStorage.js';
import { MacroResolver } from '../pipeline/MacroResolver.js';
import { mergeRegexRules, getGlobalRegexRules } from '../services/characterRegex.js';
import { getMessageText } from '@tamari/types';
import type {
  Message,
  Character,
  Chat,
  Attachment,
  ContentPart,
  MessageAttachment,
  RegexRule,
} from '@tamari/types';
import type { Prompt } from '../backends/BackendAdapter.js';
import type { ResolvedGenerationBackend } from './GenerationTarget.js';

const log = getLogger('ChatPromptAssembly');

export interface ChatPromptAssemblyDeps {
  chats: IChatRepository;
  personas: IPersonaRepository;
  attachments: IAttachmentRepository;
  storage: FileStorage;
  promptBuilder: PromptBuilder;
  worldInfo: IWorldInfoRepository;
  characterAssets: ICharacterAssetRepository;
  ragService?: RAGService;
  memoryService?: MemoryService;
  toolRegistry?: ToolRegistry;
  toolsetRepo?: IToolsetRepository;
}

export interface ChatPromptBuildArgs {
  chatId: string;
  chat: Chat | null;
  character: Character | null;
  /** The runner's resolved backend bundle (adapter itself is unused here). */
  resolved: Omit<ResolvedGenerationBackend, 'backend'>;
  /** Anchor the branch on THIS message id (walk its parent chain, inclusive)
      instead of the chat's head/active-child pointers. Generation targets
      always pass the id of the message being generated — one rule for send,
      regenerate, and continue alike, with no pointer-state dependence. */
  anchorMessageId?: number;
  /** quietGenerate's per-call maxTokens override. */
  maxResponseTokensOverride?: number;
  lastGenerationType?: string;
  /** Synthetic trailing messages appended at the end of the resolved history
      (impersonate instruction; quiet-gen seed + accumulated transcript). */
  trailingMessages?: Array<{ role: 'system' | 'user' | 'assistant'; parts: ContentPart[] }>;
}

export interface ChatPromptBuildResult {
  prompt: Prompt;
  chatHistory: Message[];
  promptHistoryLimit: number;
}

export class ChatPromptAssembly {
  constructor(private deps: ChatPromptAssemblyDeps) {}

  private async loadWorldInfoEntries(
    character: Character | null,
  ): Promise<import('@tamari/types').WorldInfoEntry[] | undefined> {
    const bookId = character?.worldInfoId;
    if (!bookId) return undefined;

    const book = await this.deps.worldInfo.getById(bookId);
    return book?.entries;
  }

  private extractRegexRules(settings: Record<string, unknown>, character?: Character | null): RegexRule[] {
    // Character-scoped rules (extensions.regexScripts) apply after global ones.
    return mergeRegexRules(getGlobalRegexRules(settings), character);
  }

  private resolveStopStrings(
    presetStopStrings: string[] | undefined,
    customStopStringsRaw: unknown,
    resolveMacros: boolean,
    macroCtx: {
      userName: string;
      charName: string;
      description?: string;
      personality?: string;
      scenario?: string;
      model?: string;
      maxContext?: number;
      maxResponse?: number;
    },
  ): string[] | undefined {
    const custom: string[] = [];
    if (Array.isArray(customStopStringsRaw)) {
      for (const item of customStopStringsRaw) {
        if (typeof item === 'string' && item) custom.push(item);
      }
    }
    const merged = [...(presetStopStrings ?? []), ...custom];
    if (merged.length === 0) return undefined;
    if (!resolveMacros) return merged;
    const resolver = MacroResolver.createPromptResolver();
    return merged.map((s) => resolver.resolve(s, macroCtx));
  }

  private async resolveAttachments(history: Message[]): Promise<Message[]> {
    const { attachments, storage } = this.deps;

    // Collect all unique attachment IDs across all messages
    const allIds = new Set<string>();
    for (const msg of history) {
      const rawAttachments = msg.extra.attachments;
      if (rawAttachments) {
        for (const att of rawAttachments) {
          if (att.id) allIds.add(att.id);
        }
      }
    }

    // Batch-fetch all attachments in one query
    const attachmentMap = new Map<string, Attachment>();
    if (allIds.size > 0) {
      const fetched = await attachments.getByIds(Array.from(allIds));
      for (const att of fetched) {
        attachmentMap.set(att.id, att);
      }
    }

    // Resolve inline without further DB queries
    return history.map((msg) => {
      const rawAttachments = msg.extra.attachments;
      if (!rawAttachments || rawAttachments.length === 0) {
        return msg;
      }
      const resolved = rawAttachments.map((att): MessageAttachment => {
        const attachment = attachmentMap.get(att.id);
        if (!attachment) return att;
        try {
          const buffer = storage.read(attachment.filePath);
          const base64 = buffer.toString('base64');
          return { ...att, dataUrl: `data:${attachment.mimeType};base64,${base64}` };
        } catch (err) {
          logger.debug({ err, filePath: attachment.filePath }, 'Attachment base64 read failed');
          return att;
        }
      });
      return { ...msg, extra: { ...msg.extra, attachments: resolved } };
    });
  }

  private extractCustomInstructTemplates(
    settings: Record<string, unknown>,
  ): Record<string, InstructTemplate> | undefined {
    const raw = settings['instructTemplates'];
    if (!raw || !Array.isArray(raw)) return undefined;
    const result: Record<string, InstructTemplate> = {};
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const id = str((item as Record<string, unknown>)['id']);
      if (!id) continue;
      const t = item as Record<string, unknown>;
      result[id] = {
        name: str(t['name'], id),
        bos: t['bos'] !== undefined ? str(t['bos']) : undefined,
        eos: t['eos'] !== undefined ? str(t['eos']) : undefined,
        separator: t['separator'] !== undefined ? str(t['separator']) : undefined,
        systemPrefix: t['systemPrefix'] !== undefined ? str(t['systemPrefix']) : undefined,
        systemSuffix: t['systemSuffix'] !== undefined ? str(t['systemSuffix']) : undefined,
        userPrefix: t['userPrefix'] !== undefined ? str(t['userPrefix']) : undefined,
        userSuffix: t['userSuffix'] !== undefined ? str(t['userSuffix']) : undefined,
        assistantPrefix: t['assistantPrefix'] !== undefined ? str(t['assistantPrefix']) : undefined,
        assistantSuffix: t['assistantSuffix'] !== undefined ? str(t['assistantSuffix']) : undefined,
        responsePrefix: t['responsePrefix'] !== undefined ? str(t['responsePrefix']) : undefined,
      };
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  private extractAuthorsNote(metadata?: Record<string, unknown> | null): AuthorsNoteConfig | null {
    if (!metadata) return null;
    const an = metadata['authorsNote'];
    if (!an || typeof an !== 'object') return null;
    const obj = an as Record<string, unknown>;
    const content = str(obj['content']);
    if (!content.trim()) return null;
    return {
      content,
      position: ['before_prompt', 'after_prompt', 'in_chat'].includes(String(obj['position']))
        ? (String(obj['position']) as 'before_prompt' | 'after_prompt' | 'in_chat')
        : 'in_chat',
      depth: Number(obj['depth'] ?? 4),
      role: ['system', 'user', 'assistant'].includes(String(obj['role']))
        ? (String(obj['role']) as 'system' | 'user' | 'assistant')
        : 'system',
      interval: Number(obj['interval'] ?? 1),
    };
  }

  /**
   * Update rolling memory summary, degrading gracefully on failure. Memory is
   * augmentation, not a hard dependency, so a summarization error (no backend
   * configured, backend 5xx, timeout) must never abort the user-facing
   * generation — log and proceed without a summary.
   */
  private async getMemorySummary(chatId: string) {
    if (!this.deps.memoryService) return null;
    try {
      return await this.deps.memoryService.ensureSummaryUpdated(chatId);
    } catch (err) {
      log.warn({ err, chatId }, 'memory summary update failed; proceeding without memory');
      return null;
    }
  }

  /**
   * Assemble the LLM prompt: history → attachments → memory → world info/RAG →
   * macros → stop strings → tool definitions → promptBuilder.build.
   */
  async build(args: ChatPromptBuildArgs): Promise<ChatPromptBuildResult> {
    const { chats, promptBuilder, personas } = this.deps;
    const { chatId, chat, character } = args;
    const { allSettings, backendConfig, promptList, backendSettings } = args.resolved;

    const persona = chat?.personaId ? await personas.getById(chat.personaId) : null;
    const authorsNote = this.extractAuthorsNote(chat?.metadata);

    let promptHistoryLimit = backendConfig?.promptHistoryLimit ?? allSettings.promptHistoryLimit;
    const chatTruncation = allSettings.chatTruncation;
    if (chatTruncation > 0 && promptHistoryLimit > chatTruncation) {
      promptHistoryLimit = chatTruncation;
    }
    const contextLength = backendConfig?.contextLength ?? allSettings.contextLength ?? 4096;
    const maxResponseTokens = args.maxResponseTokensOverride !== undefined
      ? Math.max(1, Math.floor(args.maxResponseTokensOverride))
      : Math.max(1, backendConfig?.maxTokens ?? allSettings.maxResponseTokens);
    const historySource = args.anchorMessageId !== undefined
      ? await chats.getBulkOfMessages(chatId, { limit: promptHistoryLimit, beforeId: args.anchorMessageId })
      : await chats.getActiveBranch(chatId, { limit: promptHistoryLimit });
    const chatHistory = await this.resolveAttachments(historySource);

    if (args.trailingMessages?.length) {
      // Append synthetic trailing messages (impersonation instruction, quiet
      // seed, accumulated transcript) after the resolved history. Macro vars
      // chain from the preceding message, exactly like a real append.
      const now = Math.floor(Date.now() / 1000);
      for (const tm of args.trailingMessages) {
        chatHistory.push({
          id: 0,
          parentId: chat?.activeChildId ?? chat?.headMessageId ?? null,
          role: tm.role,
          extra: {
            parts: tm.parts,
            macroVars: (chatHistory[chatHistory.length - 1]?.extra.macroVars) ?? {},
          },
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // Update rolling memory summary before building prompt.
    const memorySummary = await this.getMemorySummary(chatId);

    // Load the current variable snapshot from the last message in the history
    const lastHistoryMsg = chatHistory[chatHistory.length - 1];
    const macroVars = lastHistoryMsg?.extra.macroVars ?? {};

    // Load world info and semantic matches
    const worldInfoEntries = await this.loadWorldInfoEntries(character);
    let semanticMatches = new Set<string>();
    if (worldInfoEntries && this.deps.ragService) {
      const bookId = character?.worldInfoId;
      if (bookId) {
        try {
          await this.deps.ragService.indexWorldInfoEntries(bookId, worldInfoEntries);
          const scanText = chatHistory.map((m) => `${m.role}: ${getMessageText(m.extra.parts)}`).join('\n');
          const matchedIds = await this.deps.ragService.queryWorldInfo(bookId, scanText);
          semanticMatches = new Set(matchedIds);
        } catch (err) {
          log.error({ err }, 'RAG WI query failed');
        }
      }
    }

    const customTemplates = this.extractCustomInstructTemplates(allSettings);
    const regexRules = this.extractRegexRules(allSettings, character);
    // Append-only: reasoning always re-sent verbatim (the provider's snapshot
    // includes it); stop strings stay literal (macros are off wholesale).
    const appendOnly = allSettings.appendOnlyPromptLayout;
    const reasoningAddToPrompts = allSettings.reasoningAddToPrompts || appendOnly;

    const macroCtx = {
      userName: persona?.name || allSettings.userName || 'User',
      charName: character?.name ?? 'Character',
      description: character?.description,
      personality: character?.personality,
      scenario: character?.scenario,
      model: str(backendSettings['model']),
      maxContext: contextLength,
      maxResponse: maxResponseTokens,
    };
    const stopStrings = this.resolveStopStrings(
      backendConfig?.stopStrings,
      allSettings.customStoppingStrings,
      allSettings.customStoppingStringsMacro && !appendOnly,
      macroCtx,
    );

    let toolDefinitions: import('../backends/BackendAdapter.js').ToolDefinition[] | undefined;
    if (this.deps.toolRegistry && this.deps.toolsetRepo) {
      const enabledToolsets = await this.deps.toolsetRepo.listEnabled();
      if (enabledToolsets.length > 0) {
        toolDefinitions = await this.deps.toolRegistry.getDefinitionsByToolsets(enabledToolsets);
      }
    }

    // Build character asset map for img macro
    let characterAssetMap: Record<string, string> | undefined;
    if (character) {
      const assetList = await this.deps.characterAssets.listForCharacter(character.id);
      characterAssetMap = {};
      for (const asset of assetList) {
        if (asset.name) {
          characterAssetMap[asset.name] = `/api/characters/${character.id}/assets/${asset.id}.${asset.ext}`;
        }
      }
    }

    const globalVars = allSettings.globalVars;
    const extensions = Array.isArray(allSettings['extensions']) ? allSettings['extensions'] as string[] : undefined;

    const prompt = await promptBuilder.build({
      chatHistory,
      character,
      personaDescription: persona?.description ?? undefined,
      maxContext: contextLength,
      maxResponseTokens,
      userName: macroCtx.userName,
      model: macroCtx.model,
      mode: backendConfig?.generationMode ?? allSettings.generationMode,
      instructTemplate: backendConfig?.instructTemplate ?? String(allSettings['instructTemplate']),
      customInstructTemplates: customTemplates,
      stopStrings,
      regexRules,
      reasoningAddToPrompts,
      toolDefinitions,
      memorySummary,
      worldInfo: {
        entries: worldInfoEntries,
        semanticMatches,
      },
      prompts: {
        systemPromptOverride: character?.systemPrompt || undefined,
        jailbreakOverride: character?.postHistoryInstructions || undefined,
        presetPrompts: promptList?.prompts,
        presetPromptOrder: promptList?.promptOrder,
        authorsNote,
        stripExamples: allSettings.stripExamples,
      },
      macro: {
        vars: macroVars,
        globalVars,
        characterAssets: characterAssetMap,
        extensions,
        lastGenerationType: args.lastGenerationType,
      },
      media: {
        supportsImages: backendConfig?.supportsImages ?? true,
        supportsAudio: backendConfig?.supportsAudio ?? true,
        supportsVideo: backendConfig?.supportsVideo ?? true,
        verboseMode: allSettings.mediaVerboseMode,
      },
      caching: {
        mode: allSettings.claudeCacheMode,
        manualDepth: allSettings.claudeCacheDepth,
        appendOnly: allSettings.appendOnlyPromptLayout,
      },
    });

    return { prompt, chatHistory, promptHistoryLimit };
  }
}
