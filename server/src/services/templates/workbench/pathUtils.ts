/**
 * Virtual-filesystem path handling for the workbench template.
 *
 * Paths are absolute (`/`-prefixed), slash-separated, and flat: `.` and `..`
 * segments are rejected outright so a path always maps 1:1 to its segment
 * list. Trailing slashes are tolerated (`/characters/<id>/` === `/characters/<id>`).
 */

/** Normalize a vfs path: requires a leading "/", collapses duplicate slashes and any trailing slash. Throws on relative paths and "." / ".." segments. */
export function normalizePath(raw: string): string {
  if (!raw.startsWith('/')) throw new Error(`path must start with "/": ${raw}`);
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '') continue; // collapses "//" and the trailing slash
    if (seg === '.' || seg === '..') throw new Error(`"." and ".." segments are not allowed: ${raw}`);
    out.push(seg);
  }
  return '/' + out.join('/');
}

/** Normalize + split into segments. The root "/" yields []. */
export function splitPath(raw: string): string[] {
  const normalized = normalizePath(raw);
  return normalized === '/' ? [] : normalized.slice(1).split('/');
}

/** A last segment of `new` / `new.json` marks a creation target (write /x/new.json → create under /x/). */
export function isNewSegment(seg: string): boolean {
  return seg === 'new' || seg === 'new.json';
}

export function isJson(seg: string): boolean {
  return seg.endsWith('.json');
}

export function isLua(seg: string): boolean {
  return seg.endsWith('.lua');
}

/** `<id>.json` → `<id>`; other names pass through unchanged. */
export function stripJsonExt(seg: string): string {
  return isJson(seg) ? seg.slice(0, -'.json'.length) : seg;
}
