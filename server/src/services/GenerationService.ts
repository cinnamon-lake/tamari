/**
 * GenerationService — thin facade over GenerationRunner + GenerationTarget.
 *
 * The generation core (mutex tenure, backend resolution, the tool-call loop,
 * the streaming engine) lives in generation/GenerationRunner.ts; prompt
 * assembly and persistence live on the targets (generation/*.ts). This class
 * remains as the entry point other services and the dispatch layer know:
 * it validates input, resolves characters, constructs the right target, and
 * delegates to the runner. See docs/design/generation-runner.md.
 *
 * Locking: callers pass a ChatLock for a tenure they already hold (Lua
 * scripts, group sequences); otherwise the runner acquires per run. The
 * impersonate/quiet/genraw paths deliberately run NESTED (facade acquires,
 * then runs with the held lock) — the legacy code managed its own lock for
 * those and never fired lifecycle callbacks, and that is preserved.
 */

import { getLogger } from '../lib/logger.js';
import { str } from '../lib/coerce.js';

const log = getLogger('GenerationService');
import type { EventBus } from '../bus/EventBus.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { IChatMemberRepository } from '../repos/ChatMemberRepository.js';
import type { IAttachmentRepository } from '../repos/AttachmentRepository.js';
import type { Message, AttachmentRef, MessageExtra } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { GroupChatService } from './GroupChatService.js';
import type { ChatBroadcastService } from './ChatBroadcastService.js';
import type { GenerationBroadcastService } from './GenerationBroadcastService.js';
import { tokenCounterProvider } from '../tokenizers/TokenCounter.js';
import { MacroResolver } from '../pipeline/MacroResolver.js';
import { getChatSnapshotMessages } from '../lib/swipeInfo.js';
import type { GenerationRunner, ChatLock } from '../generation/GenerationRunner.js';
import type { ChatPromptAssembly } from '../generation/ChatPromptAssembly.js';
import { AssistantMessageTarget, type AssistantMessageTargetDeps } from '../generation/AssistantMessageTarget.js';
import { DraftTarget, type DraftTargetDeps } from '../generation/DraftTarget.js';
import { TranscriptTarget, type TranscriptTargetDeps } from '../generation/TranscriptTarget.js';
import { resolveEffectiveSettings } from '../generation/appendOnlyLocks.js';

function applyInputWhitespace(content: string, mode: string): string {
  if (mode === 'none') return content;
  let result = content.trim();
  if (mode === 'full') {
    result = result.replace(/\s+/g, (match) => (match.includes('\n') ? '\n\n' : ' '));
  }
  return result;
}

export interface GenerationLifecycleCallbacks {
  onBeforeGeneration?(chatId: string, clientId: string | undefined): Promise<void> | void;
  onAfterGeneration?(chatId: string, clientId: string | undefined): Promise<void> | void;
}

export interface GenerationServiceDeps {
  bus: EventBus;
  chats: IChatRepository;
  characters: ICharacterRepository;
  settings: ISettingsRepository;
  personas: IPersonaRepository;
  backendConfigs: IBackendConfigRepository;
  chatMembers: IChatMemberRepository;
  attachments: IAttachmentRepository;
  groupChatService: GroupChatService;
  chatBroadcast: ChatBroadcastService;
  generationBroadcast: GenerationBroadcastService;
  assembly: ChatPromptAssembly;
  runner: GenerationRunner;
}

const DEFAULT_IMPERSONATION_PROMPT =
  "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]";

export class GenerationService {
  private lifecycleCallbacks?: GenerationLifecycleCallbacks;

  constructor(private deps: GenerationServiceDeps) {}

  setLifecycleCallbacks(callbacks: GenerationLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
    this.deps.runner.setLifecycleCallbacks(callbacks);
  }

  // ── Lock plumbing (delegated to the runner's mutexes) ──────────────────

  /** Non-blocking acquire for the script gate (fail-fast). Public for ScriptContext. */
  tryLockChat(chatId: string): boolean {
    return this.deps.runner.tryLockChat(chatId);
  }

  /** Release. Warns if the chat wasn't locked (an unbalanced release). */
  unlockChat(chatId: string): void {
    this.deps.runner.unlockChat(chatId);
  }

  /** A lock token for a tenure the caller already holds (script gate). */
  heldLockFor(chatId: string): ChatLock {
    return this.deps.runner.heldLockFor(chatId);
  }

  private assistantTargetDeps(): AssistantMessageTargetDeps {
    const { chats, characters, chatMembers, personas, settings, backendConfigs, chatBroadcast, generationBroadcast, assembly } = this.deps;
    return { chats, characters, chatMembers, personas, settings, backendConfigs, chatBroadcast, generationBroadcast, assembly };
  }

  private draftTargetDeps(): DraftTargetDeps {
    const { chats, generationBroadcast, assembly } = this.deps;
    return { chats, generationBroadcast, assembly };
  }

