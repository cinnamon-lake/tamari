import { getAuthToken } from './auth.js';

export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(url, { ...init, headers });
}

export function authenticatedUrl(url: string): string {
  const token = getAuthToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/** Prefixes that are token-checked on the server yet load through media
 * elements (<img>/<audio>/<video> in message HTML) that cannot send
 * Authorization headers — those need the query-param form. */
const TOKEN_CHECKED_PREFIXES = ['/api/attachments/', '/files/'];

function stripOrigin(url: string): string {
  return url.startsWith(window.location.origin) ? url.slice(window.location.origin.length) : url;
}

/** True when this URL points at a server route that requires a token. */
export function needsAuthToken(url: string): boolean {
  const path = stripOrigin(url);
  return TOKEN_CHECKED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * Token-form of a media source URL: appends (or replaces) the `token` query
 * param for token-checked routes; passes anything else through untouched.
 * Used for <img>/<audio>/<video> sources embedded by the server's rendered
 * message HTML, where headers are impossible.
 */
export function authenticatedSrc(url: string): string {
  if (!url || !needsAuthToken(url)) return url;
  const token = getAuthToken();
  if (!token) return url;
  try {
    const parsed = new URL(stripOrigin(url), window.location.origin);
    parsed.searchParams.set('token', token);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Post-render fix-up for raw-HTML sinks (innerHTML): rewrites media element
 * sources of token-checked routes to their authenticated form. Called after
 * each renderedHtml update; setting attributes here does not feed back into
 * Solid's tracked reads.
 */
export function applyAuthTokenToMedia(root: ParentNode): void {
  const media = root.querySelectorAll('img[src], audio[src], video[src], source[src]');
  for (const el of media) {
    const src = el.getAttribute('src');
    if (!src) continue;
    const next = authenticatedSrc(src);
    if (next !== src) el.setAttribute('src', next);
  }
}
