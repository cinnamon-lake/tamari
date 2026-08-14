/**
 * TestSessionService — interactive, stateful card-testing sessions behind the
 * test_session_* MCP tools (and the rebuilt test_card).
 *
 * A session is a synthetic in-memory chat (InMemoryChatRepository /
 * InMemoryGenerationRepository, no DB rows, no UI broadcasts) driven through
 * the REAL production generation path: a second GenerationRunner instance
 * sharing the production deps (settings, backend configs, backend factory,
 * read-through characters, tool registry, prompt assembly pipeline) but
 * wired to the in-memory repos and no-op broadcasts. Prompt assembly runs
 * fully (prompt lists, regex, lorebook/RAG, memory) and every turn captures
 * its prompts into the generation meta (target-level capturePrompts — no
 * global debugPrompts flip).
 *
 * Flow: start (greeting materialized) → message (user message + one
 * generation) → state (chain / generations / script state) → end. Sessions
 * expire after 30 min idle (lazy prune on any op, SlidingWindowRateLimiter
 * idiom) and are capped at MAX_SESSIONS with LRU eviction.
 *
 * All public methods validate their args and THROW on failure; MCP-facing
 * callers wrap them with toToolResult() to get CardTestService-style
 * `Error: ...`-prefixed content strings.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getMessageText } from '@tamari/types';
import type { Generation } from '@tamari/types';
import { EventBus } from '../bus/EventBus.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { IPromptListRepository } from '../repos/PromptListRepository.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { IChatMemberRepository } from '../repos/ChatMemberRepository.js';
import type { IAttachmentRepository } from '../repos/AttachmentRepository.js';
import type { IWorldInfoRepository } from '../repos/WorldInfoRepository.js';
import type { ICharacterAssetRepository } from '../repos/CharacterAssetRepository.js';
import type { IToolsetRepository } from '../repos/ToolsetRepository.js';
import type { ICustomBackendRepository } from '../repos/CustomBackendRepository.js';
import type { IScriptBlobRepository } from '../repos/ScriptBlobRepository.js';
import type { BackendAdapterFactory } from '../backends/factory.js';
import type { LuaRuntime } from '../scripting/LuaRuntime.js';
import type { ToolRegistry } from './ToolRegistry.js';
import type { ToolExecuteResult } from './ToolTemplate.js';
import type { RAGService } from './RAGService.js';
import type { MemoryService } from './MemoryService.js';
import type { FileStorage } from './FileStorage.js';
import type { PromptBuilder } from '../pipeline/PromptBuilder.js';
import type { UnpackedCardService } from './unpacked/UnpackedCardService.js';
import { unpackedCardId } from './unpacked/unpackedIds.js';
import { materializeGreetings } from '../lib/greetings.js';
import { findLatestStateSnapshot } from './toolState.js';
import { GenerationRunner, type GenerationOutcome } from '../generation/GenerationRunner.js';
import { ChatPromptAssembly } from '../generation/ChatPromptAssembly.js';
import { AssistantMessageTarget, type AssistantMessageTargetDeps } from '../generation/AssistantMessageTarget.js';
import { InMemoryChatRepository } from '../testing/InMemoryChatRepository.js';
import { InMemoryGenerationRepository } from '../testing/InMemoryGenerationRepository.js';
import { NoOpChatBroadcastService, NoOpGenerationBroadcastService } from '../testing/NoOpBroadcastServices.js';

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 20;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;

export const TestSessionStartArgs = z
  .object({
    characterId: z.string().optional(),
    folderPath: z.string().optional(),
    personaId: z.string().optional(),
    greetingIndex: z.number().int().min(0).optional(),
    backendConfigId: z.string().optional(),
  })
  .refine((d) => d.characterId !== undefined || d.folderPath !== undefined, {
    message: 'provide characterId or folderPath',
  });

export const TestSessionMessageArgs = z.object({
  sessionId: z.string(),
  content: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
});

export const TestSessionStateArgs = z.object({
  sessionId: z.string(),
  generationId: z.string().optional(),
});

export const TestSessionEndArgs = z.object({
  sessionId: z.string(),
});

export interface TestSessionStartResult {
  sessionId: string;
  characterId: string;
  characterName: string;
  greeting: string;
}

export interface TestSessionMessageResult {
  reply: string;
  generationId: string;
  finishReason: string;
  scriptState?: unknown;
  debug?: string;
}

export interface TestSessionServiceDeps {
  settings: ISettingsRepository;
  backendConfigs: IBackendConfigRepository;
  promptLists: IPromptListRepository;
  backendFactory: BackendAdapterFactory;
  customBackends: ICustomBackendRepository;
  scriptBlobs: IScriptBlobRepository;
  luaRuntime: LuaRuntime;
  characters: ICharacterRepository;
  personas: IPersonaRepository;
  chatMembers: IChatMemberRepository;
  unpackedCards: UnpackedCardService;
  // Shared with the production ChatPromptAssembly (everything except the
  // chat repo, which is the in-memory session substrate).
  attachments: IAttachmentRepository;
  storage: FileStorage;
  promptBuilder: PromptBuilder;
  worldInfo: IWorldInfoRepository;
  characterAssets: ICharacterAssetRepository;
  ragService?: RAGService;
  memoryService?: MemoryService;
  toolRegistry?: ToolRegistry;
  toolsetRepo?: IToolsetRepository;
  maxToolRounds?: number;
}

interface TestSession {
  id: string;
  chatId: string;
  characterId: string;
  backendConfigId?: string;
  lastActiveAt: number;
}

/** Run a session call, returning CardTestService-style content (`Error: …` on failure). */
export async function toToolResult(call: Promise<unknown>): Promise<ToolExecuteResult> {
  try {
    return { content: JSON.stringify(await call, null, 2) };
  } catch (e) {
    return { content: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

export class TestSessionService {
  private readonly bus = new EventBus();
  private readonly chats = new InMemoryChatRepository();
  private readonly generations = new InMemoryGenerationRepository();
  private readonly chatBroadcast = new NoOpChatBroadcastService();
  private readonly generationBroadcast = new NoOpGenerationBroadcastService();
  private readonly assembly: ChatPromptAssembly;
  private readonly runner: GenerationRunner;
  /** Insertion-ordered — the first entry is the least recently touched. */
  private readonly sessions = new Map<string, TestSession>();

  constructor(private deps: TestSessionServiceDeps) {
    this.assembly = new ChatPromptAssembly({
      chats: this.chats,
      personas: deps.personas,
      attachments: deps.attachments,
      storage: deps.storage,
      promptBuilder: deps.promptBuilder,
      worldInfo: deps.worldInfo,
      characterAssets: deps.characterAssets,
      ragService: deps.ragService,
      memoryService: deps.memoryService,
      toolRegistry: deps.toolRegistry,
      toolsetRepo: deps.toolsetRepo,
    });
    this.runner = new GenerationRunner({
      bus: this.bus,
      settings: deps.settings,
      generations: this.generations,
      backendConfigs: deps.backendConfigs,
      promptLists: deps.promptLists,
      backendFactory: deps.backendFactory,
      customBackends: deps.customBackends,
      scriptBlobs: deps.scriptBlobs,
      luaRuntime: deps.luaRuntime,
      generationBroadcast: this.generationBroadcast,
      toolRegistry: deps.toolRegistry,
      maxToolRounds: deps.maxToolRounds,
    });
  }

  // ---- Session lifecycle ----

  async start(rawArgs: Record<string, unknown>): Promise<TestSessionStartResult> {
    const args = this.parse(TestSessionStartArgs, rawArgs);
    this.prune();

    // Resolve the card (folderPath = an active unpacked card folder).
    let characterId = args.characterId;
    if (characterId === undefined && args.folderPath !== undefined) {
      const abs = path.resolve(this.deps.unpackedCards.rootDir, args.folderPath);
      characterId = unpackedCardId(path.basename(abs));
      if (!this.deps.unpackedCards.has(characterId)) {
        throw new Error(`no active unpacked card at ${args.folderPath} (is unpackedCards.enabled on, and does the folder parse?)`);
      }
    }
    const character = characterId !== undefined ? await this.deps.characters.getById(characterId) : undefined;
    if (!character || characterId === undefined) throw new Error(`character not found: ${characterId ?? args.folderPath}`);

    // Persona: explicit arg, else the first persona (chatHandlers.ts:115-119).
    let personaId = args.personaId ?? null;
    if (!personaId) {
      const first = (await this.deps.personas.listSummaries())[0];
      personaId = first?.id ?? null;
    }

    const sessionId = randomUUID();
    const chatId = `test-session-${sessionId}`;
    const greetingIndex = args.greetingIndex ?? 0;
    await this.chats.createChat(chatId, {
      characterId,
      personaId,
      name: `test_session ${character.name}`,
      headMessageId: null,
      metadata: { selectedGreetingIndex: greetingIndex },
    });
    await materializeGreetings(
      {
        bus: this.bus,
        chats: this.chats,
        chatBroadcast: this.chatBroadcast,
        assets: this.deps.characterAssets,
        personas: this.deps.personas,
        userName: (await this.deps.settings.get('userName')) as string | undefined,
      },
      chatId,
      character,
      greetingIndex,
    );

    const greeting = await this.greetingText(chatId);
    this.sessions.set(sessionId, {
      id: sessionId,
      chatId,
      characterId,
      ...(args.backendConfigId !== undefined ? { backendConfigId: args.backendConfigId } : {}),
      lastActiveAt: Date.now(),
    });
    this.evictOverCap();
    return { sessionId, characterId, characterName: character.name, greeting };
  }

  async message(rawArgs: Record<string, unknown>): Promise<TestSessionMessageResult> {
    const args = this.parse(TestSessionMessageArgs, rawArgs);
    const session = this.requireSession(args.sessionId);
    const chat = await this.chats.getChatById(session.chatId);
    const character = (await this.deps.characters.getById(session.characterId)) ?? null;

    await this.chats.appendMessage(session.chatId, {
      role: 'user',
      extra: {
        ...(chat?.personaId ? { personaId: chat.personaId } : {}),
        parts: [{ type: 'text', text: args.content }],
      },
    });

    const target = AssistantMessageTarget.forNewMessage(
      {
        chatId: session.chatId,
        character,
        ...(session.backendConfigId !== undefined ? { backendOverride: session.backendConfigId } : {}),
        capturePrompts: true,
      },
      this.targetDeps(),
    );

    const timeoutMs = args.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const runPromise = this.runner.run(target);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        runPromise,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);
      if (outcome === 'timeout') {
        // Direct abort — no WS action.stop round-trip. The run settles with an
        // abort outcome once the backend notices the signal.
        const inFlight = await this.inFlightGenerationId(session.chatId);
        if (inFlight !== undefined) this.runner.handleStop(inFlight);
        const settled = await runPromise.catch(() => undefined);
        throw new Error(
          `generation timed out after ${timeoutMs}ms (${settled?.generationId ?? inFlight ?? 'unknown'})`,
        );
      }
      return this.turnResult(session.chatId, outcome);
    } finally {
      clearTimeout(timer);
    }
  }

  async state(rawArgs: Record<string, unknown>): Promise<unknown> {
    const args = this.parse(TestSessionStateArgs, rawArgs);
    const session = this.requireSession(args.sessionId);

    // Opt-in full record: the read_generation equivalent for sessions
    // (prompts can be big, so they only come back on explicit request).
    if (args.generationId !== undefined) {
      const generation = await this.generations.getById(args.generationId);
      if (!generation || generation.chatId !== session.chatId) {
        throw new Error(`generation not found in this session: ${args.generationId}`);
      }
      return { generation };
    }

    const chain = await this.chats.getMessageChain(session.chatId);
    const generations = await this.generations.listByChat(session.chatId);
    return {
      sessionId: session.id,
      characterId: session.characterId,
      messages: chain.map((m) => ({ id: m.id, role: m.role, text: getMessageText(m.extra.parts) })),
      generations: generations.map((g) => ({
        id: g.id,
        status: g.status,
        kind: g.kind,
        errorMessage: g.errorMessage,
        meta: g.meta ? stripPrompts(g.meta) : null,
      })),
      scriptState: await this.scriptState(session.chatId),
    };
  }

  async end(rawArgs: Record<string, unknown>): Promise<{ ended: true }> {
    const args = this.parse(TestSessionEndArgs, rawArgs);
    this.prune();
    const session = this.sessions.get(args.sessionId);
    if (!session) throw new Error(`unknown session: ${args.sessionId}`);
    await this.dropSession(session);
    return { ended: true };
  }

  // ---- Internals ----

  private targetDeps(): AssistantMessageTargetDeps {
    return {
      chats: this.chats,
      characters: this.deps.characters,
      chatMembers: this.deps.chatMembers,
      personas: this.deps.personas,
      settings: this.deps.settings,
      backendConfigs: this.deps.backendConfigs,
      chatBroadcast: this.chatBroadcast,
      generationBroadcast: this.generationBroadcast,
      assembly: this.assembly,
    };
  }

  private parse<S extends z.ZodType>(schema: S, rawArgs: Record<string, unknown>): z.infer<S> {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) throw new Error(`invalid arguments — ${formatZodError(parsed.error)}`);
    return parsed.data;
  }

  /** Prune idle sessions, then look the session up and mark it active. */
  private requireSession(sessionId: string): TestSession {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId} (sessions expire after ${SESSION_TTL_MS / 60000} min idle)`);
    session.lastActiveAt = Date.now();
    // Refresh LRU order (Map preserves insertion order).
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Lazy TTL eviction — pruned on any op, like SlidingWindowRateLimiter. */
  private prune(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastActiveAt > SESSION_TTL_MS) {
        void this.dropSession(session);
      }
    }
  }

  /** LRU eviction once over the session cap. */
  private evictOverCap(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      const session = this.sessions.get(oldest);
      if (!session) break;
      void this.dropSession(session);
    }
  }

  /** Abort any in-flight generation and drop all session state. The map
      delete is synchronous so LRU/TTL eviction loops see the shrinkage. */
  private async dropSession(session: TestSession): Promise<void> {
    this.sessions.delete(session.id);
    const inFlight = await this.inFlightGenerationId(session.chatId);
    if (inFlight !== undefined) this.runner.handleStop(inFlight);
    await this.chats.deleteChat(session.chatId);
    this.generations.deleteByChat(session.chatId);
  }

  /** The session chat's in-flight generation, if any (pending/streaming). */
  private async inFlightGenerationId(chatId: string): Promise<string | undefined> {
    const generations = await this.generations.listByChat(chatId);
    return generations.find((g) => g.status === 'pending' || g.status === 'streaming')?.id;
  }

  private async greetingText(chatId: string): Promise<string> {
    const chain = await this.chats.getMessageChain(chatId);
    const last = chain[chain.length - 1];
    return last ? getMessageText(last.extra.parts) : '';
  }

  /** The turn's result: reply text + the persisted debug/script-state reads. */
  private async turnResult(chatId: string, outcome: GenerationOutcome): Promise<TestSessionMessageResult> {
    if (outcome.error !== undefined) {
      throw new Error(`generation failed (${outcome.generationId}): ${outcome.error}`);
    }
    const message = outcome.messageId !== null ? await this.chats.getMessageById(outcome.messageId) : undefined;
    const debug = (message?.extra.parts ?? [])
      .filter((p) => p.type === 'backend_debug')
      .map((p) => p.text)
      .join('');
    const scriptState = await this.scriptState(chatId);
    return {
      reply: outcome.text,
      generationId: outcome.generationId,
      finishReason: outcome.finishReason,
      ...(scriptState !== undefined ? { scriptState } : {}),
      ...(debug ? { debug } : {}),
    };
  }

  /** The card's Lua state: latest _toolState snapshot on the in-memory chain,
      keyed by the streaming backend's id (the generation meta's layer). */
  private async scriptState(chatId: string): Promise<unknown> {
    const generations = await this.generations.listByChat(chatId);
    const layer = generations.map((g) => g.meta?.layer).find((l) => l !== undefined);
    if (layer === undefined) return undefined;
    const chain = await this.chats.getMessageChain(chatId);
    const snapshot = findLatestStateSnapshot(layer, chain);
    if (snapshot === undefined) return undefined;
    try {
      return JSON.parse(snapshot) as unknown;
    } catch {
      return snapshot;
    }
  }
}

/** Generation meta minus the (potentially huge) captured prompts. */
function stripPrompts(meta: NonNullable<Generation['meta']>): Generation['meta'] {
  const { prompt: _prompt, prompts: _prompts, ...rest } = meta;
  return rest;
}
