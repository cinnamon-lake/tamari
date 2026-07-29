/**
 * Raw RisuAI module storage for imported characters.
 *
 * Decoded `.risum` module JSON is stored verbatim as a file under
 * `character_modules/<characterId>/<moduleId>.json` (via FileStorage), while
 * `character.extensions.risuModules` carries only a small metadata array.
 * Rationale: character broadcasts send the full character object, and module
 * JSON runs 0.5–2MB for heavy cards — keeping it out of the extensions blob
 * keeps `character.updated` broadcasts light while preserving full fidelity
 * for the porting workflow (Character Workbench `risu_module_*` tools).
 *
 * Asset-block payloads from .risum files are stored separately as ordinary
 * character assets (`storeRisuModuleAssets`) — the module JSON keeps only the
 * asset metadata triplets. (CharX-embedded modules still skip payloads: the
 * card's own asset section is already extracted by the CharX import path.)
 *
 * Deliberate asymmetry: triggers/regex/lorebook stay sealed in the raw module
 * (module-scoped, inert, deleted with the module), while asset payloads are
 * FLATTENED into the card's asset store at attach time. Rationale: module
 * behavior is code v2 cannot run, but payloads are inert bytes v2 can serve —
 * and RisuAI intends module asset packs to be card-usable. Consequences, all
 * accepted: the card's {{img::}} namespace shares module asset names (last
 * writer wins on collision), exports include them, and risu_module_remove
 * leaves them behind (they are the card's assets by then, not the module's).
 */

import { randomUUID } from 'node:crypto';
import type { Character } from '@tamari/types';
import type { FileStorage } from './FileStorage.js';
import type { ICharacterAssetRepository } from '../repos/CharacterAssetRepository.js';
import type { RisuAssetPayload, RisuModuleData } from '../lib/risum.js';
import { sanitizeAssetName } from '../lib/charx.js';

export const CHARACTER_RISU_MODULES_EXTENSION_KEY = 'risuModules';

export interface RisuModuleMeta {
  id: string;
  name: string;
  namespace?: string;
  source: 'embedded' | 'attached';
  /** FileStorage-relative path of the raw module JSON. */
  filePath: string;
  counts: {
    triggers: number;
    regex: number;
    lorebook: number;
    assets: number;
  };
  /** True when any trigger effect is raw Lua (`triggerlua`). */
  hasLua: boolean;
  lowLevelAccess: boolean;
}

/** Tolerant parse of the extensions metadata array. */
export function listRisuModuleMeta(character: Character | null | undefined): RisuModuleMeta[] {
  const raw = character?.extensions[CHARACTER_RISU_MODULES_EXTENSION_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is RisuModuleMeta =>
      !!m &&
      typeof m === 'object' &&
      typeof (m as RisuModuleMeta).id === 'string' &&
      typeof (m as RisuModuleMeta).filePath === 'string',
  );
}

function summarizeModule(id: string, module: RisuModuleData, source: RisuModuleMeta['source'], filePath: string): RisuModuleMeta {
  const triggers = Array.isArray(module.trigger) ? module.trigger : [];
  return {
    id,
    name: typeof module.name === 'string' ? module.name : 'Unnamed Module',
    namespace: typeof module.namespace === 'string' ? module.namespace : undefined,
    source,
    filePath,
    counts: {
      triggers: triggers.length,
      regex: Array.isArray(module.regex) ? module.regex.length : 0,
      lorebook: Array.isArray(module.lorebook) ? module.lorebook.length : 0,
      assets: Array.isArray(module.assets) ? module.assets.length : 0,
    },
    // Module JSON is stored/loaded via an optimistic cast (risum.ts), not
    // validated — effect entries can be null at runtime.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    hasLua: triggers.some((t) => Array.isArray(t.effect) && t.effect.some((e) => e?.type === 'triggerlua')),
    lowLevelAccess: Boolean(module.lowLevelAccess),
  };
}

/** Store a decoded module's JSON and return its metadata entry. */
export function storeRisuModule(
  storage: FileStorage,
  characterId: string,
  module: RisuModuleData,
  source: RisuModuleMeta['source'],
): RisuModuleMeta {
  const id = randomUUID();
  const filePath = storage.write(
    `character_modules/${characterId}`,
    `${id}.json`,
    new Uint8Array(Buffer.from(JSON.stringify(module), 'utf-8')),
  );
  return summarizeModule(id, module, source, filePath);
}

/**
 * Store a module's asset PAYLOADS as ordinary character assets, so the ported
 * card can serve and export them like CharX-extracted assets. Payload indexes
 * align with `module.assets` triplets ([name, datapath, ext]); empty payloads
 * (skipAssetPayloads parses) are skipped. Returns the number of assets stored.
 */
