/**
 * tamari Server Entry Point
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { loadEnvFile } from './envFile.js';
import { canPromptInteractively, promptAndPersistSecret } from './secretPrompt.js';
import { initDatabase } from './db/index.js';
import { ProfiledClient } from './db/profiler.js';
import { EventBus } from './bus/EventBus.js';
import {
  CharacterRepository,
  CharacterAssetRepository,
  ChatRepository,
  CachedSettings,
  WorldInfoRepository,
  GenerationRepository,
  SecretRepository,
  PersonaRepository,
  BackendConfigRepository,
  PromptListRepository,
  ChatMemberRepository,
  AttachmentRepository,
  ToolsetRepository,
  ToolTemplateRepository,
  ExtensionDataRepository,
  CustomBackendRepository,
  ScriptBlobRepository,
} from './repos/index.js';
import type { ISettingsRepository } from './repos/SettingsRepository.js';
import type { ICharacterRepository } from './repos/CharacterRepository.js';
import type { IWorldInfoRepository } from './repos/WorldInfoRepository.js';
import { UnpackedCardService } from './services/unpacked/UnpackedCardService.js';
import { CardTestService } from './services/CardTestService.js';
import { TestSessionService } from './services/TestSessionService.js';
import { createMcpRouter } from './api/mcp.js';
import { ReadThroughCharacterRepository } from './services/unpacked/ReadThroughCharacterRepository.js';
import { ReadThroughWorldInfoRepository } from './services/unpacked/ReadThroughWorldInfoRepository.js';
import { createDispatcher } from './dispatcher.js';
import { QuickReplyRepository } from './repos/QuickReplyRepository.js';
import { QuickReplyService } from './scripting/QuickReplyService.js';
import { createCharacterRouter } from './api/characters.js';
import { createModelsRouter } from './api/models.js';
import { createAttachmentDownloadRouter, createAttachmentsRouter } from './api/attachments.js';
import { createPersonasRouter } from './api/personas.js';
import { createFilesRouter } from './api/files.js';
import { createMaidRouter } from './api/maid.js';
import { createSecretsRouter } from './api/secrets.js';
import { createStatsRouter } from './api/stats.js';
import { createChatsRouter } from './api/chats.js';

import { GenerationService } from './services/GenerationService.js';
import { GenerationRunner } from './generation/GenerationRunner.js';
import { ChatPromptAssembly } from './generation/ChatPromptAssembly.js';
import { MemoryService } from './services/MemoryService.js';
import { ChatBroadcastService } from './services/ChatBroadcastService.js';
import { GenerationBroadcastService } from './services/GenerationBroadcastService.js';
import { ChatMetaBroadcastService } from './services/ChatMetaBroadcastService.js';
import { ToolRegistry } from './services/ToolRegistry.js';
import { LuaToolExecutor } from './services/LuaToolExecutor.js';
import { registerAssetsTemplate } from './services/templates/AssetsTemplate.js';
import { registerAgentTemplate } from './services/templates/AgentTemplate.js';
import { registerLuaRunnerTemplate } from './services/templates/LuaRunnerTemplate.js';
import { registerForgeImageTemplate } from './services/templates/ForgeImageTemplate.js';
import { registerSpeakTemplate } from './services/templates/SpeakTemplate.js';
import { registerMemoryToolTemplate } from './services/templates/MemoryToolTemplate.js';
import { registerSceneTemplate } from './services/templates/SceneTemplate.js';
import { registerChatWorkbenchTemplate } from './services/templates/ChatWorkbenchTemplate.js';
import { registerDocsTemplate } from './services/templates/DocsTemplate.js';
import { CharacterWorkbench } from './services/workbench/CharacterWorkbench.js';
import { BackendWorkbench } from './services/workbench/BackendWorkbench.js';
import { ToolsetWorkbench } from './services/workbench/ToolsetWorkbench.js';
import { QuickReplyWorkbench } from './services/workbench/QuickReplyWorkbench.js';
import { LuaToolWorkbench } from './services/workbench/LuaToolWorkbench.js';
import { registerWorkbenchTemplate } from './services/templates/workbench/WorkbenchTemplate.js';


import { LuaRuntime } from './scripting/LuaRuntime.js';
import { seedToolTemplates } from './db/seeds/toolTemplateSeeds.js';
import { GroupChatService } from './services/GroupChatService.js';
import { PersonaService } from './services/PersonaService.js';
import { BackendConfigService } from './services/BackendConfigService.js';
import { PromptListService } from './services/PromptListService.js';
import { PromptBuilder } from './pipeline/PromptBuilder.js';
import { WorldInfoInjector } from './pipeline/WorldInfoInjector.js';
import { loadDefaultConfigs } from './lib/loadDefaultConfigs.js';
const worldInfoInjector = new WorldInfoInjector();
import { TokenCounter } from './tokenizers/TokenCounter.js';
const tokenCounter = new TokenCounter();
import { createBackendAdapter, buildAdapterFactoryInput } from './backends/factory.js';
import { createCustomBackendAdapter, customBackendSelectionFromSettings } from './backends/customBackendFactory.js';
import { SecretService } from './services/SecretService.js';
import { resolveSecretSettings } from './services/SecretResolver.js';
import { StatsService } from './services/StatsService.js';
import { DataMaid } from './services/DataMaid.js';
import { FileStorage } from './services/FileStorage.js';
import { RAGService } from './services/RAGService.js';
import { getRAGConfig } from './services/ragConfig.js';
import { getProxySettings, initProxy } from './proxy.js';
import { ClientMessageSchema, QuickReplyAutoExecute } from '@tamari/types';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resizeThumbnail } from './lib/avatar.js';
import { str } from './lib/coerce.js';
import { getLogger } from './lib/logger.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { withLogging } from './lib/repoLogger.js';
import { AuthService } from './services/AuthService.js';
import { createAuthMiddleware } from './middleware/auth.js';

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = getLogger('main');

// Load .env (real environment variables always win), then bootstrap
// TAMARI_SECRET: on the first interactive run the user chooses a password
// and it is persisted to .env (see secretPrompt.ts).
loadEnvFile(join(process.cwd(), '.env'));
if (!process.env.TAMARI_SECRET && !process.env.SILLYTAVERN_SECRET && canPromptInteractively()) {
  await promptAndPersistSecret();
}

const config = loadConfig();

// Authentication service
const auth = new AuthService(config.secret);

// Without a persistent secret (non-interactive run with nothing set), bearer
// tokens and vault-encrypted API keys die with the process — say so honestly.
if (!process.env.TAMARI_SECRET && !process.env.SILLYTAVERN_SECRET) {
  log.warn('No TAMARI_SECRET set and no terminal to prompt for one — using a random secret.');
  log.warn('Bearer tokens and vault-encrypted API keys will NOT survive a restart.');
  log.warn('Set TAMARI_SECRET in your environment or .env to fix this.');
}

// Ensure data directory exists
mkdirSync(dirname(config.dbPath), { recursive: true });

// File storage for avatars and attachments
const storage = new FileStorage(config.dataDir);

// Initialize SQLite
const db = await initDatabase({ path: config.dbPath, dataDir: config.dataDir });
// Database ready

// Repositories
// Unpacked (on-disk) cards: these stay the INNER repos. Everything below sees
// the read-through wrappers constructed after the bus/RAG service exist; only
// UnpackedCardService holds the inner repos (it owns handle-row writes and
// delete-time cleanup, which the wrappers reject).
const innerCharacters = withLogging(new CharacterRepository(db), 'characters');
const characterAssets = withLogging(new CharacterAssetRepository(db), 'characterAssets');
const chats = withLogging(new ChatRepository(db), 'chats');
const settings = withLogging(new CachedSettings(db), 'settings');
const innerWorldInfo = withLogging(new WorldInfoRepository(db), 'worldInfo');
const generations = withLogging(new GenerationRepository(db), 'generations');
const personas = withLogging(new PersonaRepository(db), 'personas');
const backendConfigs = withLogging(new BackendConfigRepository(db), 'backendConfigs');
const promptLists = withLogging(new PromptListRepository(db), 'promptLists');
const chatMembers = withLogging(new ChatMemberRepository(db), 'chatMembers');
const extensionData = withLogging(new ExtensionDataRepository(db), 'extensionData');
const attachments = withLogging(new AttachmentRepository(db), 'attachments');
const customBackends = withLogging(new CustomBackendRepository(db), 'customBackends');
const scriptBlobs = withLogging(new ScriptBlobRepository(db), 'scriptBlobs');
const secrets = withLogging(new SecretRepository(db), 'secrets');
const secretService = new SecretService(secrets);

// Backend factory wrapper: resolve `secret:<key>` references against the vault
// (unlocked with the app login secret) before constructing the adapter.
// Provider `custom` resolves a Lua-driven custom backend from the registry
// (scriptable-layers.md §2); depth is the custom→custom delegation level.
const createBackendAdapterResolved = async (backendSettings: Record<string, unknown>, depth = 0) => {
  await resolveSecretSettings(backendSettings, secretService, config.secret);
  const customSelection = customBackendSelectionFromSettings(backendSettings);
  if (customSelection) {
    return createCustomBackendAdapter(
      { customBackends, backendConfigs, settings, luaRuntime, scriptBlobs, createResolvedAdapter: createBackendAdapterResolved },
      customSelection.customBackendId,
      customSelection.delegateConfigId,
      depth,
    );
  }
  return createBackendAdapter(buildAdapterFactoryInput(backendSettings));
};
const quickReplies = withLogging(new QuickReplyRepository(db), 'quickReplies');
const toolsets = withLogging(new ToolsetRepository(db), 'toolsets');
const toolTemplates = withLogging(new ToolTemplateRepository(db), 'toolTemplates');

// Ensure at least one backend config and prompt list exist
await ensureDefaultBackendConfig(backendConfigs, settings);
await ensureDefaultPromptList(promptLists, settings);

// Ensure at least one persona exists
await ensureDefaultPersona(personas);

// Initialize system proxy from settings (or env vars)
const allSettings = await settings.list();
await initProxy(getProxySettings(allSettings));

// Event bus
const bus = new EventBus();

const chatMetaBroadcast = new ChatMetaBroadcastService({ bus });

// Group chat service
const groupChatService = new GroupChatService(chatMembers, chats, chatMetaBroadcast, (chatId) => {
  // Auto-mode trigger: generate group member responses without appending a user message
  generationService.triggerGroupResponses(chatId).catch((err) => {
    log.error({ err }, 'auto-mode: error triggering group responses');
  });
});

// RAG service
const ragService = new RAGService(getRAGConfig(allSettings), config.dataDir);

// Unpacked-card loader + read-through wrappers. Constructed here because it
// needs the bus and RAG service; every consumer below (dispatcher deps,
// workbenches, generation, REST) gets the wrappers.
const unpackedCards = new UnpackedCardService({
  characters: innerCharacters,
  characterAssets,
  quickReplies,
  storage,
  bus,
  settings,
  ragService,
  dataDir: config.dataDir,
});
const characters: ICharacterRepository = withLogging(new ReadThroughCharacterRepository(innerCharacters, unpackedCards), 'characters');
const worldInfo: IWorldInfoRepository = withLogging(new ReadThroughWorldInfoRepository(innerWorldInfo, unpackedCards), 'worldInfo');

// Memory service
const memoryService = new MemoryService({
  chats,
  settings,
  backendConfigs,
  backendFactory: { create: createBackendAdapterResolved },
});

// Generation service
const toolRegistry = new ToolRegistry();
toolRegistry.setToolsetRepository(toolsets);
toolRegistry.setTemplateRepository(toolTemplates);
const luaRuntime = new LuaRuntime();
const luaToolExecutor = new LuaToolExecutor(luaRuntime, { storage, attachments });
toolRegistry.setLuaToolExecutor(luaToolExecutor);
registerAssetsTemplate(toolRegistry, { assets: characterAssets, chats });
registerMemoryToolTemplate(toolRegistry, { memoryService });
registerLuaRunnerTemplate(toolRegistry, { luaRuntime });
registerForgeImageTemplate(toolRegistry, { storage, attachments });
registerSpeakTemplate(toolRegistry, { storage, attachments, secretService, secretsPassword: config.secret });
registerSceneTemplate(toolRegistry, { chats, characters, characterAssets, chatMembers });
registerChatWorkbenchTemplate(toolRegistry, { chats, characters, chatMembers, chatMetaBroadcast });
registerDocsTemplate(toolRegistry);

// The five workbench providers behind the single filesystem-style `workbench` template.
const characterWorkbench = new CharacterWorkbench({ characters, worldInfo, settings, attachments, characterAssets, storage, bus, luaRuntime, ragService });
const backendWorkbench = new BackendWorkbench({ backendConfigs, settings, bus, secretService, secretsPassword: config.secret, customBackends, luaRuntime });
const toolsetWorkbench = new ToolsetWorkbench({ toolsets, toolRegistry, bus });
const quickReplyWorkbench = new QuickReplyWorkbench({ quickReplies, bus });
const luaToolWorkbench = new LuaToolWorkbench({ toolTemplates, luaExecutor: luaToolExecutor, registry: toolRegistry, bus });
// Card-testing sessions (test_card + test_session_*): a second generation
// runner over in-memory repos sharing the production deps — no DB rows, no
// UI broadcasts. Needs promptBuilder, so it is constructed here (the real
// ChatPromptAssembly below reuses the same builder).
const promptBuilder = new PromptBuilder(worldInfoInjector);
const testSessions = new TestSessionService({
  settings,
  backendConfigs,
  promptLists,
  backendFactory: { create: createBackendAdapterResolved },
  customBackends,
  scriptBlobs,
  luaRuntime,
  characters,
  personas,
  chatMembers,
  unpackedCards,
  attachments,
  storage,
  promptBuilder,
  worldInfo,
  characterAssets,
  ragService,
  memoryService,
  toolRegistry,
  toolsetRepo: toolsets,
  maxToolRounds: config.maxToolRounds,
});
const cardTest = new CardTestService({ testSessions });
const workbenchTemplate = registerWorkbenchTemplate(toolRegistry, { characterWorkbench, backendWorkbench, toolsetWorkbench, quickReplyWorkbench, luaToolWorkbench, generations, cardTest });


await seedToolTemplates(toolTemplates);

const chatBroadcast = new ChatBroadcastService({
  bus,
  chats,
  characters,
  personas,
  settings,
  characterAssets,
});

const generationBroadcast = new GenerationBroadcastService({ bus });

const chatPromptAssembly = new ChatPromptAssembly({
  chats,
  personas,
  attachments,
  storage,
  promptBuilder,
  worldInfo,
  characterAssets,
  ragService,
  memoryService,
  toolRegistry,
  toolsetRepo: toolsets,
});
const generationRunner = new GenerationRunner({
  bus,
  settings,
  generations,
  backendConfigs,
  promptLists,
  backendFactory: { create: createBackendAdapterResolved },
  customBackends,
  scriptBlobs,
  luaRuntime,
  generationBroadcast,
  toolRegistry,
  maxToolRounds: config.maxToolRounds,
});

const generationService = new GenerationService({
  bus,
  chats,
  characters,
  settings,
  personas,
  backendConfigs,
  chatMembers,
  attachments,
  groupChatService,
  chatBroadcast,
  generationBroadcast,
  assembly: chatPromptAssembly,
  runner: generationRunner,
});

// Sub-agent spawn tool (run_agent) — needs the runner, so it registers after construction.
registerAgentTemplate(toolRegistry, {
  runner: generationRunner,
  targetDeps: {
    chats,
    generationBroadcast,
    assembly: chatPromptAssembly,
    toolRegistry,
    toolsetRepo: toolsets,
    maxAgentDepth: config.maxAgentDepth,
  },
  generations,
  maxAgentDepth: config.maxAgentDepth,
});

const quickReplyService = new QuickReplyService({
  bus,
  generationService,
  chats,
  characters,
  personas,
  settings,
  backendConfigs,
  promptLists,
  worldInfo,
  quickReplies,
  chatMembers,
  extensionData,
  chatBroadcast,
  chatMetaBroadcast,
});

// Late-bound: the executor predates the generation service. Enables the
// curated `st` API (allowSt) for Lua tool templates.
luaToolExecutor.setStDeps({
  generationService,
  chats,
  characters,
  personas,
  settings,
  backendConfigs,
  worldInfo,
  chatMembers,
  extensionData,
  bus,
  chatBroadcast,
  chatMetaBroadcast,
});

generationService.setLifecycleCallbacks({
  onBeforeGeneration: (chatId, clientId) =>
    quickReplyService.runAutoExecute(chatId, QuickReplyAutoExecute.BEFORE_GENERATION, clientId ?? ''),
  onAfterGeneration: (chatId, clientId) =>
    quickReplyService.runAutoExecute(chatId, QuickReplyAutoExecute.AI_MESSAGE, clientId ?? ''),
});

const personaService = new PersonaService(personas, chats, storage);
const backendConfigService = new BackendConfigService(backendConfigs, settings);
const promptListService = new PromptListService(promptLists, settings);

// Register message handlers
const dispatch = createDispatcher({
  bus,
  characters,
  characterAssets,
  chats,
  settings,
  worldInfo,
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
  customBackends,
  luaRuntime,
  ragService,
  toolRegistry,
  toolsets,
  toolTemplates,
  chatBroadcast,
  chatMetaBroadcast,
});

// Wire dispatch into bus for every client message type the schema accepts.
// Derived from ClientMessageSchema so registration can never drift from
// validation (an unlisted type would be silently dropped by the bus).
for (const option of ClientMessageSchema.options) {
  bus.registerHandler(option.shape.type.value, dispatch);
}

// Express app (thin REST layer for uploads/exports + static client)
const app = express();
app.use(helmet({
  hsts: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'none'"],
      scriptSrc: ["'self'"],
      // Fonts and icons are vendored (see client/src/main.tsx) and served same-origin.
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: [
        "'self'",
        "blob:",
        "data:",
        // Empty string is ignored; '*' allows external image origins when the user enables the setting.
        (_req, _res) => (settings.getSync('allowExternalMedia') ? '*' : ''),
      ],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      frameSrc: ["'none'"],
      formAction: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use((_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), speaker=()',
  );
  next();
});
app.use(express.json({ limit: config.httpJsonLimit }));

// Serve built client
const clientDist = join(__dirname, '../../client/dist');
app.use(requestLogger());
app.use(express.static(clientDist));

// Public attachment download (must be before /api auth middleware so inline images load)
app.use('/api/attachments', createAttachmentDownloadRouter(attachments, storage));

// Auth middleware for all API routes
const requireAuth = createAuthMiddleware(auth);
app.use('/api', requireAuth);

// Character REST API
app.use('/api/characters', createCharacterRouter(characters, characterAssets, worldInfo, storage, bus));

// MCP endpoint for external agents (read/test-only; gated on mcp.enabled, behind requireAuth)
app.use('/api/mcp', createMcpRouter({ workbench: workbenchTemplate, cardTest, testSessions, settings }));

// Model listing REST API
app.use('/api/models', createModelsRouter(settings, backendConfigs, secretService, config.secret, createBackendAdapterResolved));

// Attachment upload (filesystem-backed)
app.use('/api/attachments', createAttachmentsRouter(attachments, storage, bus));

// Persona avatar upload
app.use('/api/personas', createPersonasRouter(personas, storage, bus, config.avatarMaxFileSizeBytes));

// File serving for avatars and personas — no DB lookup, auth via ?token= query param
app.use('/files', createFilesRouter(storage, requireAuth));

// Stats service
const statsService = new StatsService(db);

// Data Maid
const dataMaid = new DataMaid(db, storage);

app.use('/api/maid', createMaidRouter(dataMaid, chats, bus));

// Secret REST API
app.use('/api/secrets', createSecretsRouter(secretService, config.secret));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', connections: bus.getConnectionCount() });
});

// Stats API
app.use('/api/stats', createStatsRouter(statsService));

// Chat export
app.use('/api/chats', createChatsRouter(chats, generations));

// Fallback to index.html for SPA routes
app.get('/{*path}', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(join(clientDist, 'index.html'));
});

// Centralized error handler — must be last middleware to catch all route errors
app.use(errorHandler);

const server = createServer(app);

// Timeouts to prevent resource exhaustion and hanging connections
server.timeout = 30000; // 30s request timeout
server.keepAliveTimeout = 5000; // 5s keep-alive
server.headersTimeout = 35000; // slightly longer than timeout to allow response headers

// WebSocket event bus
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: config.wsMaxPayloadBytes,
  verifyClient: (info: { origin: string; secure: boolean; req: import('http').IncomingMessage }) => {
    const origin = info.origin;
    const host = info.req.headers.host;
    if (!host) return false;
    const proto = info.req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const expectedOrigin = `${proto}://${host}`;
    const allowed = new Set([
      expectedOrigin,
      'null',
      'http://localhost',
      'https://localhost',
      'http://127.0.0.1',
      'https://127.0.0.1',
      ...config.wsOrigins,
    ]);
    // In dev mode (DISABLE_CSRF=true), also allow any localhost/127.0.0.1 port
    if (config.disableCsrf) {
      if (origin && (origin.startsWith('http://localhost:') || origin.startsWith('https://localhost:'))) return true;
      if (origin && (origin.startsWith('http://127.0.0.1:') || origin.startsWith('https://127.0.0.1:'))) return true;
    }
    if (origin && !allowed.has(origin)) {
      log.warn({ origin, host }, 'ws: rejected cross-origin connection');
      return false;
    }
    return true;
  },
});

wss.on('connection', (ws, req) => {
  const client = bus.addClient(ws);
  let authRejectionTimer: ReturnType<typeof setTimeout> | undefined;

  ws.on('error', (err) => {
    log.warn({ err, clientId: client.id }, 'ws error');
  });

  ws.on('close', (code, reason) => {
    log.debug({ clientId: client.id, code, reason: reason.toString() }, 'ws close');
    if (authRejectionTimer) clearTimeout(authRejectionTimer);
    bus.removeClient(client.id);
  });

  // Validate auth token from URL query params
  const host = req.headers.host ?? 'localhost';
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const reqUrl = new URL(req.url ?? '/ws', `${proto}://${host}`);
  const token = reqUrl.searchParams.get('token') ?? undefined;

  if (!auth.validate(token)) {
    bus.sendTo(client.id, {
      type: 'auth.error',
      message: 'Invalid or missing authentication token',
    });
    // Give the client a moment to receive the error before closing
    authRejectionTimer = setTimeout(() => {
      ws.close(1008, 'Authentication required');
    }, config.wsAuthRejectionMs);
    return;
  }

  client.authenticated = true;

  // Tell the client its ID so it can identify its own broadcasts
  bus.sendTo(client.id, { type: 'client.assigned', clientId: client.id });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse((data as Buffer).toString()) as Record<string, unknown> | null;
      // Heartbeat: respond to client ping with pong. (Legacy clients that only
      // sent these are still ignored via the early return below.)
      if (parsed?.type === 'ping') {
        bus.sendTo(client.id, { type: 'pong' } as unknown as import('@tamari/types').ServerMessage);
        return;
      }
      if (parsed?.type === 'pong') {
        return;
      }
      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        log.error({ err: result.error.flatten() }, 'ws: validation error');
        bus.sendTo(client.id, {
          type: 'error',
          message: `Invalid message: ${result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      bus
        .dispatch(client, result.data)
        .catch((err) => {
          // bus.dispatch is async; the surrounding try/catch can't catch its
          // rejection, so log it here instead of letting it vanish.
          log.error({ err }, 'ws: dispatch rejected (async)');
        });
    } catch (err) {
      log.error({ err }, 'ws: dispatch error');
      bus.sendTo(client.id, {
        type: 'error',
        message: 'Invalid message',
        code: 'DISPATCH_ERROR',
      });
    }
  });
});

// Backfill missing thumbnails for existing avatars
await backfillThumbnails(db, storage, innerCharacters, personas);

// Unpacked cards: initial scan + folder watcher (no-op when the setting is off).
await unpackedCards.start();

server.listen(config.port, config.host, () => {
  const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  log.info(`tamari server listening on http://${displayHost}:${config.port}`);
});

async function backfillThumbnails(
  dbClient: Awaited<ReturnType<typeof initDatabase>>,
  fileStorage: FileStorage,
  charRepo: CharacterRepository,
  personaRepo: PersonaRepository,
): Promise<void> {
  const charRs = await dbClient.execute({
    sql: 'SELECT id, avatar_path, avatar_thumbnail_path FROM characters WHERE avatar_path IS NOT NULL',
  });
  await Promise.all(
    charRs.rows.map(async (row) => {
      const id = str(row.id);
      const avatarPath = str(row.avatar_path);
      const existingThumb = row.avatar_thumbnail_path ? str(row.avatar_thumbnail_path) : null;
      if (existingThumb && fileStorage.exists(existingThumb)) return;
      try {
        const buf = fileStorage.read(avatarPath);
        const thumb = await resizeThumbnail(Buffer.from(buf));
        const thumbFileName = `${randomUUID()}.png`;
        const thumbPath = fileStorage.write('avatars/thumbs', thumbFileName, new Uint8Array(thumb));
        await charRepo.update(id, { avatarThumbnailPath: thumbPath });
      } catch (err) {
        log.warn({ err, charId: id }, 'failed to backfill character thumbnail');
      }
    }),
  );

  const personaRs = await dbClient.execute({
    sql: 'SELECT id, avatar_path, avatar_thumbnail_path FROM personas WHERE avatar_path IS NOT NULL',
  });
  await Promise.all(
    personaRs.rows.map(async (row) => {
      const id = str(row.id);
      const avatarPath = str(row.avatar_path);
      const existingThumb = row.avatar_thumbnail_path ? str(row.avatar_thumbnail_path) : null;
      if (existingThumb && fileStorage.exists(existingThumb)) return;
      try {
        const buf = fileStorage.read(avatarPath);
        const thumb = await resizeThumbnail(Buffer.from(buf));
        const thumbFileName = `${randomUUID()}.png`;
        const thumbPath = fileStorage.write('personas/thumbs', thumbFileName, new Uint8Array(thumb));
        await personaRepo.update(id, { avatarThumbnailPath: thumbPath });
      } catch (err) {
        log.warn({ err, personaId: id }, 'failed to backfill persona thumbnail');
      }
    }),
  );
}

async function ensureDefaultPersona(personaRepo: PersonaRepository): Promise<void> {
  const count = await personaRepo.count();
  if (count === 0) {
    await personaRepo.create('default', {
      name: 'User',
      description: '',
    });
  }
}

async function ensureDefaultBackendConfig(backendConfigRepo: BackendConfigRepository, settingsRepo: ISettingsRepository): Promise<void> {
  const count = await backendConfigRepo.count();
  if (count === 0) {
    const defaults = loadDefaultConfigs();
    for (const { backendConfig } of defaults) {
      await backendConfigRepo.create(randomUUID(), backendConfig);
    }
  }

  const allSettings = await settingsRepo.list();
  if (!allSettings['activeBackendConfigId']) {
    const first = (await backendConfigRepo.list())[0];
    if (first) {
      await settingsRepo.setValue('activeBackendConfigId', first.id);
    }
  }
}

async function ensureDefaultPromptList(promptListRepo: PromptListRepository, settingsRepo: ISettingsRepository): Promise<void> {
  const count = await promptListRepo.count();
  if (count === 0) {
    const defaults = loadDefaultConfigs();
    for (const { promptList } of defaults) {
      await promptListRepo.create(randomUUID(), promptList);
    }
  }

  const allSettings = await settingsRepo.list();
  if (!allSettings['activePromptListId']) {
    const first = (await promptListRepo.list())[0];
    if (first) {
      await settingsRepo.setValue('activePromptListId', first.id);
    }
  }
}

function shutdown(signal: string) {
  log.info(`received ${signal}, shutting down gracefully...`);

  unpackedCards.stop();
  if (db instanceof ProfiledClient) {
    db.report();
  }

  // Forcefully exit if graceful shutdown takes longer than 5s
  const forceExit = setTimeout(() => {
    log.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);

  // Close all active WebSocket connections so server.close() can finish
  bus.closeAll();
  wss.close();

  server.close(() => {
    clearTimeout(forceExit);
    // libsql client doesn't have a synchronous close() in all versions;
    // exiting the process is sufficient for local file DB.
    log.info('goodbye');
    process.exit(0);
  });
}

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'unhandled rejection');
});

process.on('uncaughtException', (err) => {
  log.error({ err }, 'uncaught exception');
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
