/**
 * GenerationRunner — the ONE generation loop. See docs/design/generation-runner.md.
 *
 * Owns only what is uniform across every generation kind: backend resolution,
 * mutex tenure, the tool-call loop, and the streaming engine. The two
 * kind-varying policies (prompt assembly, persistence/broadcasting) live on
 * GenerationTarget. The runner is kind-blind: it never branches on target.kind.
 *
 * The loop consults only target state:
 *
 *   loop while rounds < maxToolRounds:
 *     pending = target.pendingToolCalls()
 *     if pending: execute → target.writeToolOutcome (endsTurn breaks)
 *     else if rounds > 0: break
 *     prompt = await target.prompt(resolved)
 *     result = await streamRound(prompt, target)
 *
 * "Continue on a message with un-executed tool calls" is not a special case —
 * it is iteration 1 of this loop.
 */

import { randomUUID } from 'node:crypto';
import { getLogger } from '../lib/logger.js';
import { str } from '../lib/coerce.js';
import type { EventBus } from '../bus/EventBus.js';
import type { IGenerationRepository } from '../repos/GenerationRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { IPromptListRepository } from '../repos/PromptListRepository.js';
import type { BackendAdapter, GenerationResult, Prompt } from '../backends/BackendAdapter.js';
import { buildBackendSettings } from '../backends/buildBackendSettings.js';
import type { BackendAdapterFactory } from '../backends/factory.js';
import { createContextualBackendAdapter, getCharacterBackendScript } from '../backends/customBackendFactory.js';
import type { LuaRuntime } from '../scripting/LuaRuntime.js';
import type { ICustomBackendRepository } from '../repos/CustomBackendRepository.js';
import type { ToolRegistry } from '../services/ToolRegistry.js';
import type { GenerationBroadcastService } from '../services/GenerationBroadcastService.js';
import { findLatestStateSnapshot } from '../services/toolState.js';
import { AsyncMutex, type ChatLock } from './AsyncMutex.js';
import type { GenerationTarget, ResolvedGenerationBackend } from './GenerationTarget.js';

const log = getLogger('GenerationRunner');

/** Auto-continue may chain at most this many follow-up generations. */
const MAX_AUTO_CONTINUE_CHAIN = 3;

export interface GenerationLifecycleCallbacks {
  onBeforeGeneration?(chatId: string, clientId: string | undefined): Promise<void> | void;
  onAfterGeneration?(chatId: string, clientId: string | undefined): Promise<void> | void;
}

export interface GenerationRunnerDeps {
  bus: EventBus;
  settings: ISettingsRepository;
  generations: IGenerationRepository;
  backendConfigs: IBackendConfigRepository;
  promptLists: IPromptListRepository;
  backendFactory: BackendAdapterFactory;
  customBackends: ICustomBackendRepository;
  luaRuntime: LuaRuntime;
  generationBroadcast: GenerationBroadcastService;
  toolRegistry?: ToolRegistry;
  /** Tool-call rounds per generation turn (default 100; see config.ts). */
  maxToolRounds?: number;
}

export interface GenerationOutcome {
  generationId: string;
  chatId: string;
  messageId: number | null;
  /** Concatenated text of the target's accumulated content. */
  text: string;
  finishReason: string;
  error?: string;
}

interface ActiveGeneration {
  abortController: AbortController;
  target: GenerationTarget;
}

export class GenerationRunner {
  private active = new Map<string, ActiveGeneration>();
  private chatMutexes = new Map<string, AsyncMutex>();
  private lifecycleCallbacks?: GenerationLifecycleCallbacks;

  constructor(private deps: GenerationRunnerDeps) {}

