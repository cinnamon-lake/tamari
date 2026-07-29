/**
 * Character REST API — uploads, avatars, import/export V2/V3/CharX cards.
 *
 * Spec references:
 * - V2: https://github.com/malfoyslastname/character-card-spec-v2
 * - V3: https://github.com/kwaroran/character-card-spec-v3
 */

import { Router } from 'express';
import { getLogger } from '../lib/logger.js';
import { str } from '../lib/coerce.js';

const log = getLogger('api/characters');
import multer from 'multer';
import _extract from 'png-chunks-extract';
const extract = _extract;
import PNGtext from 'png-chunk-text';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildCardJson, type BuildCardOptions } from '../repos/CharacterRepository.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { ICharacterAssetRepository } from '../repos/CharacterAssetRepository.js';
import type { IWorldInfoRepository } from '../repos/WorldInfoRepository.js';
import type { FileStorage } from '../services/FileStorage.js';
import type { EventBus } from '../bus/EventBus.js';
import type { WorldInfoEntry, TavernCard, TavernCardV2Data } from '@tamari/types';
import { LooseCardDataSchema, buildTavernCard } from '@tamari/types';
import { resizeAvatar, resizeThumbnail } from '../lib/avatar.js';
import { setCharacterAvatarFromBuffer } from '../services/characterAvatar.js';
import { toCharacterSummary, withCharacterAvatar } from '../lib/summaries.js';
import { parseCharX, extractCharXAssets, buildAssetUri, sanitizeAssetName } from '../lib/charx.js';
import { parseRisum, RisumParseError } from '../lib/risum.js';
import {
  CHARACTER_RISU_MODULES_EXTENSION_KEY,
  RISU_MODULE_SECTIONS,
  getRisuModuleSection,
  listRisuModuleMeta,
  loadRisuModule,
  removeRisuModule,
  storeRisuModule,
  storeRisuModuleAssets,
  type RisuModuleMeta,
  type RisuModuleSection,
} from '../services/characterRisuModules.js';
import { zipSync } from 'fflate';
import mime from 'mime-types';

// 512MB: .risum asset packs (music/NSFW) run 140–170MB and CharX cards with
// big asset bundles keep growing. memoryStorage buffers the whole upload in
// RAM, so this is the practical ceiling for a local single-user server.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });

const cardDataSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    personality: z.string().optional(),
    scenario: z.string().optional(),
    firstMes: z.string().optional(),
    mesExample: z.string().optional(),
    creator: z.string().optional(),
    characterVersion: z.string().optional(),
    tags: z.array(z.string()).optional(),
    creatorNotes: z.string().optional(),
    systemPrompt: z.string().optional(),
    postHistoryInstructions: z.string().optional(),
    alternateGreetings: z.array(z.string()).optional(),
    groupOnlyGreetings: z.array(z.string()).optional(),
    nickname: z.string().optional(),
    creatorNotesMultilingual: z.record(z.string(), z.string()).optional(),
    source: z.array(z.string()).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
    createDate: z.string().optional(),
  })
  .passthrough();

interface PngChunk {
  name: string;
  data: Uint8Array;
}

export function normalizeV3Entries(rawEntries: unknown): unknown[] {
  if (!rawEntries) return [];
  if (Array.isArray(rawEntries)) {
    return rawEntries.filter((e) => e !== null && typeof e === 'object');
  }
  if (typeof rawEntries === 'object') {
    // Legacy object shape: { "0": {...}, "1": {...} }
    const values = Object.values(rawEntries);
    return values.filter((e) => e !== null && typeof e === 'object');
  }
  return [];
}