  private transcriptTargetDeps(): TranscriptTargetDeps {
    const { chats, generationBroadcast, assembly } = this.deps;
    return { chats, generationBroadcast, assembly };
  }

  /**
   * Run an ephemeral target (impersonate/quiet/genraw) NESTED: the facade
   * acquires the chat mutex and hands the tenure down, so no lifecycle
   * callbacks fire — the legacy quiet paths managed their own lock and never
   * fired them.
   */
  private async runNested(target: Parameters<GenerationRunner['run']>[0], lock?: ChatLock) {
    if (lock) return this.deps.runner.run(target, lock);
    const held = await this.deps.runner.acquireChat(target.chatId);
    try {
      return await this.deps.runner.run(target, held);
    } finally {
      this.deps.runner.unlockChat(target.chatId);
    }
  }

  /**
   * Handle a user sending a message in a chat.
   */
  async handleSend(chatId: string, content: string, attachmentRefs?: AttachmentRef[], lock?: ChatLock): Promise<void> {
    const { chats, personas, attachments } = this.deps;

    const held = lock !== undefined;
    if (!held) await this.deps.runner.acquireChat(chatId);

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

    // Apply whitespace trimming to user messages. Read through the append-only
    // lock resolver: under append-only this is locked to 'none' (any input
    // mutation would desync persisted text from already-sent prompt bytes).
    processedContent = applyInputWhitespace(processedContent, resolveEffectiveSettings(appSettings).whitespaceMode);

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
      if (!held) this.deps.runner.unlockChat(chatId);
    }
  }

  /**
   * Trigger generation for a chat. Creates a new assistant message and streams the response.
   * Works regardless of whether the current head is a user or assistant message.
   */
  async handleGenerate(chatId: string, lock?: ChatLock, clientId?: string): Promise<void> {
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
      // fire here — the nested per-member runs don't re-fire them.
      const topLevel = lock === undefined;
      let held = lock;
      if (topLevel) await this.lifecycleCallbacks?.onBeforeGeneration?.(chatId, clientId);
      if (topLevel) held = await this.deps.runner.acquireChat(chatId);

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
          const outcome = await this.deps.runner.run(
            AssistantMessageTarget.forNewMessage(
              { chatId, character, parentId: lastParentId },
              this.assistantTargetDeps(),
            ),
            held,
          );
          if (outcome.messageId) lastParentId = outcome.messageId;
        }
        completed = true;
      } finally {
        if (topLevel) {
          this.deps.runner.unlockChat(chatId);
          if (completed) await this.lifecycleCallbacks?.onAfterGeneration?.(chatId, clientId);
        }
      }
      return;
    }

    // Single-character chat: create assistant child of current head and generate
    const character = chat.characterId ? await this.deps.characters.getById(chat.characterId) : null;
    await this.deps.runner.run(
      AssistantMessageTarget.forNewMessage({ chatId, clientId, character: character ?? null }, this.assistantTargetDeps()),
      lock,
    );
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
    // cannot interleave between members; the nested runs skip their own acquire.
    const held = await this.deps.runner.acquireChat(chatId);

    try {
      const characters = await this.deps.characters.getByIds(activatedMembers);
      const charMap = new Map(characters.map((c) => [c.id, c]));
      for (const characterId of activatedMembers) {
        const character = charMap.get(characterId);
        if (!character) continue;
        const outcome = await this.deps.runner.run(
          AssistantMessageTarget.forNewMessage(
            { chatId, character, parentId: lastParentId },
            this.assistantTargetDeps(),
          ),
          held,
        );
        if (outcome.messageId) lastParentId = outcome.messageId;
      }
    } finally {
      this.deps.runner.unlockChat(chatId);
    }
  }

  /**
   * Handle continue — append generated text to the last assistant message.
   */
  async handleContinue(chatId: string, lock?: ChatLock, clientId?: string): Promise<void> {
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
    await this.deps.runner.run(
      AssistantMessageTarget.continueFrom(
        { chatId, clientId, character: character ?? null, messageId: lastMessage.id },
        this.assistantTargetDeps(),
      ),
      lock,
    );
  }

  /**
   * Handle impersonate — generate a user message and send it to the client as a draft.
   */
  async handleImpersonate(chatId: string, lock?: ChatLock, clientId?: string): Promise<void> {
    const { bus, chats } = this.deps;

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

    const allSettings = await this.deps.settings.list();
    const impersonationPrompt = allSettings.impersonationPrompt || DEFAULT_IMPERSONATION_PROMPT;

    await this.runNested(
      new DraftTarget(this.draftTargetDeps(), chatId, clientId, character ?? null, impersonationPrompt),
      lock,
    );
  }

  /**
   * Run a quiet generation from a custom prompt and return the generated text.
   * Used by server-side Lua scripts (st.generate).
   */
  async quietGenerate(
    chatId: string,
    promptText: string,
    opts: { maxTokens?: number; temperature?: number } | null = {},
    lock?: ChatLock,
  ): Promise<{ text: string; finishReason: string } | { error: string }> {
    const { chats } = this.deps;

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

      const temperature = opts?.temperature !== undefined ? Number(opts.temperature) : undefined;

      const outcome = await this.runNested(
        new TranscriptTarget(this.transcriptTargetDeps(), {
          chatId,
          clientId: undefined,
          character: character ?? null,
          kind: 'quiet',
          seed: promptText,
          assembly: 'chat',
          maxResponseTokensOverride: opts?.maxTokens ? opts.maxTokens : undefined,
          temperatureOverride: temperature,
        }),
        lock,
      );
      if (outcome.error) {
        return { error: outcome.error === 'NO_BACKEND' ? 'No backend configured. Set API key and model in settings.' : outcome.error };
      }
      return { text: outcome.text, finishReason: outcome.finishReason };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'quiet generation failed');
      return { error: message };
    }
  }

  /**
   * Handle regeneration (create a swipe / sibling message).
   */
  async handleRegenerate(chatId: string, messageId?: number, lock?: ChatLock, clientId?: string): Promise<void> {
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
    await this.deps.runner.run(
      AssistantMessageTarget.regenerateOf(
        { chatId, clientId, character: character ?? null, parentId },
        this.assistantTargetDeps(),
      ),
      lock,
    );
  }

  /**
   * Stop an active generation.
   */
  async handleStop(generationId: string): Promise<string | undefined> {
    return this.deps.runner.handleStop(generationId);
  }

  /**
   * Return the currently active generation, if any.
   * Used to replay streaming state to reconnecting clients.
   */
  getActiveGeneration():
    | { id: string; chatId: string; messageId: number; text: string; reasoning?: string }
    | undefined {
    return this.deps.runner.getActiveGeneration();
  }

  // ── Slash-command generation methods ───────────────────────────────────

  /**
   * /gen — generate with chat context (character, history, WI) but don't
   * append a regular user/assistant pair. The result is appended as a system
   * message for display. Wraps the existing quietGenerate.
   */
  async handleGen(chatId: string, prompt: string, clientId?: string, lock?: ChatLock): Promise<void> {
    const result = await this.quietGenerate(chatId, prompt, null, lock);
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
  async handleSysGen(chatId: string, content: string, clientId?: string, lock?: ChatLock): Promise<void> {
    await this.handleGen(chatId, content, clientId, lock);
  }

  /**
   * /genraw — truly raw generation: no chat history, no character, no WI.
   * Just the prompt text → LLM. The result is appended as a system message.
   */
  async handleGenRaw(chatId: string, promptText: string, clientId?: string, lock?: ChatLock): Promise<void> {
    const { chats, bus, chatBroadcast } = this.deps;

    try {
      const outcome = await this.runNested(
        new TranscriptTarget(this.transcriptTargetDeps(), {
          chatId,
          clientId,
          character: null,
          kind: 'genraw',
          seed: promptText,
          assembly: 'seed',
        }),
        lock,
      );
      if (outcome.error) {
        // NO_BACKEND already produced a directed error from the runner.
        if (outcome.error !== 'NO_BACKEND' && clientId) {
          bus.sendTo(clientId, { type: 'error', message: outcome.error, code: 'GEN_FAILED' });
        }
        return;
      }

      await chats.appendMessage(chatId, {
        role: 'system',
        extra: { parts: [{ type: 'text', text: outcome.text }] },
      });
      await chatBroadcast.broadcastSnapshot(chatId, 10000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'raw generation failed');
      if (clientId) bus.sendTo(clientId, { type: 'error', message, code: 'GEN_FAILED' });
    }
  }

  /**
   * /ask — generate a reply as a specific character (not the chat's character).
   * Appends the user message, then generates using the override character's
   * persona/description via a per-character target (the group-chat mechanism).
   */
  async handleAsk(chatId: string, characterName: string, content: string, clientId?: string, lock?: ChatLock): Promise<void> {
    const { characters, chats, bus } = this.deps;

    const character = await characters.getByName(characterName);
    if (!character) {
      if (clientId) bus.sendTo(clientId, { type: 'error', message: `Character not found: ${characterName}`, code: 'NOT_FOUND' });
      return;
    }

    // Append the user message (sharing the caller's lock tenure when given —
    // without the pass-through this deadlocks against a script-held lock).
    await this.handleSend(chatId, content, undefined, lock);

    const chat = await chats.getChatById(chatId);
    if (!chat) return;
    const parentId = chat.activeChildId ?? chat.headMessageId;
    await this.deps.runner.run(
      AssistantMessageTarget.forNewMessage(
        { chatId, clientId, character, parentId: parentId ?? null },
        this.assistantTargetDeps(),
      ),
      lock,
    );
  }
}
