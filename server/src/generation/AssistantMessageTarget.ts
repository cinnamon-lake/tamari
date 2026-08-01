/**
 * AssistantMessageTarget — the chat-message generation target (send /
 * continue / regenerate, including group-chat members and /ask).
 *
 * Behavior relocated VERBATIM from GenerationService (executeGeneration's
 * message creation, runGeneration's streaming accumulation + throttled flush
 * + success-path finalization, the tool loop's parts extension, and the
 * auto-continue check). See docs/design/generation-runner.md.
 *
 * The target is the message's slot until prepare() creates it (fresh sends,
 * regenerate siblings); for continue it wraps the existing message. The
 * runner consults pendingToolCalls() between rounds — the local parts list
 * is the source of truth.
 *
 * Round boundaries: the runner calls prompt() before every stream round, so
 * prompt() doubles as the round-settle hook — when a stream round completed
 * since the last settle, the previous round's end-of-stream processing
 * (signature attach, last-text recompute, reasoning extraction,
 * post-processing, storage-macro resolution) runs before the new round's
 * state is captured. finalize() settles the last round.
 */

import { getLogger } from '../lib/logger.js';
import { str } from '../lib/coerce.js';
import { getMessageText } from '@tamari/types';
import type { Message, Character, MessageExtra, ContentPart } from '@tamari/types';
import type { BackendStreamItem, GenerationResult, Prompt, ToolCall } from '../backends/BackendAdapter.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { IChatMemberRepository } from '../repos/ChatMemberRepository.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { ChatBroadcastService } from '../services/ChatBroadcastService.js';
import type { GenerationBroadcastService } from '../services/GenerationBroadcastService.js';
import type { ToolResult } from '../services/ToolRegistry.js';
import { extractReasoning } from '../services/ReasoningEngine.js';
import { tokenCounterProvider } from '../tokenizers/TokenCounter.js';
import { MacroResolver } from '../pipeline/MacroResolver.js';
import { getChatSnapshotMessages } from '../lib/swipeInfo.js';
import type { ChatPromptAssembly } from './ChatPromptAssembly.js';
import type { GenerationTarget, ResolvedGenerationBackend, ToolContextMessage } from './GenerationTarget.js';
import { FULL_BRANCH_MESSAGE_LIMIT } from './GenerationTarget.js';

const log = getLogger('AssistantMessageTarget');

export interface AssistantMessageTargetDeps {
  chats: IChatRepository;
  characters: ICharacterRepository;
  chatMembers: IChatMemberRepository;
  personas: IPersonaRepository;
  settings: ISettingsRepository;
  backendConfigs: IBackendConfigRepository;
  chatBroadcast: ChatBroadcastService;
  generationBroadcast: GenerationBroadcastService;
  assembly: ChatPromptAssembly;
}

interface FreshAnchor {
  anchor: 'fresh';
  /** Explicit parent (group chaining, /ask, regenerate sibling). Undefined =
      link against the chat's current leaf. */
  parentId?: number | null;
}

interface ContinueAnchor {
  anchor: 'continue';
  messageId: number;
}

type Anchor = FreshAnchor | ContinueAnchor;

function applyOutputWhitespace(content: string, mode: string): string {
  if (mode !== 'full') return content;
  return content.replace(/\s+/g, (match) => (match.includes('\n') ? '\n\n' : ' '));
}

export class AssistantMessageTarget implements GenerationTarget {
  readonly persistent = true;

  private generationId = '';
  private message: Message | null = null;
  private streamingParts: ContentPart[] = [];
  private baseExtra: MessageExtra = {};

  // Round state (captured in prepare()/prompt(), consumed by settleRound()).
  private initialPartCount = 0;
  private existingLastText = '';
  private streamingText = '';
  private streamingReasoning = '';
  private streamingReasoningSignature = '';
  private streamedSinceLastSettle = false;
  private roundToolCalls: ToolCall[] = [];

  // Macro plumbing.
  private currentVars: Record<string, string> = {};
  private historyMessages: Message[] = [];
  private userName = 'User';

  // Settings/backend snapshot for post-processing and counting.
  private allSettings: Record<string, unknown> = {};
  private model: string | undefined;
  private generationStartTime = Date.now();