export function v3EntryToWorldInfoEntry(e: unknown, index: number): WorldInfoEntry {
  const obj = e as Record<string, unknown>;
  const position = typeof obj.position === 'string' ? obj.position : 'before_char';
  const validPositions = new Set<WorldInfoEntry['position']>(['before_char', 'after_char', 'top', 'bottom', 'atDepth']);

  const entry: WorldInfoEntry = {
    id: str(obj.id, String(index)),
    keys: Array.isArray(obj.keys) ? obj.keys.filter((k): k is string => typeof k === 'string') : [],
    content: typeof obj.content === 'string' ? obj.content : '',
    comment: typeof obj.comment === 'string' ? obj.comment : '',
    order: typeof obj.insertion_order === 'number' ? obj.insertion_order : 100,
    position: validPositions.has(position as WorldInfoEntry['position']) ? (position as WorldInfoEntry['position']) : 'before_char',
    probability: 100,
    constant: Boolean(obj.constant),
    selective: Boolean(obj.selective),
    secondaryKeys: Array.isArray(obj.secondaryKeys) ? obj.secondaryKeys.filter((k): k is string => typeof k === 'string') : [],
    addMemo: false,
    disable: obj.enabled === false,
    regex: Boolean(obj.use_regex),
    recursive: false,
    retrievalMode: obj.constant ? 'constant' : 'keyword',
  };

  if (entry.position === 'atDepth') {
    entry.depth = typeof obj.depth === 'number' ? obj.depth : 0;
    const role = typeof obj.role === 'string' ? obj.role : 'system';
    entry.role = ['system', 'user', 'assistant'].includes(role) ? (role as WorldInfoEntry['role']) : 'system';
  }

  return entry;
}

/**
 * Convert a loose spec card (snake_case) into our internal camelCase shape.
 * Unknown fields are preserved via passthrough.
 */
function normalizeCharacterFields(raw: unknown): z.infer<typeof cardDataSchema> {
  const card = LooseCardDataSchema.parse(raw);

  const normalized = {
    name: card.name ?? '',
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    firstMes: card.first_mes,
    mesExample: card.mes_example,
    creatorNotes: card.creator_notes,
    systemPrompt: card.system_prompt,
    postHistoryInstructions: card.post_history_instructions,
    alternateGreetings: card.alternate_greetings,
    groupOnlyGreetings: card.group_only_greetings,
    characterVersion: card.character_version,
    creatorNotesMultilingual: card.creator_notes_multilingual,
    createDate: card.create_date,
    tags: card.tags,
    creator: card.creator,
    nickname: card.nickname,
    source: card.source,
    extensions: card.extensions,
  };

  // Preserve unknown fields (extensions, forward-compat additions, etc.)
  for (const [key, value] of Object.entries(card)) {
    if (!(key in normalized)) {
      (normalized as Record<string, unknown>)[key] = value;
    }
  }

  const textFields = ['description', 'personality', 'scenario', 'firstMes', 'mesExample', 'creatorNotes', 'systemPrompt', 'postHistoryInstructions'] as const;
  for (const key of textFields) {
    if (typeof normalized[key] === 'string') {
      (normalized as Record<string, unknown>)[key] = normalizeRisuMacros(normalized[key]);
    }
  }
  if (Array.isArray(normalized.alternateGreetings)) {
    normalized.alternateGreetings = normalized.alternateGreetings.map(normalizeRisuMacros);
  }
  if (Array.isArray(normalized.groupOnlyGreetings)) {
    normalized.groupOnlyGreetings = normalized.groupOnlyGreetings.map(normalizeRisuMacros);
  }

  return cardDataSchema.parse(normalized);
}

export function normalizeRisuMacros(text: string): string {
  if (!text) return text;

  let result = '';
  let i = 0;

  while (i < text.length) {
    const idx = text.indexOf('{{', i);
    if (idx === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, idx);

    // Find matching }} respecting nested {{ }}
    let end = idx + 2;
    let depth = 1;
    while (end < text.length - 1 && depth > 0) {
      if (text[end] === '{' && text[end + 1] === '{') {
        depth++;
        end += 2;
      } else if (text[end] === '}' && text[end + 1] === '}') {
        depth--;
        if (depth === 0) break;
        end += 2;
      } else {
        end++;
      }
    }
    if (depth > 0) {
      result += text.slice(idx);
      break;
    }

    const content = text.slice(idx + 2, end);

    // RisuAI block syntax → our {% %} block syntax
    if (content.startsWith('#if ')) {
      result += `{% if ${normalizeRisuMacros(content.slice(4).trim())} %}`;
    } else if (content === '/if') {
      result += '{% endif %}';
    } else if (content === 'else') {
      result += '{% else %}';
    } else if (content.startsWith('elsif ')) {
      result += `{% elsif ${normalizeRisuMacros(content.slice(6).trim())} %}`;
    } else if (content.startsWith('elif ')) {
      result += `{% elsif ${normalizeRisuMacros(content.slice(5).trim())} %}`;
    } else if (content.startsWith('? ')) {
      // {{? expr}} → expr (truthy wrapper is redundant inside {% if %})
      result += content.slice(2).trim();
    } else {
      // Regular macro expression — keep as-is
      result += `{{${content}}}`;
    }

    i = end + 2;
  }

  return result;
}

