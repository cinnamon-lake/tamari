/**
 * REST API request/response types.
 * Most mutations happen over WebSocket; REST is used for
 * uploads, exports, and paginated reads.
 */

import type { Character, Chat, WorldInfo } from './db.js';

// ---------- Characters ----------

export interface ListCharactersQuery {
  search?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface ListCharactersResponse {
  items: Character[];
  total: number;
}

// ---------- Chats ----------

export interface ListChatsQuery {
  characterId?: string;
  limit?: number;
  offset?: number;
}

export interface ListChatsResponse {
  items: Chat[];
  total: number;
}

export interface CreateChatRequest {
  characterId: string | null;
  name: string;
}

// ---------- World Info ----------

export interface ListWorldInfoResponse {
  items: WorldInfo[];
}

export interface CreateWorldInfoRequest {
  name: string;
  entries?: WorldInfo['entries'];
}

export interface UpdateWorldInfoRequest {
  name?: string;
  entries?: WorldInfo['entries'];
}

// ---------- Settings ----------

import type { AppSettings } from './schemas.js';

/** Runtime settings type with known fields + forward-compat index signature. */
export type SettingsMap = AppSettings & Record<string, unknown>;

// ---------- Export / Backup ----------

export interface ExportLegacyResponse {
  downloadUrl: string;
}

// ---------- Misc ----------

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}
