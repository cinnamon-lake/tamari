import type { Message } from '@tamari/types';

/** Resolved, client-ready sprite as emitted by the built-in `scene` template. */
export interface ResolvedSceneSprite {
  name: string;
  emotion?: string;
  position: 'left' | 'center' | 'right';
  url: string;
}

/** Resolved, client-ready scene as emitted by the built-in `scene` template. */
export interface ResolvedScene {
  backgroundUrl: string | null;
  sprites: ResolvedSceneSprite[];
  caption: string;
}

function parseSprite(raw: unknown): ResolvedSceneSprite | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0) return null;
  if (r.position !== 'left' && r.position !== 'center' && r.position !== 'right') return null;
  if (typeof r.url !== 'string' || r.url.length === 0) return null;
  if (r.emotion !== undefined && typeof r.emotion !== 'string') return null;
  return {
    name: r.name,
    ...(r.emotion !== undefined ? { emotion: r.emotion } : {}),
    position: r.position,
    url: r.url,
  };
}

/** Validate a resolved scene payload; returns null when malformed. */
export function parseScene(raw: unknown): ResolvedScene | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.backgroundUrl !== null && typeof r.backgroundUrl !== 'string') return null;
  if (typeof r.caption !== 'string') return null;
  if (!Array.isArray(r.sprites)) return null;
  const sprites: ResolvedSceneSprite[] = [];
  for (const s of r.sprites) {
    const sprite = parseSprite(s);
    if (!sprite) return null;
    sprites.push(sprite);
  }
  return { backgroundUrl: r.backgroundUrl, sprites, caption: r.caption };
}

/**
 * Derive the current scene for a chat branch: scan messages backwards for the
 * newest `tool_result` part with `extra.renderType === 'scene'`. The store
 * replaces `state.messages` wholesale on swipe/fork/chat-switch, so the result
 * is branch-correct automatically. Only the loaded (paginated) window is
 * visible — when the last `scene_set` scrolled out of it, the stage falls back
 * to empty.
 */
export function deriveScene(messages: Message[] | undefined): ResolvedScene | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts: unknown = messages[i]!.extra.parts;
    if (!Array.isArray(parts)) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as Record<string, unknown> | null;
      if (!part || typeof part !== 'object') continue;
      if (part.type !== 'tool_result') continue;
      const extra = part.extra as Record<string, unknown> | undefined;
      if (extra?.renderType !== 'scene') continue;
      return parseScene(extra.scene);
    }
  }
  return null;
}
