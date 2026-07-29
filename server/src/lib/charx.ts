/**
 * CharX (ZIP-based character card) parser and extractor.
 *
 * Handles:
 * - Standard ZIP archives (.charx)
 * - Polyglot/SFX archives (image prepended + ZIP, e.g. JPEG+ZIP)
 * - Asset URI normalization: embeded://, embedded://, __asset:
 *
 * Uses fflate for ZIP decompression (already available in workspace).
 */

import { unzipSync, strFromU8 } from 'fflate';
import { str } from './coerce.js';


// ZIP local file header signature: PK\x03\x04
const ZIP_SIGNATURE = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

const EMBEDDED_URI_PREFIXES = ['embeded://', 'embedded://', '__asset:'];
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'bmp', 'jfif']);

export interface CharXAssetDef {
  zipPath: string;
  type: string;
  name: string;
  ext: string;
}

export interface CharXParseResult {
  card: unknown;
  avatarBuffer?: Buffer;
  assets: CharXAssetDef[];
  /** Raw bytes of the embedded `module.risum` (RisuAI module), if the archive has one. */
  moduleBuffer?: Buffer;
}

function findZipOffset(buffer: Uint8Array): number {
  // Scan for ZIP local file header signature
  for (let i = 0; i <= buffer.length - 4; i++) {
    if (
      buffer[i] === ZIP_SIGNATURE[0] &&
      buffer[i + 1] === ZIP_SIGNATURE[1] &&
      buffer[i + 2] === ZIP_SIGNATURE[2] &&
      buffer[i + 3] === ZIP_SIGNATURE[3]
    ) {
      return i;
    }
  }
  return -1;
}

function normalizeZipPath(raw: string): string {
  // Remove leading slashes, normalize backslashes
  return raw.replace(/\\/g, '/').replace(/^\/+/, '');
}

function getEmbeddedZipPathFromUri(uri: string): string | null {
  if (typeof uri !== 'string') return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const prefix of EMBEDDED_URI_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return normalizeZipPath(trimmed.slice(prefix.length));
    }
  }
  return null;
}

function normalizeExt(ext: string): string {
  return ext.trim().toLowerCase().replace(/^\./, '');
}

function deriveExt(assetExt: string, zipPath: string): string {
  const metaExt = normalizeExt(assetExt);
  if (metaExt) return metaExt;
  const match = zipPath.match(/\.([a-zA-Z0-9]+)$/);
  return match?.[1] ? normalizeExt(match[1]) : 'png';
}

function collectAssets(card: unknown): CharXAssetDef[] {
  const data = (card as Record<string, unknown> | undefined)?.data;
  const assets = (data as Record<string, unknown> | undefined)?.assets;
  if (!Array.isArray(assets)) return [];

  return assets
    .map((asset: unknown) => {
      if (!asset || typeof asset !== 'object') return null;
      const a = asset as Record<string, unknown>;
      const uri = typeof a.uri === 'string' ? a.uri : '';
      const zipPath = getEmbeddedZipPathFromUri(uri);
      if (!zipPath) return null;

      const ext = deriveExt(str(a.ext), zipPath);
      const type = typeof a.type === 'string' ? a.type.toLowerCase() : 'other';
      const name = typeof a.name === 'string' ? a.name : '';

      return { zipPath, type, name, ext };
    })
    .filter((a): a is CharXAssetDef => a !== null);
}

function pickIconAsset(assets: CharXAssetDef[]): CharXAssetDef | null {
  const icons = assets.filter((a) => a.type === 'icon' && IMAGE_EXTENSIONS.has(a.ext) && a.zipPath);
  if (icons.length === 0) return null;
  const main = icons.find((a) => a.name.toLowerCase() === 'main');
  return main ?? icons[0] ?? null;
}

export function parseCharX(buffer: Buffer): CharXParseResult {
  const u8 = new Uint8Array(buffer);
  const zipOffset = findZipOffset(u8);
  if (zipOffset === -1) {
    throw new Error('Not a valid ZIP/CharX file: no ZIP signature found');
  }

  const zipData = u8.slice(zipOffset);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zipData, { filter: (file) => !file.name.endsWith('/') });
  } catch (err) {
    throw new Error(`Failed to parse ZIP: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Find card.json (case-insensitive)
  const cardEntryName = Object.keys(files).find((k) => k.toLowerCase() === 'card.json');
  if (!cardEntryName) {
    throw new Error('CharX archive missing card.json');
  }

  const cardBytes = files[cardEntryName];
  if (!cardBytes) {
    throw new Error('CharX archive missing card.json');
  }
  const cardText = strFromU8(cardBytes);
  let card: unknown;
  try {
    card = JSON.parse(cardText);
  } catch {
    throw new Error('Invalid card.json: not valid JSON');
  }

  const assets = collectAssets(card);
  const iconAsset = pickIconAsset(assets);

  let avatarBuffer: Buffer | undefined;
  if (iconAsset) {
    const iconData = files[iconAsset.zipPath];
    if (iconData) {
      avatarBuffer = Buffer.from(iconData);
    }
  }

  // Embedded RisuAI module (triggerscripts, regex scripts, native lorebook).
  const moduleEntryName = Object.keys(files).find((k) => k.toLowerCase() === 'module.risum');
  const moduleData = moduleEntryName ? files[moduleEntryName] : undefined;
  const moduleBuffer = moduleData ? Buffer.from(moduleData) : undefined;

  return { card, avatarBuffer, assets, moduleBuffer };
}

export function extractCharXAssets(
  buffer: Buffer,
  assetDefs: CharXAssetDef[],
): Map<string, Buffer> {
  const u8 = new Uint8Array(buffer);
  const zipOffset = findZipOffset(u8);
  if (zipOffset === -1) {
    throw new Error('Not a valid ZIP/CharX file: no ZIP signature found');
  }

  const zipData = u8.slice(zipOffset);
  const files = unzipSync(zipData, { filter: (file) => !file.name.endsWith('/') });

  const result = new Map<string, Buffer>();
  for (const def of assetDefs) {
    const data = files[def.zipPath];
    if (data) {
      result.set(def.zipPath, Buffer.from(data));
    }
  }
  return result;
}

export function buildAssetUri(zipPath: string): string {
  return `embeded://${zipPath}`;
}

export function sanitizeAssetName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/(^_+|_+$)/g, '')
    || 'asset';
}