export async function importCharacterBook(
  rawBook: unknown,
  charId: string,
  charName: string,
  worldInfoRepo: IWorldInfoRepository,
  bus: EventBus,
): Promise<string | null> {
  if (!rawBook || typeof rawBook !== 'object') return null;

  const book = rawBook as Record<string, unknown>;
  const rawEntries = book.entries;
  const entries = normalizeV3Entries(rawEntries).map((e, i) => v3EntryToWorldInfoEntry(e, i));

  if (entries.length === 0) return null;

  const worldInfoId = `char:${charId}:book`;
  const name = typeof book.name === 'string' ? book.name : `${charName} Book`;

  const created = await worldInfoRepo.create(worldInfoId, { name, entries });
  // An import is an HTTP mutation of shared state: broadcast so every client's
  // World Info sidebar reflects the new lorebook without a reconnect (AGENTS.md §4/§5).
  bus.broadcast({ type: 'worldinfo.created', book: created });
  bus.broadcast({ type: 'worldinfo.snapshot', book: created });
  const books = await worldInfoRepo.list();
  bus.broadcast({ type: 'worldinfo.listed', books });
  return worldInfoId;
}

export function createCharacterRouter(
  characters: ICharacterRepository,
  assets: ICharacterAssetRepository,
  worldInfo: IWorldInfoRepository,
  storage: FileStorage,
  bus: EventBus,
): Router {
  const router = Router();

  // ---------- Avatar ----------

  router.post('/:id/avatar', upload.single('avatar'), (async (req, res) => {
    try {
      const character = await characters.getById(req.params.id as string);
      if (!character) {
        res.status(404).json({ error: 'Character not found' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      await setCharacterAvatarFromBuffer({ characters, characterAssets: assets, storage, bus }, character, req.file.buffer);
      res.json({ success: true });
    } catch (err) {
      log.error({ err }, 'avatar upload error');
      res.status(500).json({ error: 'Upload failed' });
    }
  }));



  // ---------- Assets ----------

  router.get('/:id/assets/:assetId', (async (req, res) => {
    try {
      // Fast path: serve directly from disk when the URL includes the file extension.
      const directPath = `files/character_assets/${req.params.id}/${req.params.assetId}`;
      if (storage.exists(directPath)) {
        const contentType = mime.lookup(req.params.assetId) || 'application/octet-stream';
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        // dotfiles: 'allow' — see attachments route in main.ts.
        res.sendFile(storage.resolve(directPath), { dotfiles: 'allow' });
        return;
      }

      // Fallback: DB lookup for legacy extension-less URLs.
      const asset = await assets.getById(req.params.assetId);
      if (!asset || !asset.filePath) {
        res.status(404).json({ error: 'Asset not found' });
        return;
      }

      const contentType = mime.lookup(asset.ext) || 'application/octet-stream';
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      // dotfiles: 'allow' — see attachments route in main.ts.
      res.sendFile(storage.resolve(asset.filePath), { dotfiles: 'allow' });
    } catch (err) {
      log.error({ err }, 'asset serve error');
      res.status(500).json({ error: 'Failed to serve asset' });
    }
  }));

  // ---------- Import V2/V3/CharX Card ----------

  router.post('/import', upload.single('file'), (async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const fileType = detectFileType(req.file.buffer);

      if (fileType === 'json') {
        // JSON cards carry no embedded assets or avatar — no asset/storage access needed.
        const result = await importJsonCard(req.file.buffer, characters, worldInfo, bus);
        res.json({ success: true, character: result });
        return;
      }

      if (fileType === 'charx') {
        const result = await importCharXCard(req.file.buffer, characters, assets, storage, worldInfo, bus);
        res.json({ success: true, character: result });
        return;
      }

      if (fileType === 'png') {
        const result = await importPngCard(req.file.buffer, characters, storage, worldInfo, bus);
        res.json({ success: true, character: result });
        return;
      }

      res.status(400).json({ error: 'Unsupported file format. Upload a PNG, CharX, or JSON card.' });
    } catch (err) {
      log.error({ err }, 'import error');
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid card schema', details: err.issues });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Import failed' });
    }
  }));

  // ---------- Export V3/CharX Card ----------

  // ---------- RisuAI module attach/detach (raw .risum for the porting workflow) ----------

  // Read endpoints — the frontend porting surface (module viewer). List returns
  // metadata only; section reads load the raw module JSON from FileStorage.
  router.get('/:id/risu-modules', (async (req, res) => {
    try {
      const character = await characters.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: 'Character not found' });
        return;
      }
      const metas = listRisuModuleMeta(character);
      res.json({ total: metas.length, modules: metas });
    } catch (err) {
      log.error({ err }, 'risu-module list error');
      res.status(500).json({ error: err instanceof Error ? err.message : 'List failed' });
    }
  }));

  router.get('/:id/risu-modules/:moduleId', (async (req, res) => {
    try {
      const character = await characters.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: 'Character not found' });
        return;
      }
      const meta = listRisuModuleMeta(character).find((m) => m.id === req.params.moduleId);
      if (!meta) {
        res.status(404).json({ error: 'Module not found' });
        return;
      }
      const sectionParam = typeof req.query['section'] === 'string' ? req.query['section'] : 'info';
      if (!RISU_MODULE_SECTIONS.includes(sectionParam as RisuModuleSection)) {
        res.status(400).json({ error: `Unknown section "${sectionParam}" (expected one of ${RISU_MODULE_SECTIONS.join(', ')})` });
        return;
      }
      const module = loadRisuModule(storage, meta);
      if (!module) {
        res.status(404).json({ error: 'Stored module data is missing on disk' });
        return;
      }
      const indexParam = typeof req.query['index'] === 'string' ? Number.parseInt(req.query['index'], 10) : undefined;
      const result = getRisuModuleSection(
        module,
        sectionParam as RisuModuleSection,
        indexParam !== undefined && Number.isInteger(indexParam) ? indexParam : undefined,
      );
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result.data);
    } catch (err) {
      log.error({ err }, 'risu-module section error');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Read failed' });
    }
  }));

  router.post('/:id/risu-module', upload.single('file'), (async (req, res) => {
    try {
      const character = await characters.getById(req.params.id as string);
      if (!character) {
        res.status(404).json({ error: 'Character not found' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      let parsed;
      try {
        parsed = parseRisum(req.file.buffer);
      } catch (err) {
        if (err instanceof RisumParseError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }

      const meta = storeRisuModule(storage, character.id, parsed.module, 'attached');
      // Asset payloads land as ordinary character assets (servable/exportable);
      // asset packs (Lightboard Music/NSFW-style modules) are the main case.
      const assetsStored = await storeRisuModuleAssets(
        storage,
        assets,
        character.id,
        parsed.module,
        parsed.assets,
        meta.id,
      );
      const metas = [...listRisuModuleMeta(character), meta];
      const updated = await characters.update(character.id, {
        extensions: { ...character.extensions, [CHARACTER_RISU_MODULES_EXTENSION_KEY]: metas },
      });
      bus.broadcast({ type: 'character.updated', character: withCharacterAvatar(updated) });
      bus.broadcast({ type: 'character.snapshot', character: withCharacterAvatar(updated) });
      const list = await characters.listSummaries();
      bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) });
      res.json({ success: true, module: meta, assetsStored });
    } catch (err) {
      log.error({ err }, 'risu-module attach error');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Attach failed' });
    }
  }));

  router.delete('/:id/risu-module/:moduleId', (async (req, res) => {
    try {
      const character = await characters.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: 'Character not found' });
        return;
      }
      const moduleId = req.params.moduleId;
      const metas = listRisuModuleMeta(character);
      if (!metas.some((m) => m.id === moduleId)) {
        res.status(404).json({ error: 'Module not found' });
        return;
      }
      const remaining = removeRisuModule(storage, character, moduleId);
      const updated = await characters.update(character.id, {
        extensions: { ...character.extensions, [CHARACTER_RISU_MODULES_EXTENSION_KEY]: remaining },
      });
      bus.broadcast({ type: 'character.updated', character: withCharacterAvatar(updated) });
      bus.broadcast({ type: 'character.snapshot', character: withCharacterAvatar(updated) });
      const list = await characters.listSummaries();
      bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) });
      res.json({ success: true, removed: moduleId });
    } catch (err) {
      log.error({ err }, 'risu-module delete error');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  }));

  router.get('/:id/export', (async (req, res) => {
    try {
      const character = await characters.getById(req.params.id);
      if (!character) {
        res.status(404).json({ error: 'Character not found' });
        return;
      }

      const format = req.query.format === 'v2' ? 'v2' : req.query.format === 'charx' ? 'charx' : 'v3';
      const safeName = character.name.replace(/[^a-zA-Z0-9._-]/g, '_');

      let characterBook: BuildCardOptions['characterBook'] | undefined;
      if (character.worldInfoId) {
        const book = await worldInfo.getById(character.worldInfoId);
        if (book && book.entries.length > 0) {
          characterBook = { name: book.name, entries: book.entries };
        }
      }

      if (format === 'charx') {
        const assetList = await assets.listForCharacter(character.id);
        const cardOpts: BuildCardOptions = {
          format: 'v3',
          assets: assetList.map((a) => ({
            name: a.name,
            type: a.type,
            ext: a.ext,
            uri: buildAssetUri(`${a.type}s/${a.name}.${a.ext}`),
          })),
          characterBook,
        };
        const card = buildCardJson(character, cardOpts);
        const cardJson = JSON.stringify(card);

        const zipFiles: Record<string, Uint8Array> = {
          'card.json': new Uint8Array(Buffer.from(cardJson)),
        };

        for (const asset of assetList) {
          if (asset.filePath && storage.exists(asset.filePath)) {
            const data = storage.read(asset.filePath);
            const zipPath = `${asset.type}s/${sanitizeAssetName(asset.name)}.${asset.ext}`;
            zipFiles[zipPath] = new Uint8Array(data);
          }
        }

        const zipBuffer = Buffer.from(zipSync(zipFiles, { level: 6 }));
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename="${safeName}.charx"`);
        res.send(zipBuffer);
        return;
      }

      const card = buildCardJson(character, { format, characterBook });
      const json = JSON.stringify(card);

      const avatarBuffer = character.avatarPath ? storage.read(character.avatarPath) : null;
      const pngBuffer = avatarBuffer
        ? embedPngMetadata(avatarBuffer, json, format)
        : createPngWithMetadata(json, format);

      res.set('Content-Type', 'image/png');
      res.set('Content-Disposition', `attachment; filename="${safeName}.png"`);
      res.send(pngBuffer);
    } catch (err) {
      log.error({ err }, 'export error');
      res.status(500).json({ error: 'Export failed' });
    }
  }));

  return router;
}

// ---------- File type detection ----------

function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    // RIFF container — could be WebP
    if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  }
  return null;
}

function detectFileType(buffer: Buffer): 'png' | 'charx' | 'json' | 'unknown' {
  if (buffer.length < 4) return 'unknown';

  // PNG signature
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }

  // ZIP signature (CharX)
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return 'charx';
  }

  // Polyglot: scan deeper for ZIP signature (JPEG+ZIP, etc.)
  for (let i = 1; i < Math.min(buffer.length - 4, 1024 * 1024); i++) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x03 && buffer[i + 3] === 0x04) {
      return 'charx';
    }
  }

  // JSON
  const firstNonWs = buffer.toString('utf-8', 0, Math.min(20, buffer.length)).trim()[0];
  if (firstNonWs === '{' || firstNonWs === '[') {
    return 'json';
  }

  return 'unknown';
}

// ---------- Import helpers ----------

async function importPngCard(
  buffer: Buffer,
  characters: ICharacterRepository,
  storage: FileStorage,
  worldInfo: IWorldInfoRepository,
  bus: EventBus,
) {
  const meta = extractPngMetadata(buffer);
  const raw = meta.v3 ?? meta.v2;
  if (!raw) {
    throw new Error('No character metadata found in PNG');
  }

  const card = JSON.parse(raw) as Record<string, unknown>;
  const data = (card.data ?? card) as Record<string, unknown>;
  const parsed = normalizeCharacterFields(data);

  const id = randomUUID();
  const avatarFileName = `${randomUUID()}.png`;
  const avatarPath = storage.write('avatars', avatarFileName, new Uint8Array(buffer));
  let thumbnailPath: string | null = null;
  try {
    const thumb = await resizeThumbnail(buffer);
    const thumbFileName = `${randomUUID()}.png`;
    thumbnailPath = storage.write('avatars/thumbs', thumbFileName, new Uint8Array(thumb));
  } catch (err) {
    log.warn({ err }, 'thumbnail generation failed for PNG import');
  }

  const worldInfoId = await importCharacterBook(
    data.character_book,
    id,
    parsed.name,
    worldInfo,
    bus,
  );

  const character = await characters.create(id, {
    name: parsed.name,
    description: parsed.description ?? '',
    personality: parsed.personality ?? '',
    scenario: parsed.scenario ?? '',
    firstMes: parsed.firstMes ?? '',
    mesExample: parsed.mesExample ?? '',
    creator: parsed.creator ?? '',
    characterVersion: parsed.characterVersion ?? '',
    tags: parsed.tags ?? [],
    avatarPath: avatarPath,
    avatarThumbnailPath: thumbnailPath,
    creatorNotes: parsed.creatorNotes ?? '',
    systemPrompt: parsed.systemPrompt ?? '',
    postHistoryInstructions: parsed.postHistoryInstructions ?? '',
    alternateGreetings: parsed.alternateGreetings ?? [],
    groupOnlyGreetings: parsed.groupOnlyGreetings ?? [],
    nickname: parsed.nickname ?? '',
    creatorNotesMultilingual: parsed.creatorNotesMultilingual ?? {},
    source: parsed.source ?? [],
    extensions: parsed.extensions ?? {},
    createDate: parsed.createDate ?? new Date().toISOString(),
    worldInfoId: worldInfoId,
  });

  bus.broadcast({ type: 'character.created', character: withCharacterAvatar(character) });
  const list = await characters.listSummaries();
  bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) });
  return character;
}

async function importJsonCard(
  buffer: Buffer,
  characters: ICharacterRepository,
  worldInfo: IWorldInfoRepository,
  bus: EventBus,
) {
  const text = buffer.toString('utf-8');
  const card = JSON.parse(text) as Record<string, unknown>;
  const data = (card.data ?? card) as Record<string, unknown>;
  const parsed = normalizeCharacterFields(data);

  const id = randomUUID();
  const worldInfoId = await importCharacterBook(
    data.character_book,
    id,
    parsed.name,
    worldInfo,
    bus,
  );

  const character = await characters.create(id, {
    name: parsed.name,
    description: parsed.description ?? '',
    personality: parsed.personality ?? '',
    scenario: parsed.scenario ?? '',
    firstMes: parsed.firstMes ?? '',
    mesExample: parsed.mesExample ?? '',
    creator: parsed.creator ?? '',
    characterVersion: parsed.characterVersion ?? '',
    tags: parsed.tags ?? [],
    avatarPath: null,
    creatorNotes: parsed.creatorNotes ?? '',
    systemPrompt: parsed.systemPrompt ?? '',
    postHistoryInstructions: parsed.postHistoryInstructions ?? '',
    alternateGreetings: parsed.alternateGreetings ?? [],
    groupOnlyGreetings: parsed.groupOnlyGreetings ?? [],
    nickname: parsed.nickname ?? '',
    creatorNotesMultilingual: parsed.creatorNotesMultilingual ?? {},
    source: parsed.source ?? [],
    extensions: parsed.extensions ?? {},
    createDate: parsed.createDate ?? new Date().toISOString(),
    worldInfoId: worldInfoId,
  });

  bus.broadcast({ type: 'character.created', character: withCharacterAvatar(character) });
  const list = await characters.listSummaries();
  bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) });
  return character;
}

async function importCharXCard(
  buffer: Buffer,
  characters: ICharacterRepository,
  assetRepo: ICharacterAssetRepository,
  storage: FileStorage,
  worldInfo: IWorldInfoRepository,
  bus: EventBus,
) {
  const { card, avatarBuffer, assets: assetDefs, moduleBuffer } = parseCharX(buffer);
  const cardRec = card as Record<string, unknown>;
  const data = (cardRec.data ?? card) as Record<string, unknown>;
  const parsed = normalizeCharacterFields(data);

  const id = randomUUID();

  // Preserve the embedded RisuAI module (triggerscripts/regex/native lorebook)
  // as raw JSON for the porting workflow. A corrupt module never bricks the import.
  const risuModuleMetas: RisuModuleMeta[] = [];
  if (moduleBuffer) {
    try {
      const { module: risuModule } = parseRisum(moduleBuffer, { skipAssetPayloads: true });
      risuModuleMetas.push(storeRisuModule(storage, id, risuModule, 'embedded'));
    } catch (err) {
      log.warn({ err }, 'embedded module.risum decode failed, importing card without it');
    }
  }

  const extensions = { ...(parsed.extensions ?? {}) };
  if (risuModuleMetas.length > 0) {
    extensions[CHARACTER_RISU_MODULES_EXTENSION_KEY] = risuModuleMetas;
  }

  // Set avatar from icon asset if available
  let avatarPath: string | null = null;
  let thumbnailPath: string | null = null;
  if (avatarBuffer) {
    const mimeType = detectImageMime(avatarBuffer);
    const avatarFileName = `${randomUUID()}.${mimeType === 'image/webp' ? 'webp' : 'png'}`;
    if (mimeType === 'image/webp') {
      // Jimp cannot decode WebP; save raw
      avatarPath = storage.write('avatars', avatarFileName, new Uint8Array(avatarBuffer));
    } else {
      try {
        const resized = await resizeAvatar(avatarBuffer);
        avatarPath = storage.write('avatars', avatarFileName, new Uint8Array(resized));
      } catch (resizeErr) {
        log.warn({ err: resizeErr }, 'avatar resize failed, saving raw icon');
        const fallbackExt = mimeType === 'image/gif' ? 'gif' : 'png';
        const fallbackFileName = `${randomUUID()}.${fallbackExt}`;
        avatarPath = storage.write('avatars', fallbackFileName, new Uint8Array(avatarBuffer));
      }
    }
    try {
      const thumb = await resizeThumbnail(avatarBuffer);
      const thumbFileName = `${randomUUID()}.png`;
      thumbnailPath = storage.write('avatars/thumbs', thumbFileName, new Uint8Array(thumb));
    } catch (err) {
      log.warn({ err }, 'thumbnail generation failed for CharX import');
    }
  }

  const worldInfoId = await importCharacterBook(
    data.character_book,
    id,
    parsed.name,
    worldInfo,
    bus,
  );

  const character = await characters.create(id, {
    name: parsed.name,
    description: parsed.description ?? '',
    personality: parsed.personality ?? '',
    scenario: parsed.scenario ?? '',
    firstMes: parsed.firstMes ?? '',
    mesExample: parsed.mesExample ?? '',
    creator: parsed.creator ?? '',
    characterVersion: parsed.characterVersion ?? '',
    tags: parsed.tags ?? [],
    avatarPath: avatarPath,
    avatarThumbnailPath: thumbnailPath,
    creatorNotes: parsed.creatorNotes ?? '',
    systemPrompt: parsed.systemPrompt ?? '',
    postHistoryInstructions: parsed.postHistoryInstructions ?? '',
    alternateGreetings: parsed.alternateGreetings ?? [],
    groupOnlyGreetings: parsed.groupOnlyGreetings ?? [],
    nickname: parsed.nickname ?? '',
    creatorNotesMultilingual: parsed.creatorNotesMultilingual ?? {},
    source: parsed.source ?? [],
    extensions,
    createDate: parsed.createDate ?? new Date().toISOString(),
    worldInfoId: worldInfoId,
  });

  // Extract and store assets
  if (assetDefs.length > 0) {
    const extracted = extractCharXAssets(buffer, assetDefs);
    for (const def of assetDefs) {
      const buf = extracted.get(def.zipPath);
      if (!buf) continue;

      const assetId = randomUUID();
      const safeName = sanitizeAssetName(def.name);
      const fileName = `${assetId}.${def.ext}`;
      const relPath = storage.write(`character_assets/${id}`, fileName, new Uint8Array(buf));

      await assetRepo.create(id, {
        id: assetId,
        name: safeName,
        type: def.type,
        ext: def.ext,
        filePath: relPath,
        meta: { zipPath: def.zipPath },
      });
    }
  }

  const assetList = await assetRepo.listForCharacter(id);
  const enriched = { ...withCharacterAvatar(character), assets: assetList };
  bus.broadcast({ type: 'character.created', character: enriched });
  const list = await characters.listSummaries();
  bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) });
  return enriched;
}

// ---------- PNG metadata helpers ----------

function extractPngMetadata(buffer: Buffer): { v2?: string; v3?: string } {
  const chunks = extract(new Uint8Array(buffer));
  const textChunks = chunks.filter((c) => c.name === 'tEXt').map((c) => PNGtext.decode(c.data));

  const v2 = textChunks.find((t) => t.keyword.toLowerCase() === 'chara');
  const v3 = textChunks.find((t) => t.keyword.toLowerCase() === 'ccv3');

  return {
    v2: v2 ? Buffer.from(v2.text, 'base64').toString('utf-8') : undefined,
    v3: v3 ? Buffer.from(v3.text, 'base64').toString('utf-8') : undefined,
  };
}

function embedPngMetadata(pngBuffer: Buffer, json: string, format: 'v2' | 'v3'): Buffer {
  const chunks = extract(new Uint8Array(pngBuffer));
  const ihdrIndex = chunks.findIndex((c) => c.name === 'IHDR');
  const insertAt = ihdrIndex >= 0 ? ihdrIndex + 1 : 1;

  if (format === 'v3') {
    // Write ccv3 chunk (primary) and chara chunk (V2 backward compat)
    const ccv3Chunk = PNGtext.encode('ccv3', Buffer.from(json).toString('base64'));
    const v2Json = JSON.stringify(stripToV2(JSON.parse(json)));
    const charaChunk = PNGtext.encode('chara', Buffer.from(v2Json).toString('base64'));
    chunks.splice(insertAt, 0, ccv3Chunk, charaChunk);
  } else {
    const tEXt = PNGtext.encode('chara', Buffer.from(json).toString('base64'));
    chunks.splice(insertAt, 0, tEXt);
  }

  return Buffer.from(encodeChunks(chunks));
}

export function createPngWithMetadata(json: string, format: 'v2' | 'v3'): Buffer {
  // Minimal 1x1 PNG + metadata
  const minimalPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  return embedPngMetadata(minimalPng, json, format);
}

/**
 * Strip a V3 card down to V2-compatible shape for the `chara` backfill chunk.
 */
function stripToV2(card: unknown): TavernCard {
  const parsed = LooseCardDataSchema.parse(card);
  const v2Data: TavernCardV2Data = {
    name: parsed.name ?? '',
    description: parsed.description ?? '',
    personality: parsed.personality ?? '',
    scenario: parsed.scenario ?? '',
    first_mes: parsed.first_mes ?? '',
    mes_example: parsed.mes_example ?? '',
    creator_notes: parsed.creator_notes ?? '',
    system_prompt: parsed.system_prompt ?? '',
    post_history_instructions: parsed.post_history_instructions ?? '',
    alternate_greetings: parsed.alternate_greetings ?? [],
    tags: parsed.tags ?? [],
    creator: parsed.creator ?? '',
    character_version: parsed.character_version ?? '',
    extensions: parsed.extensions ?? {},
  };

  const result = buildTavernCard('v2', v2Data);
  if (parsed.create_date) {
    (result as Record<string, unknown>).create_date = parsed.create_date;
  }
  return result;
}

function encodeChunks(chunks: PngChunk[]): Uint8Array {
  // PNG signature
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts: Uint8Array[] = [signature];

  for (const chunk of chunks) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, chunk.data.length, false);
    const name = new TextEncoder().encode(chunk.name);
    const crc = computeCrc32(concat([name, chunk.data]));
    const crcBytes = new Uint8Array(4);
    new DataView(crcBytes.buffer).setUint32(0, crc, false);
    parts.push(len, name, chunk.data, crcBytes);
  }

  return concat(parts);
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// Simple CRC32 for PNG chunk integrity
function computeCrc32(data: Uint8Array): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  let crc = ~0;
  for (const byte of data) {
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}
