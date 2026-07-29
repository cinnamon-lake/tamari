/**
 * Shared types for the per-domain dispatch handler modules.
 *
 * The dispatcher composes one `Handlers<...>` subset per domain module into a
 * full `HandlerMap` (see dispatcher.ts) — a missing message type fails to
 * compile, which replaces the old switch's `never` exhaustiveness check.
 */

import type { ClientMessage } from '@tamari/types';
import type { ClientConnection, EventBus } from '../bus/EventBus.js';
import type {
  ICharacterRepository,
  IChatRepository,
  ISettingsRepository,
  IWorldInfoRepository,
  IPersonaRepository,
  IBackendConfigRepository,
  IPromptListRepository,
  IChatMemberRepository,
  ICharacterAssetRepository,
  IAttachmentRepository,
} from '../repos/index.js';
import type { GenerationService } from '../services/GenerationService.js';
import type { GroupChatService } from '../services/GroupChatService.js';
import type { PersonaService } from '../services/PersonaService.js';
import type { BackendConfigService } from '../services/BackendConfigService.js';
import type { PromptListService } from '../services/PromptListService.js';
import type { QuickReplyService } from '../scripting/QuickReplyService.js';
import type { WorldInfoInjector } from '../pipeline/WorldInfoInjector.js';
import type { ITokenCounter } from '../tokenizers/TokenCounter.js';
import type { FileStorage } from '../services/FileStorage.js';
import type { IQuickReplyRepository } from '../repos/QuickReplyRepository.js';
import type { ICustomBackendRepository } from '../repos/CustomBackendRepository.js';
import type { LuaRuntime } from '../scripting/LuaRuntime.js';
import type { RAGService } from '../services/RAGService.js';
import type { ToolRegistry } from '../services/ToolRegistry.js';
import type { IToolsetRepository } from '../repos/ToolsetRepository.js';
import type { IToolTemplateRepository } from '../repos/ToolTemplateRepository.js';
import type { ChatBroadcastService } from '../services/ChatBroadcastService.js';
import type { ChatMetaBroadcastService } from '../services/ChatMetaBroadcastService.js';

export interface DispatcherDeps {
  bus: EventBus;
  characters: ICharacterRepository;
  characterAssets: ICharacterAssetRepository;
  chats: IChatRepository;
  settings: ISettingsRepository;
  worldInfo: IWorldInfoRepository;
  personas: IPersonaRepository;
  backendConfigs: IBackendConfigRepository;
  promptLists: IPromptListRepository;
  chatMembers: IChatMemberRepository;
  attachments: IAttachmentRepository;
  generationService: GenerationService;
  groupChatService: GroupChatService;
  personaService: PersonaService;
  backendConfigService: BackendConfigService;
  promptListService: PromptListService;
  worldInfoInjector: WorldInfoInjector;
  tokenCounter: ITokenCounter;
  storage: FileStorage;
  quickReplyService: QuickReplyService;
  quickReplies: IQuickReplyRepository;
  customBackends: ICustomBackendRepository;
  /** Lua runtime for custombackend.test dry-runs. */
  luaRuntime: LuaRuntime;
  ragService?: RAGService;
  toolRegistry?: ToolRegistry;
  toolsets: IToolsetRepository;
  toolTemplates: IToolTemplateRepository;
  chatBroadcast: ChatBroadcastService;
  chatMetaBroadcast: ChatMetaBroadcastService;
}

export type MessageHandler<M extends ClientMessage> = (
  client: ClientConnection,
  msg: M,
) => Promise<void>;

/** One handler per ClientMessage type — the compile-time exhaustiveness guarantee. */
export type HandlerMap = {
  [K in ClientMessage['type']]: MessageHandler<Extract<ClientMessage, { type: K }>>;
};

/** The subset of the handler map implemented by one domain module. */
export type Handlers<T extends ClientMessage['type']> = Pick<HandlerMap, T>;