export async function storeRisuModuleAssets(
  storage: FileStorage,
  assetRepo: Pick<ICharacterAssetRepository, 'create'>,
  characterId: string,
  module: RisuModuleData,
  payloads: RisuAssetPayload[],
  moduleId: string,
): Promise<number> {
  const triplets = Array.isArray(module.assets) ? module.assets : [];
  let stored = 0;
  for (const payload of payloads) {
    if (payload.data.length === 0) continue;
    const triplet = triplets[payload.index];
    const rawName = typeof triplet?.[0] === 'string' && triplet[0].length > 0 ? triplet[0] : `asset-${payload.index}`;
    const ext = typeof triplet?.[2] === 'string' && triplet[2].length > 0 ? triplet[2] : 'bin';
    const assetId = randomUUID();
    const filePath = storage.write(
      `character_assets/${characterId}`,
      `${assetId}.${ext}`,
      new Uint8Array(payload.data),
    );
    await assetRepo.create(characterId, {
      id: assetId,
      name: sanitizeAssetName(rawName),
      type: 'other',
      ext,
      filePath,
      meta: { origin: 'risu-module', moduleId, risuName: rawName },
    });
    stored += 1;
  }
  return stored;
}

/** Load the raw module JSON for a metadata entry. Returns undefined when the file is gone. */
export function loadRisuModule(storage: FileStorage, meta: RisuModuleMeta): RisuModuleData | undefined {
  if (!storage.exists(meta.filePath)) return undefined;
  const raw = storage.read(meta.filePath);
  return JSON.parse(raw.toString('utf-8')) as RisuModuleData;
}

export type RisuModuleSection = 'info' | 'triggers' | 'trigger' | 'regex' | 'lorebook' | 'assets';
export const RISU_MODULE_SECTIONS: readonly RisuModuleSection[] = ['info', 'triggers', 'trigger', 'regex', 'lorebook', 'assets'];

/**
 * Extract one section of a raw module for the porting workflow. Shared by the
 * Character Workbench `risu_module_get` tool and the REST read endpoints —
 * keep the shapes identical so agent and UI see the same data.
 */
export function getRisuModuleSection(
  module: RisuModuleData,
  section: RisuModuleSection,
  index?: number,
): { ok: true; data: unknown } | { ok: false; error: string } {
  switch (section) {
    case 'info':
      return {
        ok: true,
        data: {
          name: module.name,
          description: module.description ?? '',
          namespace: module.namespace ?? null,
          customModuleToggle: module.customModuleToggle ?? '',
          lowLevelAccess: Boolean(module.lowLevelAccess),
          hideIcon: Boolean(module.hideIcon),
          backgroundEmbedding: module.backgroundEmbedding ?? '',
          mcp: module.mcp ?? null,
        },
      };
    case 'triggers': {
      const triggers = Array.isArray(module.trigger) ? module.trigger : [];
      return {
        ok: true,
        data: triggers.map((t, i) => ({
          index: i,
          type: t.type,
          // Module JSON is an optimistic cast, not validated — `comment` and
          // effect entries can be missing/null at runtime.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          comment: t.comment ?? '',
          effectCount: Array.isArray(t.effect) ? t.effect.length : 0,
          conditionCount: Array.isArray(t.conditions) ? t.conditions.length : 0,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          hasLua: Array.isArray(t.effect) && t.effect.some((e) => e?.type === 'triggerlua'),
        })),
      };
    }
    case 'trigger': {
      if (index === undefined) return { ok: false, error: 'section=trigger requires an index (see section=triggers)' };
      const triggers = Array.isArray(module.trigger) ? module.trigger : [];
      const trigger = triggers[index];
      if (!trigger) return { ok: false, error: `trigger index ${index} out of range (module has ${triggers.length} triggers)` };
      return { ok: true, data: trigger };
    }
    case 'regex':
      return { ok: true, data: module.regex ?? [] };
    case 'lorebook':
      return { ok: true, data: module.lorebook ?? [] };
    case 'assets':
      // Metadata triplets only — .risum asset payloads are not stored.
      return { ok: true, data: module.assets ?? [] };
  }
}

/** Delete the stored module file and return the metadata array with the entry removed. */
export function removeRisuModule(
  storage: FileStorage,
  character: Character,
  moduleId: string,
): RisuModuleMeta[] {
  const metas = listRisuModuleMeta(character);
  const target = metas.find((m) => m.id === moduleId);
  if (target && storage.exists(target.filePath)) {
    storage.delete(target.filePath);
  }
  return metas.filter((m) => m.id !== moduleId);
}
