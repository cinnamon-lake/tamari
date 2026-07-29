import type { Character } from '@tamari/types';

function sanitizeAssetNameInternal(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function findAssetByPlainName(
  filename: string,
  assets: Array<{ name: string; assetUrl?: string | null }>,
): string | null {
  const sanitized = sanitizeAssetNameInternal(filename);
  const base = sanitized.replace(/\.[^.]+$/, ''); // strip extension
  if (!base) return null;

  const matches: Array<{ url: string; priority: number }> = [];
  for (const asset of assets) {
    if (!asset.assetUrl || !asset.name) continue;
    const assetName = sanitizeAssetNameInternal(asset.name);
    if (assetName.includes(base)) {
      const priority = assetName.startsWith('Normal_') ? 0 : 1;
      matches.push({ url: asset.assetUrl, priority });
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => a.priority - b.priority);
  return matches[0]!.url;
}

/**
 * Resolve embeded:// URIs and plain filename `src` attributes in character card
 * content to actual API URLs.
 *
 * Matches both `embeded://` (spec misspelling) and `embedded://` (correct spelling).
 * Also resolves raw HTML `<img src="File Name.png">` by fuzzy-matching against
 * the character's asset list (sanitized names, preferring "Normal_" prefix).
 */
export function resolveEmbeddedUris(content: string, character: Character | undefined): string {
  if (!character?.assets?.length) return content;

  const assetMap = new Map<string, string>();
  for (const asset of character.assets) {
    if (!asset.assetUrl) continue;
    if (asset.uri) {
      assetMap.set(asset.uri, asset.assetUrl);
      // Also map the correct spelling for compatibility
      if (asset.uri.startsWith('embeded://')) {
        assetMap.set(asset.uri.replace('embeded://', 'embedded://'), asset.assetUrl);
      }
    }
  }

  let result = content;

  // Replace embeded:// and embedded:// URIs in src attributes
  if (assetMap.size > 0) {
    result = result.replace(
      /src=["'](embeded:\/\/[^"']+|embedded:\/\/[^"']+)["']/gi,
      (match: string, uri: string) => {
        const resolved = assetMap.get(uri);
        if (resolved) {
          return `src="${resolved}"`;
        }
        return match;
      },
    );
  }

  // Replace plain filename src attributes (e.g. <img src="Marisa Kirisame.png">)
  result = result.replace(
    /src=["']([^"']+\.(?:png|jpe?g|gif|webp|bmp))["']/gi,
    (match: string, filename: string) => {
      const resolved = findAssetByPlainName(filename, character.assets ?? []);
      if (resolved) {
        return `src="${resolved}"`;
      }
      return match;
    },
  );

  return result;
}

/** Build an embeded:// URI from a zip path (for CharX asset references). */
export function buildAssetUri(zipPath: string): string {
  return `embeded://${zipPath}`;
}

/** Sanitize an asset name for safe filesystem storage. */
export function sanitizeAssetName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/(^_+|_+$)/g, '')
    || 'asset';
}