  // Last built prompt (reasoning extraction, wiActivations merge).
  private lastPrompt: Prompt | null = null;
  private lastPromptHistoryLimit: number | null = null;
  private accumulatedWiActivations: string[] = [];
  /** The streaming backend's id (scriptState key), captured in prompt(). */
  private backendId = '';

  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Serializes fire-and-forget persists (round-end, timer flush) against the
      runner-awaited ones (tool outcomes, finalize) so DB writes land in
      logical order. */
  private persistChain: Promise<void> = Promise.resolve();

  private constructor(
    private deps: AssistantMessageTargetDeps,
    readonly chatId: string,
    readonly clientId: string | undefined,
    readonly character: Character | null,
    readonly kind: 'send' | 'regenerate' | 'continue',
    private anchorData: Anchor,
  ) {}

  static forNewMessage(
    identity: { chatId: string; clientId?: string; character: Character | null; parentId?: number | null },
    deps: AssistantMessageTargetDeps,
  ): AssistantMessageTarget {
    return new AssistantMessageTarget(deps, identity.chatId, identity.clientId, identity.character, 'send', {
      anchor: 'fresh',
      parentId: identity.parentId,
    });
  }

  static continueFrom(
    identity: { chatId: string; clientId?: string; character: Character | null; messageId: number },
    deps: AssistantMessageTargetDeps,
  ): AssistantMessageTarget {
    return new AssistantMessageTarget(deps, identity.chatId, identity.clientId, identity.character, 'continue', {
      anchor: 'continue',
      messageId: identity.messageId,
    });
  }

  static regenerateOf(
    identity: { chatId: string; clientId?: string; character: Character | null; parentId: number | null },
    deps: AssistantMessageTargetDeps,
  ): AssistantMessageTarget {
    return new AssistantMessageTarget(deps, identity.chatId, identity.clientId, identity.character, 'regenerate', {
      anchor: 'fresh',
      parentId: identity.parentId,
    });
  }

  get messageId(): number | null {
    return this.message?.id ?? (this.anchorData.anchor === 'continue' ? this.anchorData.messageId : null);
  }

  bindGeneration(generationId: string): void {
    this.generationId = generationId;
  }

  // ── prepare ────────────────────────────────────────────────────────────

  async prepare(): Promise<void> {
    const { chats } = this.deps;

    const chat = await chats.getChatById(this.chatId);
    this.allSettings = await this.deps.settings.list();
    const persona = chat?.personaId ? await this.deps.personas.getById(chat.personaId) : undefined;
    this.userName = persona?.name || (this.allSettings['userName'] as string | undefined) || 'User';
    const { messages: historyMessages } = await getChatSnapshotMessages(chats, this.chatId, 100);
    this.historyMessages = historyMessages;

    let message: Message;
    if (this.anchorData.anchor === 'continue') {
      const existing = await chats.getMessageById(this.anchorData.messageId);
      if (!existing) throw new Error('Target message not found');
      message = existing;
    } else {
      const parentId = this.anchorData.parentId;
      const parentMessage = parentId ? await chats.getMessageById(parentId) : null;
      // Single-chat sends pass no explicit parentId — inherit macro vars from
      // the chat's current leaf, which is what appendMessage links against
      // internally. Without this fallback the setvar → getvar chain breaks.
      const leafId = chat?.activeChildId ?? chat?.headMessageId ?? null;
      const varSource = parentMessage ?? (leafId !== null ? await chats.getMessageById(leafId) : null);
      const previousVars = varSource?.extra.macroVars ?? {};
      message = await chats.appendMessage(this.chatId, {
        role: 'assistant',
        // Vars chain under `macroVars` — the key every reader uses
        // (flush's resolveStorageMacros, next turn's macroCtx). Anything
        // else (e.g. `variables`) silently breaks cross-turn getvar.
        extra: this.character
          ? { characterId: this.character.id, macroVars: previousVars }
          : { macroVars: previousVars },
        parentId: parentId,
      });
      // Send the canonical snapshot (messages + swipes) so the client never has stale state.
      await this.deps.chatBroadcast.broadcastMessageAppended(this.chatId, message.id);
      await this.deps.chatBroadcast.broadcastSnapshot(this.chatId, 10000);
    }

    this.message = message;
    this.baseExtra = message.extra;
    this.streamingParts = message.extra.parts ? [...message.extra.parts] : [];
    this.currentVars = message.extra.macroVars ?? {};
    this.captureRoundState();
  }

