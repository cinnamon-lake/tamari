/**
 * GenerationService — orchestrates the AI generation lifecycle.
 *
 * Target-message-first design:
 *   1. Create (or identify) the target assistant message before streaming.
 *   2. Broadcast generation.started with the target messageId so the client
 *      can patch content inline as tokens arrive.
 *   3. Stream tokens.
 *   4. Patch the target message with the final content.
 *
 * Critical rule: persist BEFORE broadcast.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { getLogger } from '../lib/logger.js';
import { str } from '../lib/coerce.js';

const log = getLogger('GenerationService');
import type { EventBus } from '../bus/EventBus.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { IGenerationRepository } from '../repos/GenerationRepository.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { IPromptListRepository } from '../repos/PromptListRepository.js';
import type { IChatMemberRepository } from '../repos/ChatMemberRepository.js';
import type { BackendAdapter, BackendStreamItem, Prompt, GenerationResult, ContentPart } from '../backends/BackendAdapter.js';
import type { PromptBuilder, AuthorsNoteConfig } from '../pipeline/PromptBuilder.js';
import type { InstructTemplate } from '../pipeline/renderers/InstructTemplate.js';

import { buildBackendSettings } from '../backends/buildBackendSettings.js';
import type { BackendAdapterFactory } from '../backends/factory.js';
import {
  createContextualBackendAdapter,
  getCharacterBackendScript,
} from '../backends/customBackendFactory.js';
import type { LuaRuntime } from '../scripting/LuaRuntime.js';
import type { ICustomBackendRepository } from '../repos/CustomBackendRepository.js';
import { extractReasoning } from './ReasoningEngine.js';
import type { RegexRule } from '@tamari/types';
import { mergeRegexRules, getGlobalRegexRules } from './characterRegex.js';
import type { GroupChatService } from './GroupChatService.js';
import { getMessageText } from '@tamari/types';
import type { Message, Character, Chat, Attachment, AttachmentRef, BackendConfig, PromptList, SettingsMap, MessageExtra, MessageAttachment } from '@tamari/types';
import type { ToolRegistry } from './ToolRegistry.js';
import type { IToolsetRepository } from '../repos/ToolsetRepository.js';
import type { IAttachmentRepository } from '../repos/AttachmentRepository.js';
import type { IWorldInfoRepository } from '../repos/WorldInfoRepository.js';
import type { ICharacterAssetRepository } from '../repos/CharacterAssetRepository.js';
import { tokenCounterProvider } from '../tokenizers/TokenCounter.js';
import { MacroResolver } from '../pipeline/MacroResolver.js';

import { FileStorage } from './FileStorage.js';
import { getChatSnapshotMessages } from '../lib/swipeInfo.js';
import type { RAGService } from './RAGService.js';
import type { MemoryService } from './MemoryService.js';
import { findLatestStateSnapshot } from './toolState.js';



function applyInputWhitespace(content: string, mode: string): string {
  if (mode === 'none') return content;
  let result = content.trim();
  if (mode === 'full') {
    result = result.replace(/\s+/g, (match) => (match.includes('\n') ? '\n\n' : ' '));
  }
  return result;
}

function applyOutputWhitespace(content: string, mode: string): string {
  if (mode !== 'full') return content;
  return content.replace(/\s+/g, (match) => (match.includes('\n') ? '\n\n' : ' '));
}

export interface GenerationLifecycleCallbacks {
  onBeforeGeneration?(chatId: string, clientId: string | undefined): Promise<void> | void;
  onAfterGeneration?(chatId: string, clientId: string | undefined): Promise<void> | void;
}

export interface GenerationServiceDeps {
  bus: EventBus;
  chats: IChatRepository;
  generations: IGenerationRepository;
  characters: ICharacterRepository;
  settings: ISettingsRepository;
  personas: IPersonaRepository;
  backendConfigs: IBackendConfigRepository;
  promptLists: IPromptListRepository;
  chatMembers: IChatMemberRepository;
  attachments: IAttachmentRepository;
  storage: FileStorage;
  groupChatService: GroupChatService;
  promptBuilder: PromptBuilder;
  backendFactory: BackendAdapterFactory;
  luaRuntime: LuaRuntime;
  customBackends: ICustomBackendRepository;
  worldInfo: IWorldInfoRepository;
  characterAssets: ICharacterAssetRepository;
  ragService?: RAGService;
  toolRegistry?: ToolRegistry;
  toolsetRepo?: IToolsetRepository;
  memoryService?: MemoryService;
  /** Tool-call rounds per generation turn (default 100; see config.ts). */
  maxToolRounds?: number;
  chatBroadcast: import('./ChatBroadcastService.js').ChatBroadcastService;
  generationBroadcast: import('./GenerationBroadcastService.js').GenerationBroadcastService;
}

export interface ActiveGeneration {
  generationId: string;
  chatId: string;
  targetMessageId: number;
  abortController: AbortController;
  streamingText: string;
  streamingReasoning: string;
  streamingReasoningSignature: string;
  streamingParts: ContentPart[];
}

/**
 * Non-reentrant async mutex. `lock()` queues waiters FIFO; `unlock()` hands off
 * to the next waiter WITHOUT clearing `locked`, so a concurrent `tryLock()`
 * can't steal the lock in the gap before the waiter resumes. `lock()` races a
 * 30s timeout so a wedged holder can't hang queued waiters indefinitely (a
 * stop-gap until `lock()` accepts an AbortSignal wired from handleStop).
 */
class AsyncMutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async lock(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Chat lock acquisition timeout')),
        30_000,
      );
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Ownership was transferred by the prior unlock(); `locked` is already true.
  }

  tryLock(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  /**
   * Release. Returns false if the mutex was not held (an unbalanced release —
   * the bug class that used to leak the per-chat lock). `unlock()` in a
   * `finally` must not throw, so callers warn on the false return rather than
   * this method throwing.
   */
  unlock(): boolean {
    if (!this.locked) return false;
    const next = this.waiters.shift();
    if (next) next(); // hand off; `locked` stays true (no race window)
    else this.locked = false;
    return true;
  }
}

export class GenerationService {
  private active = new Map<string, ActiveGeneration>(); // generationId -> ActiveGeneration
  private chatMutexes = new Map<string, AsyncMutex>(); // chatId -> mutex
  private lifecycleCallbacks?: GenerationLifecycleCallbacks;

  constructor(private deps: GenerationServiceDeps) {}

