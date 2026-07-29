/**
 * Custom-backend factory — resolves a custom backend id (or a `custom`
 * provider backend config) to a LuaBackendAdapter, and builds the
 * credential-safe delegation surface (`backends.generate` / passthrough)
 * injected into the Lua VM.
 *
 * Delegation model (scriptable-layers.md §2):
 *   - `backends.generate(prompt)` uses the calling config's DEFAULT DELEGATE —
 *     `providerParams.delegateConfigId` on the `custom`-provider backend
 *     config ("which backend does this script write with"). This is the common
 *     middleware case and keeps backend references out of Lua entirely.
 *   - `backends.generate("<configId>", prompt)` targets a specific backend
 *     config BY ID — the escape hatch for simulator backends with multiple
 *     targets (e.g. a main model + an auxiliary model). Ids, not names:
 *     stable under renames, no case-folding ambiguity.
 *
 * API keys never cross into Lua: resolution builds adapters through the
 * normal secret-resolving factory. Custom → custom chains are allowed but
 * depth-capped (MAX_CUSTOM_BACKEND_DEPTH) so a misconfigured cycle errors out
 * instead of hanging a generation turn.
 */

import type { BackendConfig } from '@tamari/types';
import type { BackendAdapter } from './BackendAdapter.js';
import type { LuaRuntime } from '../scripting/LuaRuntime.js';
import type { ICustomBackendRepository } from '../repos/CustomBackendRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import { buildBackendSettings } from './buildBackendSettings.js';
import { str } from '../lib/coerce.js';
import {
  LuaBackendAdapter,
  runAdapterBlocking,
  type CustomBackendDelegate,
} from './LuaBackendAdapter.js';

export const MAX_CUSTOM_BACKEND_DEPTH = 4;

export interface CustomBackendFactoryDeps {
  customBackends: ICustomBackendRepository;
  backendConfigs: IBackendConfigRepository;
  settings: ISettingsRepository;
  luaRuntime: LuaRuntime;
  /** The resolved adapter factory (secret:<key> references already resolved). */
  createResolvedAdapter: (settings: Record<string, unknown>) => Promise<BackendAdapter | null>;
}

/**
 * Extract the custom backend selection from merged backend settings, or null
 * when the active provider is not `custom`. `providerParams.customBackendId`
 * and `providerParams.delegateConfigId` flow to the top level via
 * buildBackendSettings.
 */
export function customBackendSelectionFromSettings(
  settings: Record<string, unknown>,
): { customBackendId: string; delegateConfigId: string | null } | null {
  if (str(settings['backendProvider']) !== 'custom') return null;
  const customBackendId = str(settings['customBackendId']);
  if (!customBackendId) return null;
  const delegateConfigId = str(settings['delegateConfigId']);
  return { customBackendId, delegateConfigId: delegateConfigId || null };
}

export async function createCustomBackendAdapter(
  deps: CustomBackendFactoryDeps,
  customBackendId: string,
  delegateConfigId: string | null,
  depth = 0,
): Promise<LuaBackendAdapter> {
  if (depth > MAX_CUSTOM_BACKEND_DEPTH) {
    throw new Error(`custom backend delegation depth exceeded (max ${MAX_CUSTOM_BACKEND_DEPTH}) — check for delegation cycles`);
  }
  const customBackend = await deps.customBackends.getById(customBackendId);
  if (!customBackend) {
    throw new Error(`custom backend "${customBackendId}" not found`);
  }
  return new LuaBackendAdapter({
    id: `custom:${customBackend.id}`,
    name: customBackend.name,
    luaSource: customBackend.luaSource,
    runtime: deps.luaRuntime,
    delegate: makeDelegate(deps, delegateConfigId, depth),
  });
}