  /** Capture per-round streaming state from the current parts. */
  private captureRoundState(): void {
    this.initialPartCount = this.streamingParts.length;
    // Save the original text of the last text part so we can recompute it
    // after streaming (regex / post-processing must apply to the full part text).
    this.existingLastText = '';
    for (let i = this.streamingParts.length - 1; i >= 0; i--) {
      const p = this.streamingParts[i]!;
      if (p.type === 'text') {
        this.existingLastText = p.text;
        break;
      }
    }
    this.streamingText = '';
    this.streamingReasoning = '';
    this.streamingReasoningSignature = '';
    this.streamedSinceLastSettle = false;
    this.roundToolCalls = [];
    this.generationStartTime = Date.now();
  }

  // ── Policy 1: prompt assembly (also the round-settle hook) ─────────────

  async prompt(resolved: ResolvedGenerationBackend): Promise<Prompt> {
    // A stream round completed since the last settle — run its end-of-stream
    // processing before starting the next round (the legacy code did this at
    // the end of every runGeneration call).
    if (this.streamedSinceLastSettle) await this.settleRound();

    this.allSettings = resolved.allSettings;
    this.model = str(resolved.backendSettings['model']);
    this.backendId = resolved.backend.id;
    const { messages: historyMessages } = await getChatSnapshotMessages(this.deps.chats, this.chatId, 100);
    this.historyMessages = historyMessages;

    const chat = await this.deps.chats.getChatById(this.chatId);
    const { prompt, promptHistoryLimit } = await this.deps.assembly.build({
      chatId: this.chatId,
      chat: chat ?? null,
      character: this.character,
      resolved,
      // One rule for every kind: the branch is computed from the message being
      // generated (its parent chain, inclusive) — no chat-pointer dependence,
      // no per-kind special cases. Regenerate is not a separate action.
      anchorMessageId: this.message?.id,
      lastGenerationType: this.kind,
    });

    this.lastPrompt = prompt;
    this.lastPromptHistoryLimit = promptHistoryLimit;
    const newWiActivations = prompt.wiActivations ?? [];
    if (newWiActivations.length > 0) {
      this.accumulatedWiActivations = [...new Set([...this.accumulatedWiActivations, ...newWiActivations])];
    }

    this.captureRoundState();
    return prompt;
  }

  // ── Loop state ─────────────────────────────────────────────────────────

  read(): ContentPart[] {
    return this.streamingParts;
  }

  pendingToolCalls(): ToolCall[] {
    const parts = this.streamingParts;
    const pending: ToolCall[] = [];
    for (const p of parts) {
      if (p.type !== 'tool_use') continue;
      const hasResult = parts.some((q) => q.type === 'tool_result' && q.toolUseId === p.id);
      if (!hasResult) pending.push({ id: p.id, name: p.name, arguments: p.input });
    }
    return pending;
  }

  async toolContextMessages(): Promise<ToolContextMessage[]> {
    // Tool-execution context comes from a fresh branch read: flushes persist
    // tool_use parts at stream end and each outcome persists its tool_result
    // parts, so the DB already holds every earlier round's `_toolState`
    // snapshot (e.g. map_create → map_set_tile within one turn).
    const limit = this.lastPromptHistoryLimit ?? (await this.defaultHistoryLimit());
    const toolBranch = await this.deps.chats.getActiveBranch(this.chatId, { limit });
    return toolBranch.map((m) => ({
      id: String(m.id),
      role: m.role,
      content: getMessageText(m.extra.parts),
      extra: m.extra,
    }));
  }