  setLifecycleCallbacks(callbacks: GenerationLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  // ── Chat mutexes ───────────────────────────────────────────────────────

  private mutexFor(chatId: string): AsyncMutex {
    let m = this.chatMutexes.get(chatId);
    if (!m) {
      m = new AsyncMutex();
      this.chatMutexes.set(chatId, m);
    }
    return m;
  }

  /** Non-blocking acquire for the script gate (fail-fast). Used by ScriptContext. */
  tryLockChat(chatId: string): boolean {
    return this.mutexFor(chatId).tryLock();
  }

  /** Blocking acquire for multi-target sequences run under ONE tenure
      (group-chat member sequences). Pair with unlockChat; pass the returned
      token to the nested run() calls. */
  async acquireChat(chatId: string): Promise<ChatLock> {
    await this.mutexFor(chatId).lock();
    return { chatId };
  }

  /** A lock token for a tenure the CALLER already holds (e.g. a Lua script
      that tryLockChat'd). Same trust model as the legacy truthy lockHolder
      string: only use it while actually holding the lock. */
  heldLockFor(chatId: string): ChatLock {
    return { chatId };
  }

  /** Release. Warns if the chat wasn't locked (an unbalanced release). */
  unlockChat(chatId: string): void {
    if (!this.mutexFor(chatId).unlock()) {
      log.warn({ chatId }, 'unlockChat: mutex not held — unbalanced release');
    }
  }

  // ── Stop / replay ──────────────────────────────────────────────────────

  /** Abort an active generation. Returns its chatId, or undefined if unknown. */
  handleStop(generationId: string): string | undefined {
    const active = this.active.get(generationId);
    if (!active) return undefined;
    active.abortController.abort();
    return active.target.chatId;
  }

  /** The currently active generation, for replaying stream state to
      reconnecting clients. */
  getActiveGeneration():
    | { id: string; chatId: string; messageId: number; text: string; reasoning?: string }
    | undefined {
    for (const [generationId, active] of this.active) {
      const parts = active.target.read();
      return {
        id: generationId,
        chatId: active.target.chatId,
        messageId: active.target.messageId ?? 0,
        text: parts.filter((p) => p.type === 'text').map((p) => p.text).join(''),
        reasoning: parts.filter((p) => p.type === 'reasoning').map((p) => p.text).join('') || undefined,
      };
    }
    return undefined;
  }

  // ── Backend resolution ─────────────────────────────────────────────────

  /** Resolve settings, backend config, prompt list, and the adapter for a
      target. Honors target.backendOverride (sub-agents); wraps the adapter in
      the character-coupled contextual backend when the card provides one.
      Returns null when no backend is configured. */
  private async resolveBackend(target: GenerationTarget): Promise<ResolvedGenerationBackend | null> {
    const { settings, backendConfigs, promptLists, backendFactory } = this.deps;
    const allSettings = await settings.list();
    const configId = target.backendOverride ?? allSettings.activeBackendConfigId;
    const backendConfig = configId ? await backendConfigs.getById(configId) : null;
    const promptList = allSettings.activePromptListId
      ? await promptLists.getById(allSettings.activePromptListId)
      : null;
    const backendSettings = buildBackendSettings(allSettings, backendConfig);
    let backend: BackendAdapter | null;
    try {
      backend = await backendFactory.create(backendSettings);
    } catch (err) {
      // Unknown/misconfigured provider — loud in the log, NO_BACKEND to the
      // client (the legacy silent OpenAI fallthrough is gone).
      log.error(
        { err, provider: str(backendSettings['backendProvider']), backendConfigId: configId },
        'backend creation failed',
      );
      return null;
    }

    // Card-coupled contextual backend (scriptable-layers.md §2, Type B), applied
    // at this ONE point for every generation kind. Skipped when the active
    // config is itself a custom backend (explicit Type A selection wins).
    const backendScript = getCharacterBackendScript(target.character);
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
          characterId: target.character!.id,
          characterName: target.character!.name,
          luaSource: backendScript.luaSource,
          activeAdapter: backend,
        },
      );
    }

    if (!backend) return null;
    return { allSettings, backendConfig: backendConfig ?? null, promptList: promptList ?? null, backendSettings, backend };
  }

  // ── The loop ───────────────────────────────────────────────────────────

  async run(target: GenerationTarget, lock?: ChatLock, autoChain = 0): Promise<GenerationOutcome> {
    if (lock && lock.chatId !== target.chatId) {
      throw new Error(`cross-chat generation under a held lock is forbidden (lock: ${lock.chatId}, target: ${target.chatId})`);
    }
    const topLevel = lock === undefined;
    if (topLevel) {
      // Lifecycle callbacks run OUTSIDE the chat-mutex tenure: quick replies
      // acquire the chat lock fail-fast (tryLock), so firing them inside the
      // tenure made BEFORE_GENERATION/AI_MESSAGE triggers structurally unable
      // to run. Only top-level generations fire them.
      await this.lifecycleCallbacks?.onBeforeGeneration?.(target.chatId, target.clientId);
      await this.mutexFor(target.chatId).lock();
    }
    const held: ChatLock = { chatId: target.chatId };

    let completed = false;
    const generationId = randomUUID();
    try {
      const resolved = await this.resolveBackend(target);
      if (!resolved) {
        if (target.clientId) {
          this.deps.bus.sendTo(target.clientId, {
            type: 'error',
            message: 'No backend configured. Set API key and model in settings.',
            code: 'NO_BACKEND',
          });
        }
        return this.outcome(generationId, target, { finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 }, error: 'NO_BACKEND' });
      }

      await target.prepare();
      target.bindGeneration?.(generationId);

      let result: GenerationResult = { finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } };
      let recordCreated = false;
      let rounds = 0;
      const maxToolRounds = this.deps.maxToolRounds ?? 100;

      while (rounds < maxToolRounds) {
        const pending = target.pendingToolCalls();
        if (pending.length > 0 && this.deps.toolRegistry) {
          let turnEnds = false;
          for (const call of pending) {
            const outcome = await this.deps.toolRegistry.execute(call, {
              chatId: target.chatId,
              clientId: target.clientId,
              messages: await target.toolContextMessages(),
              // The held tenure + agent depth + this run's record id — pure
              // pass-through; the runner never branches on depth.
              lock: held,
              depth: target.depth ?? 0,
              generationId,
            });
            await target.writeToolOutcome(call, outcome);
            if (outcome.endsTurn === true) turnEnds = true;
          }
          // The outcomes are persisted, so their effects (e.g. a choices
          // widget) render immediately — but no follow-up round runs.
          if (turnEnds) break;
        } else if (rounds > 0) {
          break; // streamed, nothing pending → done
        }

        const prompt = await target.prompt(resolved);
        if (!recordCreated) {
          await this.deps.generations.create(generationId, {
            chatId: target.chatId,
            messageId: target.messageId,
            status: 'pending',
            backend: resolved.backend.id,
            promptTokens: prompt.tokenUsage.prompt,
            completionTokens: null,
            errorMessage: null,
            kind: target.kind,
            parentId: target.parentGenerationId ?? null,
          });
          recordCreated = true;
        }

        result = await this.streamRound(generationId, prompt, resolved, target);
        if (result.error) break;
        rounds++;
      }

      if (!result.error) {
        await target.finalize(result);
        if (recordCreated) {
          await this.deps.generations.update(generationId, {
            status: 'complete',
            messageId: target.messageId ?? undefined,
            completionTokens: result.usage.completionTokens,
          });
        }
        // Auto-continue: the target decides whether a follow-up is warranted
        // and hands back the continue target for it. Nested run under the
        // same tenure; its done broadcast lands before this run's, matching
        // the legacy ordering (inner executeGeneration completed first).
        if (autoChain < MAX_AUTO_CONTINUE_CHAIN && target.autoContinueTarget) {
          const next = await target.autoContinueTarget();
          if (next) await this.run(next, held, autoChain + 1);
        }
      }

      this.deps.generationBroadcast.broadcastGenerationDone(target.chatId, generationId, result.finishReason);
      completed = true;
      return this.outcome(generationId, target, result);
    } finally {
      if (topLevel) {
        this.unlockChat(target.chatId);
        // AI_MESSAGE quick replies run after release so they can acquire the
        // chat lock. Only on successful completion — errors/aborts don't
        // produce an "AI message".
        if (completed) await this.lifecycleCallbacks?.onAfterGeneration?.(target.chatId, target.clientId);
      }
    }
  }

  // ── Streaming engine ───────────────────────────────────────────────────

  /** One streaming round: announce, consume the backend stream into the
      target, return the final result. Error results and aborts are
      terminalized here (record + broadcasts + target.abort) — the caller
      breaks on result.error. */
  private async streamRound(
    generationId: string,
    prompt: Prompt,
    resolved: ResolvedGenerationBackend,
    target: GenerationTarget,
  ): Promise<GenerationResult> {
    const abortController = new AbortController();
    this.active.set(generationId, { abortController, target });

    try {
      await this.deps.generations.update(generationId, { status: 'streaming' });
      this.deps.generationBroadcast.broadcastGenerationStarted(target.chatId, generationId, target.messageId ?? undefined);

      const debugPrompts = Boolean(await this.deps.settings.get('debugPrompts'));
      if (debugPrompts) {
        this.deps.generationBroadcast.broadcastPromptAnnounced(target.chatId, generationId, prompt);
      }

      const stream = resolved.backend.stream(prompt, abortController.signal, {
        chatId: target.chatId,
        characterId: target.character?.id,
        generationType: target.kind,
        scriptState: findLatestStateSnapshot(resolved.backend.id, await target.toolContextMessages()),
      });
      let next = await stream.next();
      while (!next.done) {
        target.write(next.value);
        next = await stream.next();
      }
      const result = next.value;

      if (result.error) {
        await this.deps.generations.update(generationId, {
          status: 'error',
          errorMessage: result.error,
          completionTokens: result.usage.completionTokens,
        });
        log.error({ chatId: target.chatId, generationId, backend: resolved.backend.id, error: result.error }, 'generation failed');
        this.deps.generationBroadcast.broadcastGenerationError(target.chatId, generationId, result.error);
        return result;
      }

      // Hand the round's resolved tool calls to the target so its
      // pendingToolCalls() reflects them on the next loop iteration —
      // adapters report calls in the final GenerationResult, not as stream
      // items (targets dedupe by id against any streamed toolCall items).
      for (const tc of result.toolCalls ?? []) {
        target.write({ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.arguments });
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ err: error }, 'generation failed');
      const aborted = abortController.signal.aborted;
      await this.deps.generations.update(generationId, { status: aborted ? 'aborted' : 'error', errorMessage: error });
      if (aborted) {
        this.deps.generationBroadcast.broadcastGenerationAborted(target.chatId, generationId);
      } else {
        this.deps.generationBroadcast.broadcastGenerationError(target.chatId, generationId, error);
      }
      const result: GenerationResult = { finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 }, error };
      await target.abort(result);
      return result;
    } finally {
      this.active.delete(generationId);
    }
  }

  private outcome(generationId: string, target: GenerationTarget, result: GenerationResult): GenerationOutcome {
    return {
      generationId,
      chatId: target.chatId,
      messageId: target.messageId,
      text: target
        .read()
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join(''),
      finishReason: result.finishReason,
      error: result.error,
    };
  }
}

/** Re-exported so callers can type held tenures without importing two files. */
export type { ChatLock };
