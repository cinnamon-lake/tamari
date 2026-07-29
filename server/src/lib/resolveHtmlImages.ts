import type { CharacterAsset } from '@tamari/types';

function sanitizeAssetName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function findAssetUrl(
  filename: string,
  assets: CharacterAsset[],
  characterId: string,
): string | null {
  const sanitized = sanitizeAssetName(filename);
  const base = sanitized.replace(/\.[^.]+$/, '');
  if (!base) return null;

  const matches: Array<{ url: string; priority: number }> = [];
  for (const asset of assets) {
    if (!asset.filePath || !asset.name) continue;
    const assetName = sanitizeAssetName(asset.name);
    if (assetName.includes(base)) {
      const priority = assetName.startsWith('Normal_') ? 0 : 1;
      matches.push({
        url: `/api/characters/${characterId}/assets/${asset.id}.${asset.ext}`,
        priority,
      });
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => a.priority - b.priority);
  return matches[0]?.url ?? null;
}

/**
 * Replace plain-filename `src` attributes in HTML `<img>` tags with canonical
 * asset URLs.  This is the server-side counterpart to the client's
 * `resolveEmbeddedUris`.  Display-only: it runs in the display pipeline
 * (DisplayRenderer.renderTextPart, virtual-greeting rendering), never before
 * persisting a message, so stored text keeps the original card markup.
 */
export function resolveHtmlImages(
  content: string,
  assets: CharacterAsset[],
  characterId: string,
): string {
  if (!assets.length) return content;

  return content.replace(
    /src=["']([^"']+\.(?:png|jpe?g|gif|webp|bmp))["']/gi,
    (match: string, filename: string) => {
      const url = findAssetUrl(filename, assets, characterId);
      if (url) {
        return `src="${url}"`;
      }
      return match;
    },
  );
}
