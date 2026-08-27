/**
 * Client-side secrets REST helper.
 *
 * The vault is encrypted server-side with TAMARI_SECRET (the app login
 * secret). The browser authenticates with a revocable session token (see
 * AuthModal / api/auth), so list responses come back MASKED — the server
 * only returns plaintext to the master credential, which never lives in the
 * client. Setting and deleting values still work; editing starts blank.
 */

import { apiFetch } from './apiFetch.js';

/** Full plaintext entry — only returned to master-credential callers. */
export interface SecretEntry {
  key: string;
  value: string;
  label?: string;
  masked?: false;
}

/** Value-free shape served to session credentials. */
export interface MaskedSecret {
  key: string;
  label?: string;
  masked: true;
  /** Last four characters of the stored value, for recognition only. */
  hint: string;
}

export type SecretListItem = SecretEntry | MaskedSecret;

export function isMaskedSecret(entry: SecretListItem): entry is MaskedSecret {
  return entry.masked === true;
}

export async function listSecrets(): Promise<SecretListItem[]> {
  const res = await apiFetch('/api/secrets');
  if (!res.ok) throw new Error(`Failed to list secrets: HTTP ${res.status}`);
  return (await res.json()) as SecretListItem[];
}

export async function setSecret(key: string, value: string, label?: string): Promise<void> {
  const res = await apiFetch('/api/secrets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value, label }),
  });
  if (!res.ok) throw new Error(`Failed to set secret: HTTP ${res.status}`);
}

export async function deleteSecret(key: string): Promise<void> {
  const res = await apiFetch(`/api/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete secret: HTTP ${res.status}`);
}
