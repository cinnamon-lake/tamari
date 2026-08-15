/**
 * Lightweight bus-level integration test harness.
 *
 * Spins up a real EventBus, real repositories (in-memory SQLite),
 * and a real dispatcher. Lets tests assert on broadcast messages
 * rather than poking individual functions.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { applyMigrations } from '../db/runMigrations.js';
import { EventBus, type ClientConnection } from '../bus/EventBus.js';
import { createDispatcher, type DispatcherDeps } from '../dispatcher.js';
import {
  CharacterRepository,
  CharacterAssetRepository,
  ChatRepository,
  SettingsRepository,
  WorldInfoRepository,
  GenerationRepository,
  PersonaRepository,
  BackendConfigRepository,
  PromptListRepository,
  ChatMemberRepository,
  AttachmentRepository,
  QuickReplyRepository,
  ToolsetRepository,
  ToolTemplateRepository,
  ExtensionDataRepository,
  CustomBackendRepository,
  ScriptBlobRepository,
} from '../repos/index.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { IWorldInfoRepository } from '../repos/WorldInfoRepository.js';
import { GenerationService } from '../services/GenerationService.js';
import { GenerationRunner } from '../generation/GenerationRunner.js';
import { ChatPromptAssembly } from '../generation/ChatPromptAssembly.js';
import type { BackendAdapterFactory } from '../backends/factory.js';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import { ToolRegistry } from '../services/ToolRegistry.js';
import { GroupChatService } from '../services/GroupChatService.js';
import { PersonaService } from '../services/PersonaService.js';
import { BackendConfigService } from '../services/BackendConfigService.js';
import { PromptListService } from '../services/PromptListService.js';
import { QuickReplyService } from '../scripting/QuickReplyService.js';
import { WorldInfoInjector } from '../pipeline/WorldInfoInjector.js';
import { PromptBuilder } from '../pipeline/PromptBuilder.js';
import { TokenCounter } from '../tokenizers/TokenCounter.js';
import { FileStorage } from '../services/FileStorage.js';
import { RAGService } from '../services/RAGService.js';
import { ChatBroadcastService } from '../services/ChatBroadcastService.js';
import { GenerationBroadcastService } from '../services/GenerationBroadcastService.js';
import { ChatMetaBroadcastService } from '../services/ChatMetaBroadcastService.js';
import { MockWebSocket } from './MockWebSocket.js';
import type { ServerMessage, ClientMessage, ClientMessageInput } from '@tamari/types';
import { ClientMessageSchema, QuickReplyAutoExecute } from '@tamari/types';
import type { WebSocket } from 'ws';

export interface TestClient {
  connection: ClientConnection;
  /** All ServerMessages sent to this client (broadcasts + direct) */
  messages: ServerMessage[];
}

/**
 * Inner repos + infrastructure handed to the `wrapRepos` hook, so tests can
 * build decorators that need them (e.g. UnpackedCardService + the read-through
 * repository wrappers, which must hold the INNER repos while everything else
 * gets the wrappers).
 */
export interface WrapReposContext {
  bus: EventBus;
  storage: FileStorage;
  /** The harness tmp dir — doubles as the server data dir. */
  dataDir: string;
  characters: CharacterRepository;
  characterAssets: CharacterAssetRepository;
  quickReplies: QuickReplyRepository;
  worldInfo: WorldInfoRepository;
  settings: SettingsRepository;
}

export interface TestHarnessOpts {
  backendFactory?: BackendAdapterFactory;
  toolRegistry?: ToolRegistry;
  /**
   * Optional hook to decorate the inner repos before any service is built.
   * Services (GenerationService, ChatPromptAssembly, …) capture repo references
   * at construction time, so wrappers must be installed here — overriding
   * `deps.characters` after construction would not reach them.
   */
  wrapRepos?: (ctx: WrapReposContext) => {
    characters?: ICharacterRepository;
    worldInfo?: IWorldInfoRepository;
  };
}

export class TestHarness {
  bus: EventBus;
  db: Client;
  dispatch: ReturnType<typeof createDispatcher>;
  deps: DispatcherDeps;
  extensionData: ExtensionDataRepository;
  /** Exposed for tests that register runner-dependent tool templates
      (run_agent) — the SAME instance the generation service delegates to,
      so sub-agent runs share the chat-mutex map. */
  generationRunner!: GenerationRunner;
  generationBroadcast!: GenerationBroadcastService;
  chatPromptAssembly!: ChatPromptAssembly;
  private tmpDir: string;
  private clients: TestClient[] = [];