  async fullBranchMessages(): Promise<ToolContextMessage[]> {
    const branch = await this.deps.chats.getActiveBranch(this.chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
    return branch.map((m) => ({
      id: String(m.id),
      role: m.role,
      content: getMessageText(m.extra.parts),
      extra: m.extra,
    }));
  }

  /** promptHistoryLimit without a build (tool execution before round 1). */
  private async defaultHistoryLimit(): Promise<number> {
    const allSettings = await this.deps.settings.list();
    const backendConfig = allSettings.activeBackendConfigId
      ? await this.deps.backendConfigs.getById(allSettings.activeBackendConfigId)
      : null;
    let limit = backendConfig?.promptHistoryLimit ?? allSettings.promptHistoryLimit;
    const chatTruncation = allSettings.chatTruncation;
    if (chatTruncation > 0 && limit > chatTruncation) limit = chatTruncation;
    return limit;
  }

  // ── Policy 2: persistence & broadcasting ───────────────────────────────

  write(item: BackendStreamItem): void {
    switch (item.type) {
      case 'text': {
        this.streamingText += item.token;
        const last = this.streamingParts[this.streamingParts.length - 1];
        if (last && last.type === 'text') {
          last.text += item.token;
        } else {
          this.streamingParts.push({ type: 'text', text: item.token });
        }
        this.deps.generationBroadcast.broadcastGenerationToken(this.chatId, this.generationId, item.token);
        this.scheduleFlush();
        break;
      }
      case 'reasoning': {
        this.streamingReasoning += item.token;
        const last = this.streamingParts[this.streamingParts.length - 1];
        if (last && last.type === 'reasoning') {
          last.text += item.token;
        } else {
          this.streamingParts.push({ type: 'reasoning', text: item.token });
        }
        this.deps.generationBroadcast.broadcastGenerationReasoningToken(this.chatId, this.generationId, item.token);
        this.scheduleFlush();
        break;
      }
      case 'reasoningSignature':
        this.streamingReasoningSignature += item.signature;
        break;
      case 'toolCall': {
        // Resolved tool calls arrive here (streamed by some adapters, forwarded
        // by the runner from the final GenerationResult for the rest) — dedupe
        // by id so a call reported both ways lands once.
        if (!this.streamingParts.some((p) => p.type === 'tool_use' && p.id === item.id)) {
          this.streamingParts.push({ type: 'tool_use', id: item.id, name: item.name, input: item.arguments });
          this.roundToolCalls.push({ id: item.id, name: item.name, arguments: item.arguments });
          // Round-end persist (the legacy runGeneration persisted the round's
          // parts at stream end): the tool_use must be visible in the DB and
          // on clients BEFORE its outcome lands.
          void this.chain(() => this.persistCurrentParts());
        }
        break;
      }
      default: {
        const _exhaustive: never = item;
        throw new Error(
          `Unhandled BackendStreamItem variant: ${String((_exhaustive as { type?: string }).type)}`,
        );
      }
    }
    this.streamedSinceLastSettle = true;
  }

  async writeToolOutcome(call: ToolCall, outcome: ToolResult): Promise<void> {
    this.streamingParts.push({
      type: 'tool_result',
      toolUseId: call.id,
      name: call.name,
      content: outcome.content,
      isError: outcome.isError,
      extra: outcome.extra,
    });
    await this.chain(() => this.persistCurrentParts(this.roundToolCalls));
  }

  /** Persist the current parts verbatim (+ optional toolCalls key). */
  private async persistCurrentParts(toolCalls?: ToolCall[]): Promise<void> {
    const newExtra: MessageExtra = { ...this.baseExtra, parts: this.streamingParts };
    if (toolCalls !== undefined) newExtra.toolCalls = toolCalls;
    await this.deps.chats.updateMessage(this.message!.id, { extra: newExtra });
    this.baseExtra = newExtra;
    await this.deps.chatBroadcast.broadcastMessageSnapshot(this.chatId, this.message!.id);
  }

  /** Run fn after any in-flight fire-and-forget persist, keeping the chain
      alive (and the returned promise meaningful) if one fails. */
  private chain(fn: () => Promise<void>): Promise<void> {
    const p = this.persistChain.then(fn);
    this.persistChain = p.catch((err) =>
      log.error({ err, chatId: this.chatId, targetMessageId: this.message?.id }, 'persist failed'),
    );
    return p;
  }

  async finalize(result: GenerationResult): Promise<void> {
    // Cancel any pending streaming flush — the final post-processed state
    // overwrites it below.
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    await this.settleRound();

    const newExtra: MessageExtra = { ...this.baseExtra };
    newExtra.parts = this.streamingParts;
    newExtra.macroVars = this.currentVars;

    // Branch-aware script state (custom backends): persist the snapshot the
    // adapter returned under its own key, preserving other tools' snapshots.
    if (result.scriptState) {
      newExtra._toolState = { ...(this.baseExtra._toolState ?? {}), [this.backendId]: result.scriptState };
    }

    if (this.character) {
      newExtra.characterId = this.character.id;
    }
    if (this.model) {
      newExtra.model = this.model;
    }

    // Derive flat content from all text parts (kept for RAG / search compat)
    const newContent = this.streamingParts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');

    // Count tokens for the final assistant message
    newExtra.tokenCount = tokenCounterProvider.provideTokenCounter(this.model).count(newContent);

    // Store generation duration
    const generationDuration = (Date.now() - this.generationStartTime) / 1000;
    newExtra.generationTime = generationDuration;

    // Merge World Info activations for branch-aware sticky/cooldown/delay state.
    // Follow-up rounds (tool calls) append to the existing list.
    const existingWiActivations = this.baseExtra._wiActivations ?? [];
    if (this.accumulatedWiActivations.length > 0) {
      const merged = [...new Set([...existingWiActivations, ...this.accumulatedWiActivations])];
      newExtra._wiActivations = merged;
    }

    await this.chain(async () => {
      const updatedMessage = await this.deps.chats.updateMessage(this.message!.id, {
        extra: newExtra,
      });
      this.baseExtra = updatedMessage.extra;
      await this.deps.chatBroadcast.broadcastMessageSnapshot(this.chatId, updatedMessage.id);
    });
  }

  async abort(_result: GenerationResult): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    // Persist the current accumulated state (one final flush) so partial
    // content survives the abort.
    await this.flushToDb();
  }