async function adapterForConfig(
  deps: CustomBackendFactoryDeps,
  config: BackendConfig,
  depth: number,
): Promise<BackendAdapter> {
  if (config.backendProvider === 'custom') {
    const id = str(config.providerParams['customBackendId']);
    if (!id) {
      throw new Error(`backend config "${config.name}" uses provider "custom" but has no providerParams.customBackendId`);
    }
    const delegateId = str(config.providerParams['delegateConfigId']) || null;
    return createCustomBackendAdapter(deps, id, delegateId, depth + 1);
  }
  const allSettings = await deps.settings.list();
  const merged = buildBackendSettings(allSettings, config);
  const adapter = await deps.createResolvedAdapter(merged);
  if (!adapter) {
    throw new Error(`backend "${config.name}" could not be created (missing API key?)`);
  }
  return adapter;
}

function makeDelegate(
  deps: CustomBackendFactoryDeps,
  delegateConfigId: string | null,
  depth: number,
): CustomBackendDelegate {
  const resolve = async (configId: string | null): Promise<BackendAdapter> => {
    const id = configId ?? delegateConfigId;
    if (!id) {
      throw new Error(
        'no delegate configured: set providerParams.delegateConfigId on the custom backend config, or pass a backend config id explicitly',
      );
    }
    const config = await deps.backendConfigs.getById(id);
    if (!config) {
      throw new Error(`backend config "${id}" not found`);
    }
    return adapterForConfig(deps, config, depth);
  };

  return {
    generate: async (configId: string | null, prompt, signal, ctx) => {
      const adapter = await resolve(configId);
      return runAdapterBlocking(adapter, prompt, signal, ctx);
    },
    resolveAdapter: resolve,
  };
}

// ---------- Character-coupled contextual backends (Type B) ----------

/**
 * Extension key for card-coupled backend logic: a Lua script that belongs to
 * the character (ported triggerlua, simulator logic) rather than to the global
 * registry. Stored inline in extensions so it travels with card export.
 * `enabled` is the opt-in toggle — imports ship logic but never activate it
 * silently (the RisuAI lowLevelAccess lesson).
 */
export const CHARACTER_BACKEND_EXTENSION_KEY = 'contextualBackend';

export interface CharacterBackendScript {
  luaSource: string;
}

/**
 * Read a character's contextual backend script, or null when absent, disabled,
 * or empty. Tolerant of malformed extension data.
 */
export function getCharacterBackendScript(
  character: { extensions: Record<string, unknown> } | null | undefined,
): CharacterBackendScript | null {
  const raw = character?.extensions[CHARACTER_BACKEND_EXTENSION_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const ext = raw as Record<string, unknown>;
  if (ext['enabled'] !== true) return null;
  const luaSource = typeof ext['luaSource'] === 'string' ? ext['luaSource'].trim() : '';
  return luaSource.length > 0 ? { luaSource } : null;
}

/**
 * Wrap an already-resolved active adapter with a character's contextual
 * backend. The script owns the prompt; the active adapter is the DEFAULT
 * DELEGATE (the user's selected writer model). `backends.generate("<id>", …)`
 * still works for explicit multi-target scripts.
 */
export function createContextualBackendAdapter(
  deps: CustomBackendFactoryDeps,
  opts: {
    characterId: string;
    characterName: string;
    luaSource: string;
    activeAdapter: BackendAdapter;
  },
): LuaBackendAdapter {
  const resolveExplicit = async (configId: string): Promise<BackendAdapter> => {
    const config = await deps.backendConfigs.getById(configId);
    if (!config) {
      throw new Error(`backend config "${configId}" not found`);
    }
    return adapterForConfig(deps, config, 0);
  };

  return new LuaBackendAdapter({
    id: `character-backend:${opts.characterId}`,
    name: `${opts.characterName} (card logic)`,
    luaSource: opts.luaSource,
    runtime: deps.luaRuntime,
    delegate: {
      generate: async (configId, prompt, signal, ctx) =>
        runAdapterBlocking(configId ? await resolveExplicit(configId) : opts.activeAdapter, prompt, signal, ctx),
      resolveAdapter: async (configId) => (configId ? resolveExplicit(configId) : opts.activeAdapter),
    },
  });
}