  constructor(opts?: TestHarnessOpts) {
    this.tmpDir = mkdtempSync(join(tmpdir(), 'st-test-'));
    this.db = createClient({ url: `file:${join(this.tmpDir, 'test.db')}` });
    this.bus = new EventBus();

    const storage = new FileStorage(this.tmpDir);
    const characters = new CharacterRepository(this.db);
    const characterAssets = new CharacterAssetRepository(this.db);
    const chats = new ChatRepository(this.db);
    const settings = new SettingsRepository(this.db);
    const worldInfo = new WorldInfoRepository(this.db);
    const generations = new GenerationRepository(this.db);
    const personas = new PersonaRepository(this.db);
    const backendConfigs = new BackendConfigRepository(this.db);
    const promptLists = new PromptListRepository(this.db);
    const chatMembers = new ChatMemberRepository(this.db);
    const attachments = new AttachmentRepository(this.db);
    const quickReplies = new QuickReplyRepository(this.db);
    const toolsets = new ToolsetRepository(this.db);
    const toolTemplates = new ToolTemplateRepository(this.db);
    this.extensionData = new ExtensionDataRepository(this.db);
    const customBackends = new CustomBackendRepository(this.db);
    const scriptBlobs = new ScriptBlobRepository(this.db);
    const luaRuntime = new LuaRuntime();

    // Give the wrapRepos hook a chance to decorate the inner repos (e.g. the
    // unpacked-card read-through wrappers) BEFORE services capture them below.
    const wrappedRepos = opts?.wrapRepos?.({
      bus: this.bus,
      storage,
      dataDir: this.tmpDir,
      characters,
      characterAssets,
      quickReplies,
      worldInfo,
      settings,
    });
    const charactersRepo: ICharacterRepository = wrappedRepos?.characters ?? characters;
    const worldInfoRepo: IWorldInfoRepository = wrappedRepos?.worldInfo ?? worldInfo;

    const worldInfoInjector = new WorldInfoInjector();
    const tokenCounter = new TokenCounter();

    const chatMetaBroadcast = new ChatMetaBroadcastService({ bus: this.bus });

    const groupChatService = new GroupChatService(chatMembers, chats, chatMetaBroadcast, (_chatId) => {
      // No-op auto-trigger in tests — we don't want real generations.
    });

    const ragService = new RAGService(
      { enabled: false, apiUrl: '', apiKey: '', model: '', topK: 5, threshold: 0.7, chunkSize: 0 },
      this.tmpDir,
    );

    const chatBroadcast = new ChatBroadcastService({
      bus: this.bus,
      chats,
      characters: charactersRepo,
      personas,
      settings,
      characterAssets,
    });

    const generationBroadcast = new GenerationBroadcastService({ bus: this.bus });

    const chatPromptAssembly = new ChatPromptAssembly({
      chats,
      personas,
      attachments,
      storage,
      promptBuilder: new PromptBuilder(worldInfoInjector),
      worldInfo: worldInfoRepo,
      characterAssets,
      ragService,
      toolRegistry: opts?.toolRegistry,
      toolsetRepo: toolsets,
    });
    const generationRunner = new GenerationRunner({
      bus: this.bus,
      settings,
      generations,
      backendConfigs,
      promptLists,
      backendFactory: opts?.backendFactory ?? { create: async () => null },
      customBackends,
      scriptBlobs,
      luaRuntime,
      generationBroadcast,
      toolRegistry: opts?.toolRegistry,
    });
    this.generationRunner = generationRunner;
    this.generationBroadcast = generationBroadcast;
    this.chatPromptAssembly = chatPromptAssembly;

    const generationService = new GenerationService({
      bus: this.bus,
      chats,
      characters: charactersRepo,
      settings,
      personas,
      backendConfigs,
      promptLists,
      chatMembers,
      attachments,
      groupChatService,
      chatBroadcast,
      generationBroadcast,
      assembly: chatPromptAssembly,
      runner: generationRunner,
    });

    const quickReplyService = new QuickReplyService({
      bus: this.bus,
      generationService,
      chats,
      characters: charactersRepo,
      personas,
      settings,
      backendConfigs,
      promptLists,
      worldInfo: worldInfoRepo,
      quickReplies,
      chatMembers,
      extensionData: this.extensionData,
      chatBroadcast,
      chatMetaBroadcast,
    });

    generationService.setLifecycleCallbacks({
      onBeforeGeneration: (chatId, cid) =>
        quickReplyService.runAutoExecute(chatId, QuickReplyAutoExecute.BEFORE_GENERATION, cid ?? ''),
      onAfterGeneration: (chatId, cid) =>
        quickReplyService.runAutoExecute(chatId, QuickReplyAutoExecute.AI_MESSAGE, cid ?? ''),
    });

    const personaService = new PersonaService(personas, chats, storage);
    const backendConfigService = new BackendConfigService(backendConfigs, settings);
    const promptListService = new PromptListService(promptLists, settings);

    this.deps = {
      bus: this.bus,
      characters: charactersRepo,
      characterAssets,
      chats,
      settings,
      worldInfo: worldInfoRepo,
      personas,
      backendConfigs,
      promptLists,
      chatMembers,
      attachments,
      generationService,
      groupChatService,
      personaService,
      backendConfigService,
      promptListService,
      worldInfoInjector,
      tokenCounter,
      storage,
      quickReplyService,
      quickReplies,
      ragService,
      toolRegistry: opts?.toolRegistry,
      toolsets,
      toolTemplates,
      customBackends,
      luaRuntime,
      chatBroadcast,
      chatMetaBroadcast,
    };

    if (opts?.toolRegistry) {
      opts.toolRegistry.setToolsetRepository(toolsets);
      opts.toolRegistry.setTemplateRepository(toolTemplates);
    }

    this.dispatch = createDispatcher(this.deps);

    // Wire dispatch into bus for every client message type the schema accepts.
    // Derived from ClientMessageSchema so registration can never drift from
    // validation (an unlisted type would be silently dropped by the bus).
    for (const option of ClientMessageSchema.options) {
      this.bus.registerHandler(option.shape.type.value, this.dispatch);
    }
  }

