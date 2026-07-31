/**
 * Minimal `.env` file support — no dependency. Loads KEY=VALUE lines into
 * process.env (never overriding variables that are already set) and appends
 * new entries. Only the subset we write ourselves is supported: plain or
 * double-quoted values, `#` comments, blank lines.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';

/** Parse `.env` content into key/value pairs. Malformed lines are skipped. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        continue; // unbalanced escapes — skip the line rather than guess
      }
    }
    out[key] = value;
  }
  return out;
}

/** Serialize one entry; values are raw when safe, JSON-quoted otherwise. */
export function serializeEnvVar(key: string, value: string): string {
  const safe = /^[A-Za-z0-9_@./:+-]+$/.test(value);
  return `${key}=${safe ? value : JSON.stringify(value)}`;
}

/**
 * Load a `.env` file into process.env. Existing environment variables always
 * win. Missing file is fine. Returns the keys that were applied.
 */
export function loadEnvFile(path: string): string[] {
  if (!existsSync(path)) return [];
  const parsed = parseEnvFile(readFileSync(path, 'utf8'));
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

/** Append one entry to a `.env` file, creating it (with a header) if needed. */
export function appendEnvVar(path: string, key: string, value: string): void {
  const line = serializeEnvVar(key, value);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    const needsNewline = existing.length > 0 && !existing.endsWith('\n');
    appendFileSync(path, `${needsNewline ? '\n' : ''}${line}\n`);
  } else {
    writeFileSync(path, `# tamari configuration\n${line}\n`, { mode: 0o600 });
  }
}
