/**
 * Client-side secrets REST helper.
 *
 * The vault is encrypted server-side with TAMARI_SECRET (the app login
 * secret). The client reaches it with just its existing bearer token (added by
 * apiFetch) — no separate password header needed.
 */

import { apiFetch } from './apiFetch.js';

export interface SecretEntry {
  key: string;
  value: string;
  label?: string;
}

export async function listSecrets(): Promise<SecretEntry[]> {
  const res = await apiFetch('/api/secrets');
  if (!res.ok) throw new Error(`Failed to list secrets: HTTP ${res.status}`);
  return (await res.json()) as SecretEntry[];
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