  setLifecycleCallbacks(callbacks: GenerationLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  /** Get (or lazily create) the mutex for a chat. */
  /** Transient injections for the next generation (from /inject or Lua st.inject), keyed by chatId.
   * One-shot per chat: a chat's entries are cleared after its first prompt build. */
  private pendingInjections = new Map<string, string[]>(); // chatId -> injections

  /** Set a pending injection (Lua st.inject). Accumulates if called multiple times. */
  setPendingInjection(chatId: string, text: string): void {
    const list = this.pendingInjections.get(chatId) ?? [];
    list.push(text);
    this.pendingInjections.set(chatId, list);
  }

  /** Clear pending injections (Lua st.flush_inject). */
  clearPendingInjections(chatId: string): void {
    this.pendingInjections.delete(chatId);
  }

  private mutexFor(chatId: string): AsyncMutex {
    let m = this.chatMutexes.get(chatId);
    if (!m) {
      m = new AsyncMutex();
      this.chatMutexes.set(chatId, m);
    }
    return m;
  }

  /** Non-blocking acquire for the script gate (fail-fast). Public for ScriptContext. */
  tryLockChat(chatId: string): boolean {
    return this.mutexFor(chatId).tryLock();
  }

  /** Release. Warns if the chat wasn't locked (an unbalanced release). */
  unlockChat(chatId: string): void {
    if (!this.mutexFor(chatId).unlock()) {
      log.warn({ chatId }, 'unlockChat: mutex not held — unbalanced release');
    }
  }

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
   * Auto-fix common markdown formatting errors in model output.
   */
  private autoFixMarkdown(text: string): string {
    // Close unclosed inline code spans (odd number of backticks on a line)
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const backtickCount = (lines[i]!.match(/`/g) || []).length;
      if (backtickCount % 2 === 1) {
        lines[i] += '`';
      }
    }
    let fixed = lines.join('\n');

    // Ensure code blocks are closed
    const codeBlockMatches = (fixed.match(/```/g) || []).length;
    if (codeBlockMatches % 2 === 1) {
      fixed += '\n```';
    }

    // Balance asterisks for bold/italic (very naive: if odd count, append one)
    const asteriskCount = (fixed.match(/\*/g) || []).length;
    if (asteriskCount % 2 === 1) {
      fixed += '*';
    }

    return fixed;
  }

  /**
   * Handle a user sending a message in a chat.
   */
  async handleSend(chatId: string, content: string, attachmentRefs?: AttachmentRef[], lockHolder?: string): Promise<void> {
    const { chats, personas, attachments } = this.deps;

    const held = lockHolder !== undefined;
    if (!held) await this.mutexFor(chatId).lock();

    try {
    const chat = await chats.getChatById(chatId);
    // Resolve persona name and description from chat
    const persona = chat?.personaId ? await personas.getById(chat.personaId) : null;
    const character = chat?.characterId ? await this.deps.characters.getById(chat.characterId) : null;

    // Build extra metadata
    const extra: MessageExtra = {};
    if (persona) {
      extra.personaId = persona.id;
    }
    if (attachmentRefs && attachmentRefs.length > 0) {
      extra.attachments = attachmentRefs;
    }

    const appSettings = await this.deps.settings.getTyped();
    let processedContent = content;

    // Apply whitespace trimming to user messages
    processedContent = applyInputWhitespace(processedContent, appSettings.whitespaceMode);

    // Resolve model for accurate token counting
    const backendConfig = appSettings.activeBackendConfigId
      ? await this.deps.backendConfigs.getById(appSettings.activeBackendConfigId)
      : null;
    const model = backendConfig?.model ?? appSettings.model;

    // Resolve storage macros before saving
    const lastMessageId = chat?.activeChildId ?? chat?.headMessageId;
    const lastMessage = lastMessageId ? await chats.getMessageById(lastMessageId) : null;
    const previousVars = lastMessage?.extra.macroVars ?? {};
    const { messages } = await getChatSnapshotMessages(chats, chatId, 100);
    const storageResolver = MacroResolver.createStorageResolver();
    const userName = persona?.name || appSettings.userName || 'User';
    const macroCtx = {
      userName,
      charName: character?.name ?? 'Character',
      description: character?.description,
      personality: character?.personality,
      scenario: character?.scenario,
      persona: persona?.description,
      model,
      now: new Date(),
      messages: messages.map((m) => ({ id: m.id, role: m.role, content: getMessageText(m.extra.parts) })),
      macroVars: { ...previousVars },
    };
    processedContent = storageResolver.resolve(processedContent, macroCtx);
    const newVars = { ...macroCtx.macroVars };
    extra.macroVars = { ...previousVars, ...newVars };

    // Count tokens for the user message
    extra.tokenCount = tokenCounterProvider.provideTokenCounter(model).count(processedContent);

    // 1. Append user message
    extra.parts = [{ type: 'text', text: processedContent }];
    const userMsg = await chats.appendMessage(chatId, {
      role: 'user',
      extra,
    });

    // Link uploaded attachments to this message
    if (attachmentRefs && attachmentRefs.length > 0) {
      for (const ref of attachmentRefs) {
        try {
          await attachments.linkToMessage(ref.id, userMsg.id);
        } catch (err) {
          log.debug({ err, attachmentId: ref.id, messageId: userMsg.id }, 'attachment link failed');
        }
      }
    }

    if (userMsg.id) {
      await this.deps.chatBroadcast.broadcastMessageAppended(chatId, userMsg.id);
    }
    const updatedChat = await chats.getChatById(chatId);
    if (updatedChat) {
      await this.deps.chatBroadcast.broadcastSnapshot(chatId, 10000);
    }
    } finally {
      if (!held) this.unlockChat(chatId);
    }
  }

  /**
   * Execute any tool_use parts in a message that lack a matching tool_result.
   * Used when continuing a message from an aborted generation.
   */
  private async executePendingTools(
    message: Message,
    chatId: string,
    chatHistory: Message[],
  ): Promise<void> {
    if (!this.deps.toolRegistry) return;
    const parts = message.extra.parts ?? [];
    const toolUses = parts.filter(
      (p): p is import('../backends/BackendAdapter.js').ToolUsePart => p.type === 'tool_use',
    );
    if (toolUses.length === 0) return;

    const pending = toolUses.filter((tu) => {
      const hasResult = parts.some(
        (p) => p.type === 'tool_result' && (p).toolUseId === tu.id,
      );
      return !hasResult;
    });
    if (pending.length === 0) return;

    const toolResultParts: ContentPart[] = [];
    for (const call of pending) {
      const toolResult = await this.deps.toolRegistry.execute(
        { id: call.id, name: call.name, arguments: call.input },
        {
          chatId,
          messages: chatHistory.map((m) => ({
            id: String(m.id),
            role: m.role,
            content: getMessageText(m.extra.parts),
            extra: m.extra,
          })),
        },
      );
      toolResultParts.push({
        type: 'tool_result',
        toolUseId: call.id,
        name: call.name,
        content: toolResult.content,
        isError: toolResult.isError,
        extra: toolResult.extra,
      });
    }

    const newParts = [...parts, ...toolResultParts];
    const newExtra = { ...message.extra, parts: newParts };
    await this.deps.chats.updateMessage(message.id, { extra: newExtra });
    await this.deps.chatBroadcast.broadcastMessageSnapshot(chatId, message.id);
  }

  /**
   * Trigger generation for a chat. Creates a new assistant message and streams the response.
   * Works regardless of whether the current head is a user or assistant message.
   */
  async handleGenerate(chatId: string, lockHolder?: string, clientId?: string, injections?: string[]): Promise<void> {
    // Merge client-supplied injections with any pending Lua st.inject entries.
    // The client always sends an array (possibly empty), so replacing or
    // deleting here would wipe server-side st.inject state on every UI send —
    // st.flush_inject (clearPendingInjections) is the only clearing path.
    if (injections?.length) {
      this.pendingInjections.set(chatId, [...(this.pendingInjections.get(chatId) ?? []), ...injections]);
    }
    const { bus, chats, groupChatService } = this.deps;

    const chat = await chats.getChatById(chatId);
    if (!chat) {
      if (clientId) bus.sendTo(clientId, { type: 'error', message: 'Chat not found', code: 'NOT_FOUND' });
      return;
    }

    const lastMessageId = chat.activeChildId ?? chat.headMessageId;

    if (chat.characterId === null) {
      // Group chat: determine activated members and generate for each.
      // isUserInitiated=true so LIST round-robin advances to the next member
      // instead of always returning the first.
      const activatedMembers = await groupChatService.getActivatedMembers(chatId, true);
      if (activatedMembers.length === 0) {
        if (clientId)
          bus.sendTo(clientId, { type: 'error', message: 'No group members activated', code: 'NO_MEMBERS' });
        return;
      }

      // Hold ONE lock tenure for the whole member sequence (mirroring
      // triggerGroupResponses): per-member acquire/release would let a racing
      // message interleave between member generations. Lifecycle callbacks
      // fire here — executeGeneration skips them for nested (held) calls.
      const held = lockHolder !== undefined;
      const effectiveHolder = lockHolder ?? `group:${chatId}:${Date.now()}`;
      if (!held) await this.lifecycleCallbacks?.onBeforeGeneration?.(chatId, clientId);
      if (!held) await this.mutexFor(chatId).lock();

      let completed = false;
      try {
        const characters = await this.deps.characters.getByIds(activatedMembers);
        const charMap = new Map(characters.map((c) => [c.id, c]));
        // Chain from the current leaf — re-read inside the tenure (the caller's
        // chat snapshot predates the lock).
        const fresh = await chats.getChatById(chatId);
        let lastParentId = (fresh?.activeChildId ?? fresh?.headMessageId) ?? lastMessageId;
        for (const characterId of activatedMembers) {
          const character = charMap.get(characterId);
          if (!character) continue;
          const msgId = await this.generateForCharacter(chatId, character, lastParentId, effectiveHolder);
          if (msgId > 0) lastParentId = msgId;
        }
        completed = true;
      } finally {
        if (!held) {
          this.unlockChat(chatId);
          if (completed) await this.lifecycleCallbacks?.onAfterGeneration?.(chatId, clientId);
        }
      }
      return;
    }

    // Single-character chat: create assistant child of current head and generate
    const character = chat.characterId ? await this.deps.characters.getById(chat.characterId) : null;
    await this.executeGeneration(chatId, character ?? null, undefined, undefined, lockHolder, clientId, 0, false, 'send');
  }

  /**
   * Generate a response for a specific character in a group chat.
   */
  private async generateForCharacter(chatId: string, character: Character, parentId?: number | null, lockHolder?: string): Promise<number> {
    return this.executeGeneration(chatId, character, parentId, undefined, lockHolder, undefined, 0, false, 'send');
  }

  /**
   * Trigger group responses for auto-mode (no user message appended).
   */
  async triggerGroupResponses(chatId: string): Promise<void> {
    const { chats, groupChatService } = this.deps;
    const chat = await chats.getChatById(chatId);
    if (!chat || chat.characterId !== null) return;

    const activatedMembers = await groupChatService.getActivatedMembers(chatId, false);
    if (activatedMembers.length === 0) return;

    // Chain members explicitly from the current last message
    const lastMessageId = chat.activeChildId ?? chat.headMessageId;
    let lastParentId = lastMessageId;
    if (!lastParentId) return;

    // Acquire a single lock for the entire auto-mode sequence so user generations
    // cannot interleave between members. `lockHolder` is a truthy token passed to
    // generateForCharacter so the nested executeGeneration skips its own acquire.
    const lockHolder = `auto:${chatId}:${Date.now()}`;
    await this.mutexFor(chatId).lock();

    try {
      const characters = await this.deps.characters.getByIds(activatedMembers);
      const charMap = new Map(characters.map((c) => [c.id, c]));
      for (const characterId of activatedMembers) {
        const character = charMap.get(characterId);
        if (!character) continue;
        const msgId = await this.generateForCharacter(chatId, character, lastParentId, lockHolder);
        if (msgId > 0) lastParentId = msgId;
      }
    } finally {
      this.unlockChat(chatId);
    }
  }

  /**
   * Shared prologue for every prompt-building entry point: load settings, the
   * active backend config + prompt list, and construct the backend adapter.
   * `backend` is null when no backend is configured — callers decide how to
   * report that (WS error vs. return value).
   */
  private async resolveGenerationBackend(character?: Character | null): Promise<{
    allSettings: SettingsMap;
    backendConfig: BackendConfig | null;
    promptList: PromptList | null;
    backendSettings: Record<string, unknown>;
    backend: BackendAdapter | null;
  }> {
    const { settings, backendConfigs, promptLists, backendFactory } = this.deps;
    const allSettings = await settings.list();
    const activeBackendConfigId = allSettings.activeBackendConfigId;
    const backendConfig = activeBackendConfigId ? await backendConfigs.getById(activeBackendConfigId) : null;
    const activePromptListId = allSettings.activePromptListId;
    const promptList = activePromptListId ? await promptLists.getById(activePromptListId) : null;
    const backendSettings = buildBackendSettings(allSettings, backendConfig);
    let backend = await backendFactory.create(backendSettings);

    // Card-coupled contextual backend (scriptable-layers.md §2, Type B): the
    // character's own backend logic wraps the active provider — the script owns
    // the prompt, the user's selected backend is its default delegate (writer
    // model). Skipped when the active config is itself a custom backend
    // (explicit Type A selection wins) or when the character has no enabled
    // backend logic. In group chats this applies per speaking character.
    const backendScript = getCharacterBackendScript(character);
    if (backend && backendScript && backendConfig?.backendProvider !== 'custom') {
      backend = createContextualBackendAdapter(
        {
          customBackends: this.deps.customBackends,
          backendConfigs: this.deps.backendConfigs,
          settings: this.deps.settings,
          luaRuntime: this.deps.luaRuntime,
          createResolvedAdapter: (s) => backendFactory.create(s),
        },
        {
          characterId: character!.id,
          characterName: character!.name,
          luaSource: backendScript.luaSource,
          activeAdapter: backend,
        },
      );
    }

    return {
      allSettings,
      backendConfig: backendConfig ?? null,
      promptList: promptList ?? null,
      backendSettings,
      backend,
    };
  }

  /**
   * Assemble the LLM prompt: history → attachments → memory → world info/RAG →
   * macros → stop strings → tool definitions → promptBuilder.build.
   *
   * The single prompt-assembly path used by executeGeneration (including its
   * tool-round follow-ups), handleImpersonate, and quietGenerate — previously
   * four copy-pasted blocks that had already drifted (the tool-round copy
   * silently dropped globalVars/extensions/characterAssets/injections).
   */
  private async buildGenerationPrompt(args: {
    chatId: string;
    chat: Chat | null;
    character: Character | null;
    allSettings: SettingsMap;
    backendConfig: BackendConfig | null;
    promptList: PromptList | null;
    backendSettings: Record<string, unknown>;
    /** Regenerate builds from the bulk message list (no active-child filter). */
    useBulkOnly?: boolean;
    /** quietGenerate's per-call maxTokens override. */
    maxResponseTokensOverride?: number;
    /** Impersonation instruction (handleImpersonate only). */
    impersonatePrompt?: string;
    lastGenerationType?: string;
    /** Synthetic user text appended to the resolved history (quietGenerate). */
    syntheticUserText?: string;
  }): Promise<{ prompt: Prompt; chatHistory: Message[]; promptHistoryLimit: number }> {
    const { chats, promptBuilder, personas } = this.deps;
    const { chatId, chat, character, allSettings, backendConfig, promptList, backendSettings } = args;

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
    const historySource = args.useBulkOnly
      ? await chats.getBulkOfMessages(chatId, { limit: promptHistoryLimit })
      : await chats.getActiveBranch(chatId, { limit: promptHistoryLimit });
    const chatHistory = await this.resolveAttachments(historySource);

    if (args.syntheticUserText !== undefined) {
      // Append a synthetic user message containing the custom prompt
      const now = Math.floor(Date.now() / 1000);
      chatHistory.push({
        id: 0,
        parentId: chat?.activeChildId ?? chat?.headMessageId ?? null,
        role: 'user',
        extra: {
          parts: [{ type: 'text', text: args.syntheticUserText }],
          macroVars: (chatHistory[chatHistory.length - 1]?.extra.macroVars) ?? {},
        },
        createdAt: now,
        updatedAt: now,
      });
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
    const reasoningAddToPrompts = allSettings.reasoningAddToPrompts;

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
      allSettings.customStoppingStringsMacro,
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
      impersonatePrompt: args.impersonatePrompt,
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
        injections: this.pendingInjections.get(chatId) ?? undefined,
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
      },
    });
    this.pendingInjections.delete(chatId);

    return { prompt, chatHistory, promptHistoryLimit };
  }

