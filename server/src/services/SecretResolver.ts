/**
 * Secret reference resolution.
 *
 * A key/setting value may be either a raw key (used as-is) or a vault reference
 * of the form `secret:<vaultKey>`. These helpers swap `secret:` references for
 * the decrypted value from {@link SecretService} at the consumption chokepoints,
 * so configs/tools can reference a vault entry instead of holding the raw key.
 *
 * Resolution is best-effort: a missing or unreadable secret is left as the
 * literal string, so the provider 401s with a clear signal rather than silently
 * sending an empty key.
 */

import type { SecretService } from './SecretService.js';

const SECRET_PREFIX = 'secret:';

export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

/** Resolve one value: `secret:<key>` → vault entry; anything else passes through. */
export async function resolveSecretValue(
  value: unknown,
  secretService: SecretService,
  password: string,
): Promise<unknown> {
  if (!isSecretRef(value)) return value;
  try {
    const entry = await secretService.get(value.slice(SECRET_PREFIX.length), password);
    return entry.value;
  } catch {
    return value;
  }
}

/** Resolve every `secret:` entry in a settings map (mutates in place). */
export async function resolveSecretSettings(
  values: Record<string, unknown>,
  secretService: SecretService,
  password: string,
): Promise<void> {
  await Promise.all(
    Object.entries(values).map(async ([k, v]) => {
      values[k] = await resolveSecretValue(v, secretService, password);
    }),
  );
}
