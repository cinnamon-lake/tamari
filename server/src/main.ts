/**
 * tamari Server Entry Point
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
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
} from './repos/index.js';
import type { ISettingsRepository } from './repos/SettingsRepository.js';
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
import { ClientMessageSchema, QuickReplyAutoExecute, sanitizeProviderParams } from '@tamari/types';
import type { PresetPromptDef, PresetPromptOrderEntry } from '@tamari/types';
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

const config = loadConfig();
const log = getLogger('main');

// Authentication service
const auth = new AuthService(config.secret);

// Log the secret (masked) so the user can copy it
if (!process.env.TAMARI_SECRET) {
  const masked = config.secret.length > 8
    ? `${config.secret.slice(0, 4)}...${config.secret.slice(-4)}`
    : '****';
  log.warn(`No TAMARI_SECRET set. Generated random secret: ${masked}`);
  log.warn('Set TAMARI_SECRET environment variable to persist the secret across restarts.');
}

// Ensure data directory exists
mkdirSync(dirname(config.dbPath), { recursive: true });

// File storage for avatars and attachments
const storage = new FileStorage(config.dataDir);

// Initialize SQLite
const db = await initDatabase({ path: config.dbPath, dataDir: config.dataDir });
// Database ready

// Repositories
const characters = withLogging(new CharacterRepository(db), 'characters');
const characterAssets = withLogging(new CharacterAssetRepository(db), 'characterAssets');
const chats = withLogging(new ChatRepository(db), 'chats');
const settings = withLogging(new CachedSettings(db), 'settings');
const worldInfo = withLogging(new WorldInfoRepository(db), 'worldInfo');
const generations = withLogging(new GenerationRepository(db), 'generations');
const personas = withLogging(new PersonaRepository(db), 'personas');
const backendConfigs = withLogging(new BackendConfigRepository(db), 'backendConfigs');
const promptLists = withLogging(new PromptListRepository(db), 'promptLists');
const chatMembers = withLogging(new ChatMemberRepository(db), 'chatMembers');
const extensionData = withLogging(new ExtensionDataRepository(db), 'extensionData');
const attachments = withLogging(new AttachmentRepository(db), 'attachments');
const customBackends = withLogging(new CustomBackendRepository(db), 'customBackends');
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
      { customBackends, backendConfigs, settings, luaRuntime, createResolvedAdapter: createBackendAdapterResolved },
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

// Boot-time migration: split old presets table into backend_configs and prompt_lists
await migratePresetsToSplitTables(db, backendConfigs, promptLists, settings);

// Ensure at least one backend config and prompt list exist
await ensureDefaultBackendConfig(backendConfigs, settings);
await ensureDefaultPromptList(promptLists, settings);

// One-time migration: copy global apiUrl/apiKey into active backend config
await migrateConnectionSettingsToBackendConfigs(backendConfigs, settings);

// Sweep: drop undeclared providerParams keys (legacy v1 settings dumps) from
// configs written before the repository started sanitizing on write.
await sanitizeStoredProviderParams(backendConfigs);

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
registerWorkbenchTemplate(toolRegistry, { characterWorkbench, backendWorkbench, toolsetWorkbench, quickReplyWorkbench, luaToolWorkbench, generations });


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

const promptBuilder = new PromptBuilder(worldInfoInjector);
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
await backfillThumbnails(db, storage, characters, personas);

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

/** Drop undeclared providerParams keys (legacy v1 settings dumps) from every stored config. */
async function sanitizeStoredProviderParams(backendConfigRepo: BackendConfigRepository): Promise<void> {
  for (const config of await backendConfigRepo.list()) {
    const clean = sanitizeProviderParams(config.providerParams);
    const dropped = Object.keys(config.providerParams).filter((k) => !(k in clean));
    if (dropped.length > 0) {
      await backendConfigRepo.update(config.id, { providerParams: clean });
      log.info({ configId: config.id, name: config.name, dropped }, 'dropped undeclared providerParams keys');
    }
  }
}

