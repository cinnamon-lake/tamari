/**
 * WebSocket event bus protocol types.
 *
 * Server -> Client messages broadcast state changes.
 * Client -> Server messages trigger mutations.
 *
 * The message unions are DERIVED from the Zod schemas in schemas.ts — the
 * schemas are the single source of truth for the wire protocol (they validate
 * every inbound frame at the server boundary and every outbound frame at the
 * client). Do not hand-write message shapes here.
 */

import type { z } from 'zod';
import type {
  CharacterSummary,
  ChatSummary,
  PersonaSummary,
  BackendConfigSummary,
  PromptListSummary,
  ToolTemplate,
  Toolset,
} from './db.js';
import type { SettingsMap } from './api.js';
import type { ClientMessageSchema, ServerMessageSchema } from './schemas.js';

// ---------- Server -> Client ----------

export interface GenerationSnapshot {
  id: string;
  chatId: string;
  messageId: number;
  text: string;
  reasoning?: string;
}

export interface ToolInfo {
  id: string;
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
  tools?: Array<{ name: string; description: string; parameters?: Record<string, unknown> }>;
}

export interface FullState {
  characters: CharacterSummary[];
  chats: ChatSummary[];
  settings: SettingsMap;
  generation?: GenerationSnapshot;
  personas?: PersonaSummary[];
  backendConfigs?: BackendConfigSummary[];
  promptLists?: PromptListSummary[];
  tools?: ToolInfo[];
  toolTemplates?: ToolTemplate[];
  toolsets?: Toolset[];
}

/**
 * Canonical server->client message union, derived from `ServerMessageSchema`.
 * This is the PARSED shape (schema defaults applied) — what the client bus
 * hands to listeners and what the server must construct.
 */
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------- Client -> Server ----------

/**
 * Canonical client->server message union, derived from `ClientMessageSchema`.
 * This is the PARSED shape (schema defaults applied) — what the dispatcher
 * receives after boundary validation.
 */
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/**
 * The WIRE shape of client->server messages: fields with schema defaults may
 * be omitted by senders. Use this for anything CONSTRUCTING a message
 * (client bus `send`, test harnesses); use `ClientMessage` for anything
 * consuming a validated message.
 */
export type ClientMessageInput = z.input<typeof ClientMessageSchema>;
