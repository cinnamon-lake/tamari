/**
 * Shared card field-format definitions — the single source of truth for how a
 * character card maps to/from plain files.
 *
 * Extracted from the workbench VFS (templates/workbench/routes/characters.ts
 * and router.ts) so the unpacked-card folder parser (services/unpacked/) and
 * the VFS share one definition. Pure data + pure helpers, zero provider
 * coupling. The small JSON helpers at the top moved here from the workbench
 * router (which re-exports them) to keep this module dependency-free.
 */

// ---------- Pure helpers (shared with the workbench router) ----------

export function err(message: string): string {
  return `Error: ${message}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Parse a JSON body. Syntax errors are vfs/parse-level; schema validation stays with the consumer. */
export function parseJsonBody(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(content) as unknown };
  } catch (e) {
    return { ok: false, error: err(`invalid JSON — ${e instanceof Error ? e.message : String(e)}`) };
  }
}

/** Parse + require a JSON object body. */
export function parseJsonObjectBody(content: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseJsonBody(content);
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.value)) return { ok: false, error: err('the JSON body must be an object') };
  return { ok: true, value: parsed.value };
}

// ---------- Per-field virtual files ----------

/**
 * One writable field of a JSON-blob entity, exposed as a virtual file next to
 * the whole-file `.json` (e.g. `/characters/<id>/regex/<ruleId>.json/find_regex`).
 * String fields carry raw content (no JSON escaping); `json` fields carry
 * JSON content that is syntax-checked at the vfs layer and schema-validated
 * by the provider patch op.
 */
export interface FieldSpec {
  /** Virtual file name, snake_case (e.g. 'find_regex'). */
  file: string;
  /** camelCase entity/patch key (e.g. 'findRegex'). */
  key: string;
  /** string → raw content; json → JSON.parse on write, pretty on read. */
  type: 'string' | 'json';
}

/** Look up a field spec by virtual file name. */
export function fieldSpec(specs: readonly FieldSpec[], file: string): FieldSpec | undefined {
  return specs.find((s) => s.file === file);
}

/** `ls` entries for an entity's per-field files (all declared fields are always listed). */
export function fieldEntries(specs: readonly FieldSpec[]): Array<{ name: string; dir: boolean }> {
  return specs.map((s) => ({ name: s.file, dir: false }));
}

/** Project one field of an entity object into virtual file content. */
export function readField(obj: Record<string, unknown>, spec: FieldSpec): string {
  const value = obj[spec.key];
  if (spec.type === 'string') return asString(value) ?? '';
  return pretty(value ?? null);
}

/**
 * Parse `write` content for a field file: verbatim for string fields, JSON
 * for json fields (syntax errors surface before any provider call).
 */
export function parseFieldContent(spec: FieldSpec, content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (spec.type === 'string') return { ok: true, value: content };
  return parseJsonBody(content);
}

// ---------- Character card field tables ----------

/** [file name, camelCase card field] — the writable text fields of a card. */
export const TEXT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['description', 'description'],
  ['personality', 'personality'],
  ['scenario', 'scenario'],
  ['first_mes', 'firstMes'],
  ['mes_example', 'mesExample'],
  ['system_prompt', 'systemPrompt'],
  ['post_history_instructions', 'postHistoryInstructions'],
  ['creator_notes', 'creatorNotes'],
  ['nickname', 'nickname'],
];

/**
 * meta.json's writable fields, also readable/writable one at a time as
 * meta.json/<file>. Read-only keys (avatarUrl, thumbnailUrl, worldInfoId)
 * stay whole-meta.json-only.
 */
export const META_FIELDS: readonly FieldSpec[] = [
  { file: 'name', key: 'name', type: 'string' },
  { file: 'tags', key: 'tags', type: 'json' },
  { file: 'alternate_greetings', key: 'alternateGreetings', type: 'json' },
];

/** Regex rule fields exposed as regex/<ruleId>.json/<file> (patch keys of regex_update). */
export const REGEX_FIELDS: readonly FieldSpec[] = [
  { file: 'name', key: 'name', type: 'string' },
  { file: 'find_regex', key: 'findRegex', type: 'string' },
  { file: 'replace_string', key: 'replaceString', type: 'string' },
  { file: 'replace_lua', key: 'replaceLua', type: 'string' },
  { file: 'disabled', key: 'disabled', type: 'json' },
  { file: 'user_input', key: 'userInput', type: 'json' },
  { file: 'ai_output', key: 'aiOutput', type: 'json' },
  { file: 'prompt', key: 'prompt', type: 'json' },
  { file: 'display', key: 'display', type: 'json' },
];

/** Lorebook entry fields exposed as lorebook/<entryId>.json/<file> (patch keys of lorebook_entry_update). */
export const LOREBOOK_FIELDS: readonly FieldSpec[] = [
  { file: 'keys', key: 'keys', type: 'json' },
  { file: 'content', key: 'content', type: 'string' },
  { file: 'comment', key: 'comment', type: 'string' },
  { file: 'order', key: 'order', type: 'json' },
  { file: 'position', key: 'position', type: 'json' },
  { file: 'depth', key: 'depth', type: 'json' },
  { file: 'role', key: 'role', type: 'json' },
  { file: 'probability', key: 'probability', type: 'json' },
  { file: 'constant', key: 'constant', type: 'json' },
  { file: 'selective', key: 'selective', type: 'json' },
  { file: 'secondary_keys', key: 'secondaryKeys', type: 'json' },
  { file: 'add_memo', key: 'addMemo', type: 'json' },
  { file: 'disable', key: 'disable', type: 'json' },
  { file: 'regex', key: 'regex', type: 'json' },
  { file: 'recursive', key: 'recursive', type: 'json' },
  { file: 'retrieval_mode', key: 'retrievalMode', type: 'json' },
  { file: 'sticky', key: 'sticky', type: 'json' },
  { file: 'cooldown', key: 'cooldown', type: 'json' },
  { file: 'delay', key: 'delay', type: 'json' },
];

/** Sub-collections whose <id>.json entries expand into per-field files. */
export const FIELD_FILE_SPECS: Record<string, readonly FieldSpec[]> = {
  lorebook: LOREBOOK_FIELDS,
  regex: REGEX_FIELDS,
};