async function migrateConnectionSettingsToBackendConfigs(
  backendConfigRepo: BackendConfigRepository,
  settingsRepo: ISettingsRepository,
): Promise<void> {
  const allSettings = await settingsRepo.list();
  const globalApiUrl = allSettings['api_url'];
  const globalApiKey = allSettings['api_key'];
  const hasGlobalConnection =
    (globalApiUrl && str(globalApiUrl).trim().length > 0) ||
    (globalApiKey && str(globalApiKey).trim().length > 0);
  if (!hasGlobalConnection) return;

  const activeBackendConfigId = String(allSettings['activeBackendConfigId']);
  const backendConfig = activeBackendConfigId ? await backendConfigRepo.getById(activeBackendConfigId) : null;
  if (!backendConfig) return;

  const patch: { apiUrl?: string; apiKey?: string } = {};
  if (!backendConfig.apiUrl && globalApiUrl) patch.apiUrl = str(globalApiUrl);
  if (!backendConfig.apiKey && globalApiKey) patch.apiKey = str(globalApiKey);
  if (Object.keys(patch).length > 0) {
    await backendConfigRepo.update(backendConfig.id, patch);
    log.info('migrated global api_url/api_key into active backend config');
  }

  await settingsRepo.delete('api_url');
  await settingsRepo.delete('api_key');
  await settingsRepo.delete('reverseProxyUrl');
  await settingsRepo.delete('proxyPassword');
  log.info('removed deprecated global connection settings');
}

async function migratePresetsToSplitTables(
  dbClient: Awaited<ReturnType<typeof initDatabase>>,
  backendConfigRepo: BackendConfigRepository,
  promptListRepo: PromptListRepository,
  settingsRepo: ISettingsRepository,
): Promise<void> {
  const tableCheck = await dbClient.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='presets'",
  });
  if (tableCheck.rows.length === 0) return;

  const presets = await dbClient.execute('SELECT * FROM presets');
  for (const row of presets.rows) {
    const r = row as Record<string, unknown>;
    const id = str(r.id) || randomUUID();

    const backendConfigExists = await backendConfigRepo.getById(id).catch(() => undefined);
    if (!backendConfigExists) {
      await backendConfigRepo.create(id, {
        name: str(r.name, 'Migrated Preset'),
        description: str(r.description),
        backendProvider: str(r.backend_provider, 'openai'),
        generationMode: str(r.generation_mode, 'chat') as 'chat' | 'text',
        model: str(r.model),
        temperature: r.temperature != null ? Number(r.temperature) : null,
        maxTokens: r.max_tokens != null ? Number(r.max_tokens) : null,
        topP: r.top_p != null ? Number(r.top_p) : null,
        topK: r.top_k != null ? Number(r.top_k) : null,
        minP: r.min_p != null ? Number(r.min_p) : null,
        topA: r.top_a != null ? Number(r.top_a) : null,
        repetitionPenalty: r.repetition_penalty != null ? Number(r.repetition_penalty) : null,
        frequencyPenalty: r.frequency_penalty != null ? Number(r.frequency_penalty) : null,
        presencePenalty: r.presence_penalty != null ? Number(r.presence_penalty) : null,
        instructTemplate: str(r.instruct_template),
        contextLength: r.context_length != null ? Number(r.context_length) : null,
        promptHistoryLimit: r.prompt_history_limit != null ? Number(r.prompt_history_limit) : null,
        providerParams: r.provider_params_json ? (JSON.parse(str(r.provider_params_json)) as Record<string, unknown>) : {},
        stopStrings: r.stop_strings_json ? (JSON.parse(str(r.stop_strings_json)) as string[]) : [],
        openrouterProvider: r.openrouter_provider ? str(r.openrouter_provider) : null,
        apiUrl: r.api_url ? str(r.api_url) : null,
        apiKey: r.api_key ? str(r.api_key) : null,
        logitBias: r.logit_bias_json ? (JSON.parse(str(r.logit_bias_json)) as Record<string, number>) : null,
      });
    }

    const promptListExists = await promptListRepo.getById(id).catch(() => undefined);
    if (!promptListExists) {
      await promptListRepo.create(id, {
        name: str(r.name, 'Migrated Preset'),
        description: str(r.description),
        prompts: r.prompts_json ? (JSON.parse(str(r.prompts_json)) as PresetPromptDef[]) : [],
        promptOrder: r.prompt_order_json ? (JSON.parse(str(r.prompt_order_json)) as PresetPromptOrderEntry[]) : [],
      });
    }
  }

  const allSettings = await settingsRepo.list();
  const activePresetId = allSettings['activePresetId'];
  if (activePresetId) {
    const presetId = str(activePresetId);
    await settingsRepo.setValue('activeBackendConfigId', presetId);
    await settingsRepo.setValue('activePromptListId', presetId);
  }

  await dbClient.execute('DROP TABLE presets');
  log.info('migrated presets table to backend_configs and prompt_lists');

  await settingsRepo.delete('activePresetId');
}

function shutdown(signal: string) {
  log.info(`received ${signal}, shutting down gracefully...`);

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