  /**
   * Initialise the SQLite schema by running migrations.
   * Must be called before any repository operations.
   */
  async initSchema(): Promise<void> {
    await this.db.execute('PRAGMA journal_mode = WAL');
    await this.db.execute('PRAGMA foreign_keys = ON');

    // Apply the real production migrations (db/migrations/*.sql) so the
    // harness always runs the same schema as the server.
    await applyMigrations(this.db);
  }

  /**
   * Connect a mock client to the bus and return a handle.
   * The client is automatically authenticated.
   */
  connectClient(): TestClient {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const connection = this.bus.addClient(ws);
    connection.authenticated = true;

    const client: TestClient = {
      connection,
      messages: [],
    };

    // Intercept all messages sent to this client's WebSocket.
    const originalSend = ws.send.bind(ws);
    ws.send = (data: string) => {
      originalSend(data);
      try {
        client.messages.push(JSON.parse(data) as ServerMessage);
      } catch {
        // ignore non-JSON
      }
    };

    this.clients.push(client);
    return client;
  }

  /**
   * Send a ClientMessage through the bus for a given client.
   * Accepts the wire shape (schema-defaulted fields omittable); unlike
   * production (main.ts) the harness does not run Zod boundary validation,
   * so the dispatcher sees the message as sent.
   */
  async send(client: TestClient, msg: ClientMessageInput): Promise<void> {
    await this.bus.dispatch(client.connection, msg as ClientMessage);
  }

  /**
   * Find the most recent broadcast of a given type.
   */
  lastBroadcast<T extends ServerMessage['type']>(
    type: T,
    originator?: TestClient,
  ): Extract<ServerMessage, { type: T }> | undefined {
    const msgs = originator ? originator.messages : this.clients.flatMap((c) => c.messages);
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.type === type) {
        return msgs[i] as Extract<ServerMessage, { type: T }>;
      }
    }
    return undefined;
  }

  /**
   * Assert that a broadcast of the given type was sent.
   */
  expectBroadcast<T extends ServerMessage['type']>(
    type: T,
    originator?: TestClient,
  ): Extract<ServerMessage, { type: T }> {
    const found = this.lastBroadcast(type, originator);
    if (!found) {
      const allTypes = (originator ? originator.messages : this.clients.flatMap((c) => c.messages)).map(
        (m) => m.type,
      );
      throw new Error(`Expected broadcast '${type}' but got: [${allTypes.join(', ')}]`);
    }
    return found;
  }

  /**
   * Clean up temporary directory and DB.
   */
  async teardown(): Promise<void> {
    this.bus.closeAll();
    rmSync(this.tmpDir, { recursive: true, force: true });
    // libsql in-memory client has no explicit close in all versions.
  }
}