  async autoContinueTarget(): Promise<GenerationTarget | null> {
    const allSettings = (Object.keys(this.allSettings).length > 0
      ? this.allSettings
      : await this.deps.settings.list()) as import('@tamari/types').SettingsMap;
    if (!allSettings.autoContinueEnabled) return null;

    const updated = await this.deps.chats.getMessageById(this.message!.id);
    const targetLength = allSettings.autoContinueTargetLength;
    const tokenCount = updated?.extra.tokenCount ?? 0;
    if (!(tokenCount > 0 && tokenCount < targetLength)) return null;

    // Resolve character from message or chat (as handleContinue does).
    const chat = await this.deps.chats.getChatById(this.chatId);
    let character: Character | null = chat?.characterId ? await this.deps.characters.getById(chat.characterId) ?? null : null;
    if (!character && updated?.extra.characterId) {
      character = await this.deps.characters.getById(str(updated.extra.characterId)) ?? null;
    }

    return AssistantMessageTarget.continueFrom(
      { chatId: this.chatId, clientId: this.clientId, character, messageId: this.message!.id },
      this.deps,
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Append-only layout is on (global setting, read at prepare/prompt time). */
  private isAppendOnly(): boolean {
    return this.allSettings['appendOnlyPromptLayout'] === true;
  }

  private buildMacroCtx(vars: Record<string, string>) {
    return {
      userName: this.userName,
      charName: this.character?.name ?? 'Character',
      description: this.character?.description,
      personality: this.character?.personality,
      scenario: this.character?.scenario,
      model: this.model ?? 'unknown',
      now: new Date(),
      messages: this.historyMessages.map((m) => ({ id: m.id, role: m.role, content: getMessageText(m.extra.parts) })),
      macroVars: { ...vars },
    };
  }

  private resolveStorageMacros(
    parts: ContentPart[],
    vars: Record<string, string>,
  ): { parts: ContentPart[]; vars: Record<string, string> } {
    const resolver = MacroResolver.createStorageResolver();
    const macroCtx = this.buildMacroCtx(vars);
    const resolvedParts = parts.map((p) => {
      if (p.type === 'text') {
        return { ...p, text: resolver.resolve(p.text, macroCtx) };
      }
      return p;
    });
    return { parts: resolvedParts, vars: { ...macroCtx.macroVars } };
  }

  /** Throttled mid-stream persist (storage-macro resolved), ~1/s. */
  private flushToDb(): Promise<void> {
    this.flushTimeout = null;
    return this.chain(async () => {
      const flushExtra: MessageExtra = { ...this.baseExtra };
      if (this.isAppendOnly()) {
        // Append-only: macros are off wholesale — persist the raw provider bytes.
        flushExtra.parts = this.streamingParts;
        flushExtra.macroVars = this.currentVars;
      } else {
        const { parts: resolvedParts, vars } = this.resolveStorageMacros(this.streamingParts, this.currentVars);
        flushExtra.parts = resolvedParts;
        flushExtra.macroVars = vars;
      }
      if (this.character) flushExtra.characterId = this.character.id;
      if (this.model) flushExtra.model = this.model;
      try {
        await this.deps.chats.updateMessage(this.message!.id, { extra: flushExtra });
        this.baseExtra = flushExtra;
        await this.deps.chatBroadcast.broadcastMessageSnapshot(this.chatId, this.message!.id);
      } catch (err) {
        log.error({ err, chatId: this.chatId, targetMessageId: this.message!.id }, 'streaming flush failed');
      }
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimeout) return;
    // Throttle mid-stream full-message snapshots to ~1/s. Per-token
    // broadcastGenerationToken still drives the live UX, and the complete
    // rendered snapshot is broadcast on stream completion regardless. This
    // keeps the server→client blast from congesting the client's WS send
    // buffer (which was starving outgoing action frames under load).
    this.flushTimeout = setTimeout(() => void this.flushToDb(), 1000);
  }

  /**
   * End-of-stream processing for a completed round: reasoning signature,
   * last-text recompute, text-based reasoning extraction, post-processing,
   * and the storage-macro resolution pass (the legacy runGeneration did all
   * of this per round at stream end).
   */
  private async settleRound(): Promise<void> {
    const parts = this.streamingParts;

    // Attach reasoning signature to the last reasoning part
    if (this.streamingReasoningSignature) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        if (p.type === 'reasoning') {
          (p as unknown as Record<string, unknown>)['signature'] = this.streamingReasoningSignature;
          break;
        }
      }
    }

    // Find the last text part.
    let lastTextPartIndex = -1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.type === 'text') {
        lastTextPartIndex = i;
      }
    }