  /**
   * Execute a generation: create target message, build prompt, and stream.
   * Returns the ID of the target message.
   */
  private async executeGeneration(
    chatId: string,
    character: Character | null,
    parentId?: number | null,
    targetMessage?: Message | null,
    lockHolder?: string,
    clientId?: string,
    autoContinueDepth = 0,
    useBulkOnly = false,
    lastGenerationType?: string,
  ): Promise<number> {
    const { bus, chats } = this.deps;
    // effectiveHolder is a truthy token passed to handleContinue (auto-continue)
    // so the nested executeGeneration skips its own acquire. The lock itself is
    // taken only when this is the top-level entry (lockHolder undefined).
    const effectiveHolder = lockHolder ?? `gen:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    const held = lockHolder !== undefined;
    // Lifecycle callbacks run OUTSIDE the chat-mutex tenure: quick replies
    // acquire the chat lock fail-fast (tryLock), so firing them inside the
    // tenure made BEFORE_GENERATION/AI_MESSAGE triggers structurally unable
    // to run. Only top-level (non-held) generations fire them — nested
    // continues/auto-continues and group members don't re-fire.
    if (!held) await this.lifecycleCallbacks?.onBeforeGeneration?.(chatId, clientId);
    if (!held) await this.mutexFor(chatId).lock();

    let completed = false;
    try {
      // 1. Load chat metadata (Author's Note, persona) for the prompt build
      const chat = await chats.getChatById(chatId) ?? null;

      // 2. Load settings, active backend config, and resolve backend FIRST
      const { allSettings, backendConfig, promptList, backendSettings, backend } = await this.resolveGenerationBackend(character);
      if (!backend) {
        if (clientId)
          bus.sendTo(clientId, {
            type: 'error',
            message: 'No backend configured. Set API key and model in settings.',
            code: 'NO_BACKEND',
          });
        return 0;
      }
      // 3. Create empty target assistant message (unless one is already provided, e.g. continue)
      let targetMsg: Message;
      if (targetMessage) {
        targetMsg = targetMessage;
      } else {
        const parentMessage = parentId ? await chats.getMessageById(parentId) : null;
        // Single-chat sends pass no explicit parentId — inherit macro vars from
        // the chat's current leaf, which is what appendMessage links against
        // internally. Without this fallback the setvar → getvar chain breaks.
        const leafId = chat?.activeChildId ?? chat?.headMessageId ?? null;
        const varSource = parentMessage ?? (leafId !== null ? await chats.getMessageById(leafId) : null);
        const previousVars = varSource?.extra.macroVars ?? {};
        targetMsg = await chats.appendMessage(chatId, {
          role: 'assistant',
          // Vars chain under `macroVars` — the key every reader uses
          // (runGeneration's existingVars, next turn's macroCtx). Anything
          // else (e.g. `variables`) silently breaks cross-turn getvar.
          extra: character
            ? { characterId: character.id, macroVars: previousVars }
            : { macroVars: previousVars },
          parentId: parentId,
        });
        // Send the canonical snapshot (messages + swipes) so the client never has stale state.
        await this.deps.chatBroadcast.broadcastMessageAppended(chatId, targetMsg.id);
        await this.deps.chatBroadcast.broadcastSnapshot(chatId, 10000);
      }

      // 4. Build prompt
      const { prompt, chatHistory, promptHistoryLimit } = await this.buildGenerationPrompt({
        chatId,
        chat,
        character: character ?? null,
        allSettings,
        backendConfig,
        promptList,
        backendSettings,
        useBulkOnly,
        lastGenerationType,
      });

      // 4. Create generation record
      const generationId = randomUUID();
      await this.deps.generations.create(generationId, {
        chatId: chatId,
        messageId: targetMsg.id,
        status: 'pending',
        backend: backend.id,
        promptTokens: prompt.tokenUsage.prompt,
        completionTokens: null,
        errorMessage: null,
      });

      // 4b. If continuing a message with un-executed tool calls (e.g. aborted
      // generation), execute them now so the model sees the results.
      if (targetMessage && this.deps.toolRegistry) {
        await this.executePendingTools(targetMessage, chatId, chatHistory);
      }

      // 5. Run generation targeting the message
      const model = str(backendSettings['model']);
      let lastGenerationId = generationId;
      let result = await this.runGeneration(generationId, chatId, prompt, backend, targetMsg.id, character, model, true, lastGenerationType);

      // 5b. Handle tool calls: execute tools and run follow-up generations
      const currentTargetMsgId = targetMsg.id;
      let toolRound = 0;
      const maxToolRounds = this.deps.maxToolRounds ?? 100;

      while (
        result.toolCalls &&
        result.toolCalls.length > 0 &&
        this.deps.toolRegistry &&
        toolRound < maxToolRounds
      ) {
        const toolCalls = result.toolCalls;

        // A tool whose definition sets `endsTurn` ends the turn after it
        // executes successfully: its result is persisted and broadcast below,
        // but no follow-up generation round runs.
        let turnEnds = false;

        // Store tool calls and results as ordered parts in the assistant message
        const existingMsg = await chats.getMessageById(currentTargetMsgId);
        if (existingMsg) {
          // Tool-execution context comes from a fresh branch read: runGeneration
          // flushes tool_use parts at stream end and each round persists its
          // tool_result parts below, so the DB already holds every earlier
          // round's `_toolState` snapshot (e.g. map_create → map_set_tile
          // within one turn).
          const toolBranch = await chats.getActiveBranch(chatId, { limit: promptHistoryLimit });
          const toolContextMessages = toolBranch.map((m) => ({ id: String(m.id), role: m.role, content: getMessageText(m.extra.parts), extra: m.extra }));

          // Execute tools and build tool_result parts
          const toolResultParts: ContentPart[] = [];
          for (const call of toolCalls) {
            const toolResult = await this.deps.toolRegistry.execute(call, {
              chatId,
              clientId,
              messages: toolContextMessages,
            });
            if (toolResult.endsTurn === true) turnEnds = true;
            toolResultParts.push({
              type: 'tool_result',
              toolUseId: call.id,
              name: call.name,
              content: toolResult.content,
              isError: toolResult.isError,
              extra: toolResult.extra,
            });
          }

          // Build or extend the ordered parts array
          let parts: ContentPart[];
          if (existingMsg.extra.parts && existingMsg.extra.parts.length > 0) {
            parts = [...existingMsg.extra.parts];
          } else {
            parts = [];
            for (const tc of existingMsg.extra.toolCalls ?? []) {
              parts.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
            }
            const existingText = getMessageText(existingMsg.extra.parts);
            if (existingText) {
              parts.push({ type: 'text', text: existingText });
            }
          }
          parts.push(...toolResultParts);

          const newExtra = { ...existingMsg.extra, parts, toolCalls };
          await chats.updateMessage(currentTargetMsgId, { extra: newExtra });
          await this.deps.chatBroadcast.broadcastMessageSnapshot(chatId, currentTargetMsgId);
        }

        // Persisted + broadcast above, so the tool result (e.g. a choices
        // widget) renders immediately; the normal post-loop finalization
        // (generation.done, lifecycle callbacks) still runs.
        if (turnEnds) break;

        // Rebuild prompt with tool results in the history. Same unified
        // assembly path as the first round (re-reads the branch, refreshes
        // WI/RAG matches and macro vars) — the previous copy here had drifted
        // and silently dropped globalVars/extensions/characterAssets/injections.
        const { prompt: followUpPrompt } = await this.buildGenerationPrompt({
          chatId,
          chat,
          character,
          allSettings,
          backendConfig,
          promptList,
          backendSettings,
          lastGenerationType,
        });

        // Create a new generation record for the follow-up
        const followUpGenerationId = randomUUID();
        await this.deps.generations.create(followUpGenerationId, {
          chatId,
          messageId: currentTargetMsgId,
          status: 'pending',
          backend: backend.id,
          promptTokens: followUpPrompt.tokenUsage.prompt,
          completionTokens: null,
          errorMessage: null,
        });

        result = await this.runGeneration(
          followUpGenerationId,
          chatId,
          followUpPrompt,
          backend,
          currentTargetMsgId,
          character,
          model,
          true,
          lastGenerationType,
        );
        lastGenerationId = followUpGenerationId;

        toolRound++;
      }

      // 6. Auto-continue if the last message is shorter than the target length
      const maxAutoContinueDepth = 3;
      if (autoContinueDepth < maxAutoContinueDepth && allSettings.autoContinueEnabled) {
        const updated = await chats.getMessageById(currentTargetMsgId);
        const targetLength = allSettings.autoContinueTargetLength;
        const tokenCount = updated?.extra.tokenCount ?? 0;
        if (tokenCount > 0 && tokenCount < targetLength) {
          await this.handleContinue(chatId, effectiveHolder, clientId, autoContinueDepth + 1);
        }
      }

      this.deps.generationBroadcast.broadcastGenerationDone(chatId, lastGenerationId, result.finishReason);

      completed = true;
      return currentTargetMsgId;
    } finally {
      if (!held) {
        this.unlockChat(chatId);
        // AI_MESSAGE quick replies run after release so they can acquire the
        // chat lock (they fail-fast tryLock; inside the tenure they could
        // never run). Only on successful completion — errors/aborts don't
        // produce an "AI message".
        if (completed) await this.lifecycleCallbacks?.onAfterGeneration?.(chatId, clientId);
      }
    }
  }

  /**
   * Handle continue — append generated text to the last assistant message.
   */
  async handleContinue(chatId: string, lockHolder?: string, clientId?: string, autoContinueDepth = 0): Promise<void> {
    const { bus, chats } = this.deps;

    const chat = await chats.getChatById(chatId);
    if (!chat?.activeChildId) {
      if (clientId) bus.sendTo(clientId, { type: 'error', message: 'No message to continue', code: 'NOT_FOUND' });
      return;
    }
    const lastMessage = await chats.getMessageById(chat.activeChildId);
    if (!lastMessage || lastMessage.role !== 'assistant') {
      if (clientId)
        bus.sendTo(clientId, { type: 'error', message: 'No assistant message to continue', code: 'NOT_FOUND' });
      return;
    }

    // Resolve character from message or chat
    let character = chat.characterId ? await this.deps.characters.getById(chat.characterId) : null;
    if (!character && lastMessage.extra.characterId) {
      character = await this.deps.characters.getById(str(lastMessage.extra.characterId));
    }

    // For continue, the target message already exists
    await this.executeGeneration(
      chatId,
      character ?? null,
      lastMessage.parentId,
      lastMessage,
      lockHolder,
      clientId,
      autoContinueDepth,
      false,
      'continue',
    );
  }

  /**
   * Handle impersonate — generate a user message and send it to the client as a draft.
   */
  async handleImpersonate(chatId: string, lockHolder?: string, clientId?: string): Promise<void> {
    const { bus, chats } = this.deps;

    const held = lockHolder !== undefined;
    if (!held) await this.mutexFor(chatId).lock();

    try {
      const chat = await chats.getChatById(chatId);
      if (!chat) {
        if (clientId) bus.sendTo(clientId, { type: 'error', message: 'Chat not found', code: 'NOT_FOUND' });
        return;
      }
      if (!chat.activeChildId) {
        if (clientId) bus.sendTo(clientId, { type: 'error', message: 'No message to impersonate', code: 'NOT_FOUND' });
        return;
      }

      // Resolve character
      let character = chat.characterId ? await this.deps.characters.getById(chat.characterId) : null;
      if (!character && chat.characterId === null) {
        // Group chat: use first active member or last speaker
        const lastMsg = await chats.getMessageById(chat.activeChildId);
        if (lastMsg?.extra.characterId) {
          character = await this.deps.characters.getById(str(lastMsg.extra.characterId));
        }
      }

      // Load settings, backend config, and prompt list
      const { allSettings, backendConfig, promptList, backendSettings, backend } = await this.resolveGenerationBackend(character);
      if (!backend) {
        bus.broadcast({
          type: 'error',
          message: 'No backend configured. Set API key and model in settings.',
          code: 'NO_BACKEND',
        });
        return;
      }

      const impersonatePrompt =
        allSettings.impersonationPrompt ||
        "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]";

      // Build prompt with impersonation instruction
      const { prompt } = await this.buildGenerationPrompt({
        chatId,
        chat,
        character: character ?? null,
        allSettings,
        backendConfig,
        promptList,
        backendSettings,
        impersonatePrompt,
        lastGenerationType: 'impersonate',
      });

      const generationId = randomUUID();
      await this.deps.generations.create(generationId, {
        chatId: chatId,
        messageId: null,
        status: 'pending',
        backend: backend.id,
        promptTokens: prompt.tokenUsage.prompt,
        completionTokens: null,
        errorMessage: null,
      });

      await this.runQuietGeneration(generationId, chatId, prompt, backend, 'impersonate');
    } finally {
      if (!held) this.unlockChat(chatId);
    }
  }

  /**
   * Run a quiet generation from a custom prompt and return the generated text.
   * Used by server-side Lua scripts (st.generate).
   */
  async quietGenerate(
    chatId: string,
    promptText: string,
    opts: { maxTokens?: number; temperature?: number } | null = {},
    lockHolder?: string,
  ): Promise<{ text: string; finishReason: string } | { error: string }> {
    const { chats } = this.deps;

    const held = lockHolder !== undefined;
    if (!held) await this.mutexFor(chatId).lock();

    try {
      const chat = await chats.getChatById(chatId);
      if (!chat) {
        return { error: 'Chat not found' };
      }

      // Resolve character
      let character = chat.characterId ? await this.deps.characters.getById(chat.characterId) : null;
      if (!character && chat.characterId === null) {
        const lastMsg = chat.activeChildId ? await chats.getMessageById(chat.activeChildId) : null;
        if (lastMsg?.extra.characterId) {
          character = await this.deps.characters.getById(str(lastMsg.extra.characterId));
        }
      }

      // Load settings and backend
      const { allSettings, backendConfig, promptList, backendSettings, backend } = await this.resolveGenerationBackend(character);
      if (!backend) {
        return { error: 'No backend configured. Set API key and model in settings.' };
      }

      const temperature = opts?.temperature !== undefined ? Number(opts.temperature) : undefined;
      if (temperature !== undefined && !isNaN(temperature) && backendConfig) {
        backendSettings['temperature'] = temperature;
      }

      const { prompt } = await this.buildGenerationPrompt({
        chatId,
        chat,
        character: character ?? null,
        allSettings,
        backendConfig,
        promptList,
        backendSettings,
        maxResponseTokensOverride: opts?.maxTokens ? opts.maxTokens : undefined,
        syntheticUserText: promptText,
        lastGenerationType: 'quiet',
      });

      const generationId = randomUUID();
      await this.deps.generations.create(generationId, {
        chatId: chatId,
        messageId: null,
        status: 'pending',
        backend: backend.id,
        promptTokens: prompt.tokenUsage.prompt,
        completionTokens: null,
        errorMessage: null,
      });

      const quietResult = await this.runQuietGeneration(generationId, chatId, prompt, backend, 'quiet');
      if ('error' in quietResult) {
        return { error: quietResult.error };
      }
      return { text: quietResult.text, finishReason: quietResult.finishReason };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'quiet generation failed');
      return { error: message };
    } finally {
      if (!held) this.unlockChat(chatId);
    }
  }

  /**
   * Handle regeneration (create a swipe / sibling message).
   */
  async handleRegenerate(chatId: string, messageId?: number, lockHolder?: string, clientId?: string): Promise<void> {
    const { bus, chats } = this.deps;

    const chat = await chats.getChatById(chatId);
    let targetMessage: Message | undefined;
    if (messageId !== undefined) {
      targetMessage = await chats.getMessageById(messageId);
    } else {
      const lastMsgId = chat?.activeChildId ?? chat?.headMessageId;
      targetMessage = lastMsgId ? await chats.getMessageById(lastMsgId) : undefined;
    }

    if (!targetMessage) {
      if (clientId) bus.sendTo(clientId, { type: 'error', message: 'No message to regenerate', code: 'NOT_FOUND' });
      return;
    }

    const parentId = targetMessage.parentId;
    let character = chat?.characterId ? await this.deps.characters.getById(chat.characterId) : null;
    if (!character && targetMessage.extra.characterId) {
      character = await this.deps.characters.getById(str(targetMessage.extra.characterId));
    }

    // For regenerate, create a sibling message with the same parent.
    // Prompt uses bulk only (no active child) because we're producing an alternative.
    await this.executeGeneration(chatId, character ?? null, parentId, undefined, lockHolder, clientId, 0, true, 'regenerate');
  }

  /**
   * Stop an active generation.
   */
  async handleStop(generationId: string): Promise<string | undefined> {
    const active = this.active.get(generationId);
    if (active) {
      active.abortController.abort();
      return active.chatId;
    }
    return undefined;
  }

  /**
   * Shared streaming pipeline. Patches the target message when complete.
   */
  private async runGeneration(
    generationId: string,
    chatId: string,
    prompt: Prompt,
    backend: BackendAdapter,
    targetMessageId: number,
    character?: Character | null,
    model?: string,
    suppressDone?: boolean,
    generationType?: string,
  ): Promise<GenerationResult> {
    const { chats, generations } = this.deps;

    const abortController = new AbortController();

    // Fetch existing message so we can pre-load any already-accumulated parts
    // (needed for continue and for follow-up tool-call rounds targeting the same message)
    const existingMessage = await chats.getMessageById(targetMessageId);
    if (!existingMessage) {
      throw new Error('Target message not found');
    }

    // Pre-fetch settings and chat history for macro resolution
    const allSettings = await this.deps.settings.list();
    const chat = await chats.getChatById(chatId);
    const persona = chat?.personaId ? await this.deps.personas.getById(chat.personaId) : undefined;
    const userName = persona?.name || allSettings.userName || 'User';
    const { messages: historyMessages } = await getChatSnapshotMessages(chats, chatId, 100);
    const existingVars = existingMessage.extra.macroVars ?? {};

    const buildMacroCtx = (vars: Record<string, string>) => ({
      userName,
      charName: character?.name ?? 'Character',
      description: character?.description,
      personality: character?.personality,
      scenario: character?.scenario,
      model: model ?? 'unknown',
      now: new Date(),
      messages: historyMessages.map((m) => ({ id: m.id, role: m.role, content: getMessageText(m.extra.parts) })),
      macroVars: { ...vars },
    });

    const resolveStorageMacros = (parts: ContentPart[], vars: Record<string, string>): { parts: ContentPart[]; vars: Record<string, string> } => {
      const resolver = MacroResolver.createStorageResolver();
      const macroCtx = buildMacroCtx(vars);
      const resolvedParts = parts.map((p) => {
        if (p.type === 'text') {
          return { ...p, text: resolver.resolve(p.text, macroCtx) };
        }
        return p;
      });
      return { parts: resolvedParts, vars: { ...macroCtx.macroVars } };
    };

    const active: ActiveGeneration = {
      generationId,
      chatId,
      targetMessageId,
      abortController,
      streamingText: '',
      streamingReasoning: '',
      streamingReasoningSignature: '',
      streamingParts: existingMessage.extra.parts ? [...existingMessage.extra.parts] : [],
    };
    const initialPartCount = active.streamingParts.length;

    // Save the original text of the last text part so we can recompute it
    // after streaming (regex / post-processing must apply to the full part text).
    let existingLastText = '';
    for (let i = initialPartCount - 1; i >= 0; i--) {
      const p = active.streamingParts[i]!;
      if (p.type === 'text') {
        existingLastText = (p).text;
        break;
      }
    }
    this.active.set(generationId, active);
    const generationStartTime = Date.now();

    await generations.update(generationId, { status: 'streaming' });
    this.deps.generationBroadcast.broadcastGenerationStarted(chatId, generationId, targetMessageId);

    let flushTimeout: ReturnType<typeof setTimeout> | null = null;
    const flushToDb = async () => {
      flushTimeout = null;
      const flushExtra: MessageExtra = { ...existingMessage.extra };
      const { parts: resolvedParts, vars } = resolveStorageMacros(active.streamingParts, existingVars);
      flushExtra.parts = resolvedParts;
      flushExtra.macroVars = vars;
      if (character) flushExtra.characterId = character.id;
      if (model) flushExtra.model = model;
      try {
        await chats.updateMessage(targetMessageId, { extra: flushExtra });
        await this.deps.chatBroadcast.broadcastMessageSnapshot(chatId, targetMessageId);
      } catch (err) {
        log.error({ err, chatId, targetMessageId }, 'streaming flush failed');
      }
    };
    const scheduleFlush = () => {
      if (flushTimeout) return;
      // Throttle mid-stream full-message snapshots to ~1/s. Per-token
      // broadcastGenerationToken still drives the live UX, and the complete
      // rendered snapshot is broadcast on stream completion regardless. This
      // keeps the server→client blast from congesting the client's WS send
      // buffer (which was starving outgoing action frames under load).
      flushTimeout = setTimeout(() => void flushToDb(), 1000);
    };

    const handleStreamItem = (item: BackendStreamItem) => {
      switch (item.type) {
        case 'text': {
          active.streamingText += item.token;
          const last = active.streamingParts[active.streamingParts.length - 1];
          if (last && last.type === 'text') {
            last.text += item.token;
          } else {
            active.streamingParts.push({ type: 'text', text: item.token });
          }
          this.deps.generationBroadcast.broadcastGenerationToken(chatId, generationId, item.token);
          scheduleFlush();
          break;
        }
        case 'reasoning': {
          active.streamingReasoning += item.token;
          const last = active.streamingParts[active.streamingParts.length - 1];
          if (last && last.type === 'reasoning') {
            last.text += item.token;
          } else {
            active.streamingParts.push({ type: 'reasoning', text: item.token });
          }
          this.deps.generationBroadcast.broadcastGenerationReasoningToken(chatId, generationId, item.token);
          scheduleFlush();
          break;
        }
        case 'reasoningSignature':
          active.streamingReasoningSignature += item.signature;
          break;
        case 'toolCall':
          // Streaming tool-call deltas are intentionally not accumulated here; tool calls are
          // resolved from the final result.toolCalls once the stream completes.
          break;
        default: {
          const _exhaustive: never = item;
          throw new Error(
            `Unhandled BackendStreamItem variant: ${String((_exhaustive as { type?: string }).type)}`,
          );
        }
      }
    };

    try {
      const debugPrompts = Boolean(await this.deps.settings.get('debugPrompts'));
      if (debugPrompts) {
        this.deps.generationBroadcast.broadcastPromptAnnounced(chatId, generationId, prompt);
      }
      const stream = backend.stream(prompt, abortController.signal, {
        chatId,
        characterId: character?.id,
        generationType,
        scriptState: findLatestStateSnapshot(backend.id, historyMessages),
      });
      let next = await stream.next();
      while (!next.done) {
        handleStreamItem(next.value);
        next = await stream.next();
      }
      const result = next.value;

      if (result.error) {
        await generations.update(generationId, {
          status: 'error',
          errorMessage: result.error,
          completionTokens: result.usage.completionTokens,
        });
        log.error({ chatId, generationId, backend: backend.id, error: result.error }, 'generation failed');
        this.deps.generationBroadcast.broadcastGenerationError(chatId, generationId, result.error);
        return result;
      }

      // Append tool calls as parts (they come after streaming finishes)
      if (result.toolCalls && result.toolCalls.length > 0) {
        for (const tc of result.toolCalls) {
          active.streamingParts.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
      }

      // Attach reasoning signature to the last reasoning part
      if (active.streamingReasoningSignature) {
        let lastReasoning: { type: 'reasoning'; text: string } | undefined;
        for (let i = active.streamingParts.length - 1; i >= 0; i--) {
          const p = active.streamingParts[i]!;
          if (p.type === 'reasoning') {
            lastReasoning = p;
            break;
          }
        }
        if (lastReasoning) {
          (lastReasoning as Record<string, unknown>).signature = active.streamingReasoningSignature;
        }
      }

      // Find the last text part.
      let lastTextPartIndex = -1;
      for (let i = 0; i < active.streamingParts.length; i++) {
        if (active.streamingParts[i]!.type === 'text') {
          lastTextPartIndex = i;
        }
      }

      // Recompute the last text part: for continues we prepend the original
      // text; for fresh / tool-follow-up text parts we use only the new text.
      const isNewTextPart = lastTextPartIndex !== -1 && lastTextPartIndex >= initialPartCount && initialPartCount > 0;
      if (lastTextPartIndex !== -1) {
        const baseText = isNewTextPart ? '' : existingLastText;
        (active.streamingParts[lastTextPartIndex] as { type: 'text'; text: string }).text = baseText + active.streamingText;
      }

      const newExtra: MessageExtra = { ...existingMessage.extra };
      newExtra.parts = active.streamingParts;

      // Branch-aware script state (custom backends): persist the snapshot the
      // adapter returned under its own key, preserving other tools' snapshots.
      if (result.scriptState) {
        newExtra._toolState = { ...(existingMessage.extra._toolState ?? {}), [backend.id]: result.scriptState };
      }

      if (!active.streamingReasoning && prompt.reasoning) {
        // Parse text-based reasoning if no native reasoning was streamed.
        // When reasoning is found, replace the text part with a reasoning part
        // followed by a text part containing the remaining content.
        const r = prompt.reasoning;
        const lastText = lastTextPartIndex !== -1
          ? (active.streamingParts[lastTextPartIndex] as { type: 'text'; text: string }).text
          : '';
        const parsed = extractReasoning(lastText, r.pattern, r.prefix, r.suffix);
        if (parsed.reasoning && lastTextPartIndex !== -1) {
          const newParts = [...active.streamingParts];
          newParts.splice(lastTextPartIndex, 1,
            { type: 'reasoning', text: parsed.reasoning },
            { type: 'text', text: parsed.content },
          );
          active.streamingParts = newParts;
          newExtra.parts = active.streamingParts;
          lastTextPartIndex = lastTextPartIndex + 1;
        }
      }
      if (character) {
        newExtra.characterId = character.id;
      }
      if (model) {
        newExtra.model = model;
      }

      // Apply post-processing to the last text part (all prior text was
      // already post-processed in earlier generation rounds).
      const lastTextPart = lastTextPartIndex !== -1
        ? (active.streamingParts[lastTextPartIndex] as { type: 'text'; text: string })
        : null;
      if (lastTextPart) {
        const whitespaceMode = allSettings.whitespaceMode;
        lastTextPart.text = applyOutputWhitespace(lastTextPart.text, whitespaceMode);

        if (allSettings['removeXML']) {
          lastTextPart.text = lastTextPart.text.replace(/<[^>]+>/g, '');
        }
        if (allSettings['singleLine']) {
          const firstNewline = lastTextPart.text.search(/\r?\n/);
          if (firstNewline !== -1) {
            lastTextPart.text = lastTextPart.text.slice(0, firstNewline);
          }
        }
        if (allSettings['trimSentences']) {
          const sentenceEnd = /[.!?]+(?:\s+|$)/g;
          let lastMatchEnd = -1;
          let match: RegExpExecArray | null;
          while ((match = sentenceEnd.exec(lastTextPart.text)) !== null) {
            lastMatchEnd = match.index + match[0].length;
          }
          if (lastMatchEnd > 0) {
            lastTextPart.text = lastTextPart.text.slice(0, lastMatchEnd).trimEnd();
          }
        }
        if (allSettings['autoFixGeneratedMarkdown']) {
          lastTextPart.text = this.autoFixMarkdown(lastTextPart.text);
        }
        if (!allSettings['disableGroupTrimming'] && character) {
          lastTextPart.text = await this.cleanGroupMessage(chatId, character, lastTextPart.text);
        }
        newExtra.parts = active.streamingParts;
      }

      // Resolve storage macros on the whole message before saving
      const { parts: resolvedParts, vars: newVars } = resolveStorageMacros(active.streamingParts, existingVars);
      newExtra.parts = resolvedParts;
      newExtra.macroVars = newVars;

      // Derive flat content from all text parts (kept for RAG / search compat)
      const newContent = resolvedParts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');

      // Count tokens for the final assistant message
      newExtra.tokenCount = tokenCounterProvider.provideTokenCounter(model).count(newContent);

      // Store generation duration
      const generationDuration = (Date.now() - generationStartTime) / 1000;
      newExtra.generationTime = generationDuration;

      // Merge World Info activations for branch-aware sticky/cooldown/delay state.
      // Follow-up generations (tool rounds) append to the existing list.
      const existingWiActivations = existingMessage.extra._wiActivations ?? [];
      const newWiActivations = prompt.wiActivations ?? [];
      if (newWiActivations.length > 0) {
        const merged = [...new Set([...existingWiActivations, ...newWiActivations])];
        newExtra._wiActivations = merged;
      }

      // Cancel any pending streaming flush and ensure the latest partial state is persisted
      // before we overwrite it with the final post-processed state.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flushTimeout is assigned asynchronously via setTimeout
      if (flushTimeout) {
        clearTimeout(flushTimeout);
      }

      const updatedMessage = await chats.updateMessage(targetMessageId, {
        extra: newExtra,
      });

      await generations.update(generationId, {
        status: 'complete',
        messageId: updatedMessage.id,
        completionTokens: result.usage.completionTokens,
      });

      await this.deps.chatBroadcast.broadcastMessageSnapshot(chatId, updatedMessage.id);

      if (!suppressDone) {
        this.deps.generationBroadcast.broadcastGenerationDone(chatId, generationId, result.finishReason);
      }

      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ err: error }, 'generation failed');
      const status = abortController.signal.aborted ? 'aborted' : 'error';
      await generations.update(generationId, { status, errorMessage: error });
      if (abortController.signal.aborted) {
        this.deps.generationBroadcast.broadcastGenerationAborted(chatId, generationId);
      } else {
        this.deps.generationBroadcast.broadcastGenerationError(chatId, generationId, error);
      }
      return { finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 }, error };
    } finally {
      this.active.delete(generationId);
    }
  }

  /**
   * Run a quiet generation (no message created). Used for impersonation and Lua st.generate().
   */
  private async runQuietGeneration(
    generationId: string,
    chatId: string,
    prompt: Prompt,
    backend: BackendAdapter,
    mode: 'impersonate' | 'quiet' | 'genraw' = 'impersonate',
  ): Promise<{ text: string; finishReason: string } | { error: string }> {
    const { generations } = this.deps;

    const abortController = new AbortController();
    const active: ActiveGeneration = {
      generationId,
      chatId,
      targetMessageId: 0,
      abortController,
      streamingText: '',
      streamingReasoning: '',
      streamingReasoningSignature: '',
      streamingParts: [],
    };
    this.active.set(generationId, active);

    await generations.update(generationId, { status: 'streaming' });
    this.deps.generationBroadcast.broadcastGenerationStarted(chatId, generationId);

    try {
      const debugPrompts = Boolean(await this.deps.settings.get('debugPrompts'));
      if (debugPrompts) {
        this.deps.generationBroadcast.broadcastPromptAnnounced(chatId, generationId, prompt);
      }
      const stream = backend.stream(prompt, abortController.signal, { chatId, generationType: mode });
      let next = await stream.next();
      while (!next.done) {
        const item = next.value;
        if (item.type === 'text') {
          active.streamingText += item.token;
          this.deps.generationBroadcast.broadcastGenerationToken(chatId, generationId, item.token);
        } else if (item.type === 'reasoning') {
          active.streamingReasoning += item.token;
          this.deps.generationBroadcast.broadcastGenerationReasoningToken(chatId, generationId, item.token);
        } else if (item.type === 'reasoningSignature') {
          active.streamingReasoningSignature += item.signature;
        }
        next = await stream.next();
      }
      const result = next.value;

      if (result.error) {
        await generations.update(generationId, {
          status: 'error',
          errorMessage: result.error,
          completionTokens: result.usage.completionTokens,
        });
        log.error({ chatId, generationId, backend: backend.id, error: result.error }, 'generation failed');
        this.deps.generationBroadcast.broadcastGenerationError(chatId, generationId, result.error);
        return { error: result.error };
      }

      await generations.update(generationId, {
        status: 'complete',
        completionTokens: result.usage.completionTokens,
      });

      if (mode === 'impersonate') {
        this.deps.generationBroadcast.broadcastImpersonationComplete(chatId, generationId, active.streamingText);
      }
      this.deps.generationBroadcast.broadcastGenerationDone(chatId, generationId, result.finishReason);
      return { text: active.streamingText, finishReason: result.finishReason };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ err: error }, 'quiet generation failed');
      const status = abortController.signal.aborted ? 'aborted' : 'error';
      await generations.update(generationId, { status, errorMessage: error });
      if (abortController.signal.aborted) {
        this.deps.generationBroadcast.broadcastGenerationAborted(chatId, generationId);
      } else {
        this.deps.generationBroadcast.broadcastGenerationError(chatId, generationId, error);
      }
      return { error };
    } finally {
      this.active.delete(generationId);
    }
  }

  /**
   * Remove lines spoken by other group members from a generated message.
   * Only applies to group chats. Lines starting with `OtherName:` or similar
   * prefixes are stripped.
   */
  private async cleanGroupMessage(chatId: string, character: Character, content: string): Promise<string> {
    const chat = await this.deps.chats.getChatById(chatId);
    if (!chat || chat.characterId !== null) return content;

    const members = await this.deps.chatMembers.getMembers(chatId);
    if (members.length === 0) return content;

    // Collect names of other members
    const otherMemberIds = members
      .filter((m) => m.characterId !== character.id)
      .map((m) => m.characterId);
    const otherChars = await this.deps.characters.getByIds(otherMemberIds);
    const otherNames = otherChars.map((c) => c.name);
    if (otherNames.length === 0) return content;

    const separators = [':', '：', '-', '~', '=>', '->', '>', '*'];
    const prefixSet = new Set<string>();
    for (const name of otherNames) {
      for (const sep of separators) {
        prefixSet.add(name + sep);
      }
    }

    const lines = content.split('\n');
    const cleaned: string[] = [];

    for (const line of lines) {
      const trimmed = line.trimStart();
      let isOtherMember = false;
      for (const prefix of prefixSet) {
        if (trimmed.startsWith(prefix)) {
          isOtherMember = true;
          break;
        }
      }
      if (!isOtherMember) cleaned.push(line);
    }

    return cleaned.join('\n');
  }

  /**
   * Return the currently active generation, if any.
   * Used to replay streaming state to reconnecting clients.
   */
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

  getActiveGeneration():
    | { id: string; chatId: string; messageId: number; text: string; reasoning?: string }
    | undefined {
    for (const active of this.active.values()) {
      return {
        id: active.generationId,
        chatId: active.chatId,
        messageId: active.targetMessageId,
        text: active.streamingText,
        reasoning: active.streamingReasoning || undefined,
      };
    }
    return undefined;
  }

  // ── Slash-command generation methods ───────────────────────────────────

  /**
   * /gen — generate with chat context (character, history, WI) but don't
   * append a regular user/assistant pair. The result is appended as a system
   * message for display. Wraps the existing quietGenerate.
   */
  async handleGen(chatId: string, prompt: string, clientId?: string, lockHolder?: string): Promise<void> {
    // NOTE: quietGenerate's 4th arg is lockHolder, NOT clientId — passing a
    // clientId there (as before) made /gen run without the chat mutex.
    const result = await this.quietGenerate(chatId, prompt, null, lockHolder);
    if ('error' in result) {
      if (clientId) this.deps.bus.sendTo(clientId, { type: 'error', message: result.error, code: 'GEN_FAILED' });
      return;
    }
    await this.deps.chats.appendMessage(chatId, {
      role: 'system',
      extra: { parts: [{ type: 'text', text: result.text }] },
    });
    await this.deps.chatBroadcast.broadcastSnapshot(chatId, 10000);
  }

  /**
   * /sysgen — same as /gen (generate with chat context, append as system).
   * Kept as a separate method for future divergence (e.g. system-role prompt framing).
   */
  async handleSysGen(chatId: string, content: string, clientId?: string, lockHolder?: string): Promise<void> {
    await this.handleGen(chatId, content, clientId, lockHolder);
  }

  /**
   * /genraw — truly raw generation: no chat history, no character, no WI.
   * Just the prompt text → LLM. The result is appended as a system message.
   */
  async handleGenRaw(chatId: string, promptText: string, clientId?: string, lockHolder?: string): Promise<void> {
    const { chats, settings, backendConfigs, backendFactory, bus, chatBroadcast, generations } = this.deps;

    const held = lockHolder !== undefined;
    if (!held) await this.mutexFor(chatId).lock();
    try {
      const allSettings = await settings.list();
      const activeBackendConfigId = allSettings.activeBackendConfigId;
      const backendConfig = activeBackendConfigId ? await backendConfigs.getById(activeBackendConfigId) : null;
      const backendSettings = buildBackendSettings(allSettings, backendConfig);
      const backend = await backendFactory.create(backendSettings);
      if (!backend) {
        if (clientId) bus.sendTo(clientId, { type: 'error', message: 'No backend configured', code: 'NO_BACKEND' });
        return;
      }

      const maxResponseTokens = Math.max(1, backendConfig?.maxTokens ?? allSettings.maxResponseTokens);

      // Minimal prompt — just the text, no chat history/character/WI/pipeline.
      const prompt: Prompt = {
        messages: [{ role: 'user', content: promptText }],
        tokenUsage: { prompt: 0, completion: maxResponseTokens },
        params: {},
      };

      const generationId = randomUUID();
      await generations.create(generationId, {
        chatId,
        messageId: null,
        status: 'pending',
        backend: backend.id,
        promptTokens: 0,
        completionTokens: null,
        errorMessage: null,
      });

      const result = await this.runQuietGeneration(generationId, chatId, prompt, backend, 'genraw');
      if ('error' in result) {
        if (clientId) bus.sendTo(clientId, { type: 'error', message: result.error, code: 'GEN_FAILED' });
        return;
      }

      await chats.appendMessage(chatId, {
        role: 'system',
        extra: { parts: [{ type: 'text', text: result.text }] },
      });
      await chatBroadcast.broadcastSnapshot(chatId, 10000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'raw generation failed');
      if (clientId) bus.sendTo(clientId, { type: 'error', message, code: 'GEN_FAILED' });
    } finally {
      if (!held) this.unlockChat(chatId);
    }
  }

  /**
   * /ask — generate a reply as a specific character (not the chat's character).
   * Appends the user message, then generates using the override character's
   * persona/description via the existing executeGeneration (which already
   * takes `character` as a decoupled arg, used by group chat).
   */
  async handleAsk(chatId: string, characterName: string, content: string, clientId?: string, lockHolder?: string): Promise<void> {
    const { characters, chats, bus } = this.deps;

    const character = await characters.getByName(characterName);
    if (!character) {
      if (clientId) bus.sendTo(clientId, { type: 'error', message: `Character not found: ${characterName}`, code: 'NOT_FOUND' });
      return;
    }

    // Append the user message (sharing the caller's lock tenure when given —
    // without the pass-through this deadlocks against a script-held lock).
    await this.handleSend(chatId, content, undefined, lockHolder);

    const chat = await chats.getChatById(chatId);
    if (!chat) return;
    const parentId = chat.activeChildId ?? chat.headMessageId;
    await this.executeGeneration(chatId, character, parentId ?? null, null, lockHolder, clientId);
  }
}