    // Recompute the last text part: for continues we prepend the original
    // text; for fresh / tool-follow-up text parts we use only the new text.
    const isNewTextPart = lastTextPartIndex !== -1 && lastTextPartIndex >= this.initialPartCount && this.initialPartCount > 0;
    if (lastTextPartIndex !== -1) {
      const baseText = isNewTextPart ? '' : this.existingLastText;
      (parts[lastTextPartIndex] as { type: 'text'; text: string }).text = baseText + this.streamingText;
    }

    if (!this.streamingReasoning && this.lastPrompt?.reasoning) {
      // Parse text-based reasoning if no native reasoning was streamed.
      // When reasoning is found, replace the text part with a reasoning part
      // followed by a text part containing the remaining content.
      const r = this.lastPrompt.reasoning;
      const lastText = lastTextPartIndex !== -1
        ? (parts[lastTextPartIndex] as { type: 'text'; text: string }).text
        : '';
      const parsed = extractReasoning(lastText, r.pattern, r.prefix, r.suffix);
      if (parsed.reasoning && lastTextPartIndex !== -1) {
        parts.splice(lastTextPartIndex, 1,
          { type: 'reasoning', text: parsed.reasoning },
          { type: 'text', text: parsed.content },
        );
        lastTextPartIndex = lastTextPartIndex + 1;
      }
    }

    // Apply post-processing to the last text part (all prior text was
    // already post-processed in earlier generation rounds). Append-only:
    // skipped wholesale — persisted text must be the raw provider stream.
    const lastTextPart = lastTextPartIndex !== -1 && !this.isAppendOnly()
      ? (parts[lastTextPartIndex] as { type: 'text'; text: string })
      : null;
    if (lastTextPart) {
      const allSettings = this.allSettings as import('@tamari/types').SettingsMap;
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
      if (!allSettings['disableGroupTrimming'] && this.character) {
        lastTextPart.text = await this.cleanGroupMessage(this.character, lastTextPart.text);
      }
    }

    // Resolve storage macros on the whole message; the resolved parts become
    // the message state (the legacy code re-loaded resolved parts from the DB
    // at every round boundary). Append-only: skipped — parts persist raw and
    // macroVars pass through unchanged (macros are off wholesale).
    if (!this.isAppendOnly()) {
      const { parts: resolvedParts, vars } = this.resolveStorageMacros(parts, this.currentVars);
      this.streamingParts = resolvedParts;
      this.currentVars = vars;
    }

    // Reset round accumulators.
    this.streamingText = '';
    this.streamingReasoning = '';
    this.streamingReasoningSignature = '';
    this.streamedSinceLastSettle = false;
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
   * Remove lines spoken by other group members from a generated message.
   * Only applies to group chats. Lines starting with `OtherName:` or similar
   * prefixes are stripped.
   */
  private async cleanGroupMessage(character: Character, content: string): Promise<string> {
    const chat = await this.deps.chats.getChatById(this.chatId);
    if (!chat || chat.characterId !== null) return content;

    const members = await this.deps.chatMembers.getMembers(this.chatId);
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
}
