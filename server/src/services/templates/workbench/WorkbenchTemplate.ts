/**
 * Workbench tool template — a single filesystem-style surface over the five
 * internal workbench providers (character, backend, toolset, quick-reply,
 * lua-tool), replacing their 49 individual tools with 7 fs tools:
 * ls, read, grep, write, edit, rm, run.
 *
 * The virtual filesystem:
 *
 *   /                                       the domain names (ls / only)
 *   /characters/<id>/                       non-empty text fields + meta.json + present subdirs
 *   /characters/<id>/<field>                description, personality, scenario, first_mes,
 *                                           mes_example, system_prompt, post_history_instructions,
 *                                           creator_notes, nickname
 *   /characters/<id>/meta.json              { name, tags, alternateGreetings, avatarUrl, thumbnailUrl, worldInfoId }
 *   /characters/<id>/lorebook/<entryId>.json
 *   /characters/<id>/greetings/<n>          one text file per alternate greeting (new appends; indices shift on rm)
 *   /characters/<id>/regex/<ruleId>.json
 *   /characters/<id>/assets/<assetId>.json  metadata only; binary not readable
 *   /characters/<id>/modules/<moduleId>.json[/<section>]   Risu modules; read + rm only
 *   /characters/<id>/backend_logic/main.lua   per-character backend script (entry point)
 *   /characters/<id>/backend_logic/<path>     Lua modules require()'d from the script
 *   /characters/<id>/backend_logic.lua        legacy alias for backend_logic/main.lua
 *   /backends/<configId>.json               backend config (apiKey redacted)
 *   /custom-backends/<id>/{meta.json,source.lua}
 *   /toolsets/<toolsetId>.json
 *   /quickreplies/<scope>/<scopeId>/<id>.json   scope global|character|chat; global uses scopeId `_`
 *   /luatools/<id>/{meta.json,code.lua}
 *   /generations/<id>/{meta.json,error.txt,prompt.json}   debug traces; read-only
 *
 * No discovery, by design: collections (/characters/, /backends/, ...) can
 * never be listed and grep never crosses entity boundaries — entity ids come
 * from the user or chat context (or from a create result). Entities are
 * created by writing to a path ending in /new or /new.json; the result
 * carries the real assigned path. Non-file actions (tests, clone, copies)
 * go through the `run` escape hatch.
 *
 * All errors are returned as `content` strings, never thrown.
 */

import { z } from 'zod';
import { formatZodIssues, type ToolContext, type ToolExecuteResult, type ToolTemplate } from '../../ToolTemplate.js';
import { toToolResult } from '../../TestSessionService.js';
import { isJson, normalizePath, splitPath } from './pathUtils.js';
import {
  COLLECTION_REFUSAL,
  DOMAIN_NAMES,
  err,
  formatLs,
  isError,
  resolveDomain,
  type DomainRoute,
  type RouteCall,
  type WorkbenchProviders,
} from './router.js';
import { isBackendLogicPath } from './routes/characters.js';

export function registerWorkbenchTemplate(
  registry: { registerTemplate(template: ToolTemplate): void },
  deps: WorkbenchProviders,
): WorkbenchTemplate {
  const template = new WorkbenchTemplate(deps);
  registry.registerTemplate(template);
  return template;
}

/** ~400 lines per read, with a hint to page via offset. */
const MAX_READ_LINES = 400;
const MAX_GREP_MATCHES = 50;

const PATH_DESCRIBE =
  'Absolute vfs path (leading "/"). Layout: /characters/<id>/ (text fields, meta.json, lorebook/, greetings/, regex/, assets/, modules/, backend_logic/<main.lua|modules>), ' +
  '/backends/<id>.json, /custom-backends/<id>/{meta.json,source.lua}, /toolsets/<id>.json, ' +
  '/quickreplies/<scope>/<scopeId>/<id>.json (scope global|character|chat; "_" = global scopeId), /luatools/<id>/{meta.json,code.lua}, ' +
  '/generations/<id>/{meta.json,error.txt,prompt.json} (debug traces, read-only).';

const NO_COLLECTIONS =
  'Collections CANNOT be listed (/characters/, /backends/, /toolsets/, /luatools/, /custom-backends/, /quickreplies/, /quickreplies/<scope>/) — entity ids come from the user or chat context.';

const LsArgs = z.object({
  path: z.string().optional().describe('Directory or file path. Defaults to "/".'),
});

const ReadArgs = z.object({
  path: z.string().describe(PATH_DESCRIBE),
  offset: z
    .number()
    .int()
    .optional()
    .describe('1-based first line to return. Negative = tail: offset -20 returns the last 20 lines.'),
  limit: z.number().int().min(1).optional().describe('Max lines to return. Omit for the rest of the file.'),
});

const GrepArgs = z.object({
  pattern: z.string().min(1).describe('Text to find (substring by default; JS RegExp when regex is true).'),
  path: z
    .string()
    .describe(
      'Required. Must resolve inside ONE specific entity: an entity dir (/characters/<id>/, /custom-backends/<id>/, /luatools/<id>/), ' +
        'a sub-collection (/characters/<id>/lorebook/, /quickreplies/<scope>/<scopeId>/), or a single file. Root and collection paths are refused.',
    ),
  regex: z.boolean().optional().describe('Treat pattern as a JS RegExp. Default false (substring match).'),
  ignoreCase: z.boolean().optional().describe('Default true.'),
});

const WriteArgs = z.object({
  path: z.string().describe(PATH_DESCRIBE),
  content: z.string().describe('Full new file content. Text/.lua files are stored verbatim; .json files must be valid JSON and are schema-validated.'),
});

const EditArgs = z.object({
  path: z.string().describe('A text or .lua file (use write for .json files).'),
  oldString: z.string().min(1).describe('Exact text to find. Must match exactly once unless replaceAll is true.'),
  newString: z.string().describe('Replacement text (may be empty to delete the match).'),
  replaceAll: z.boolean().optional().describe('Replace every occurrence. Default false.'),
});

const RmArgs = z.object({
  path: z.string().describe(PATH_DESCRIBE),
});

const RunArgs = z.object({
  verb: z.string().optional().describe('Action to perform. Omit (or pass an unknown verb) to get the verb menu.'),
  args: z.record(z.string(), z.unknown()).optional().describe('Verb arguments, passed through to the underlying provider op.'),
});

interface RunVerb {
  summary: string;
  run(providers: WorkbenchProviders, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult>;
}

/** The run-verb table: escape hatch for actions that don't map to files. */
const RUN_VERBS: Record<string, RunVerb> = {
  test_backend: {
    summary: '{configId?, patch?, prompt?, mode: "dry"|"live"} — dry-run or live-test a backend config (configId defaults to the active backend)',
    run: (p, a, c) => p.backendWorkbench.execute('backend_test', a, c),
  },
  test_custom_backend: {
    summary: '{id?|luaSource?, input, state?, delegateResponse?} — dry-run a custom-backend script',
    run: (p, a, c) => p.backendWorkbench.execute('custom_backend_test', a, c),
  },
  test_backend_logic: {
    summary: "{characterId, input, luaSource?, state?, delegateResponse?} — dry-run a character's backend_logic.lua",
    run: (p, a, c) => p.characterWorkbench.execute('backend_logic_test', a, c),
  },
  test_luatool: {
    summary: '{id?|code?, sandbox?, toolName, args?, config?} — run a tool from a Lua tool template (stored or ad-hoc code)',
    run: (p, a, c) => p.luaToolWorkbench.execute('luatool_test', a, c),
  },
  test_regex: {
    summary: '{characterId?, text, role?} — preview merged regex rules (global + character-scoped) against sample text',
    run: (p, a, c) => p.characterWorkbench.execute('regex_test', a, c),
  },
  test_card: {
    summary:
      '{characterId?|folderPath?, turns: string[], keepChat?, backendConfigId?, timeoutMs?} — scripted multi-turn card test in an in-memory test session (no real chat, no DB writes): sends each scripted user turn against the active backend config (or backendConfigId, e.g. a mock config); returns transcript + generation ids. Session kept by default (sessionId returned, expires after 30 min idle) — pass keepChat: false to end it immediately',
    run: (p, a) =>
      p.cardTest !== undefined
        ? p.cardTest.run(a)
        : Promise.resolve({ content: 'Error: test_card is not available in this context' }),
  },
  test_session_start: {
    summary:
      '{characterId?|folderPath?, personaId?, greetingIndex?, backendConfigId?} — open an interactive card-testing session (real generation path, in-memory state, no DB writes) and return its materialized greeting. Sessions expire after 30 min idle; continue with test_session_message, inspect with test_session_state, close with test_session_end',
    run: (p, a) =>
      p.testSessions !== undefined
        ? toToolResult(p.testSessions.start(a))
        : Promise.resolve({ content: 'Error: test_session_start is not available in this context' }),
  },
  test_session_message: {
    summary:
      '{sessionId, content, timeoutMs?} — send a user message in a test session and run one generation turn; returns reply, generationId, finishReason, the card\'s Lua scriptState, and any backend print() output (debug)',
    run: (p, a) =>
      p.testSessions !== undefined
        ? toToolResult(p.testSessions.message(a))
        : Promise.resolve({ content: 'Error: test_session_message is not available in this context' }),
  },
  test_session_state: {
    summary:
      '{sessionId, generationId?} — inspect a test session: message chain (role + text), generations (id/status/meta without prompts), and the card\'s latest Lua script state. Pass generationId for that generation\'s full record including every captured round prompt (big — hence opt-in)',
    run: (p, a) =>
      p.testSessions !== undefined
        ? toToolResult(p.testSessions.state(a))
        : Promise.resolve({ content: 'Error: test_session_state is not available in this context' }),
  },
  test_session_end: {
    summary:
      '{sessionId} — end a test session early: aborts any in-flight generation and drops all in-memory state (sessions also expire after 30 min idle)',
    run: (p, a) =>
      p.testSessions !== undefined
        ? toToolResult(p.testSessions.end(a))
        : Promise.resolve({ content: 'Error: test_session_end is not available in this context' }),
  },
  clone_character: {
    summary: '{sourceCharacterId, name?} — deep-copy a character card (fields, lorebook, regex, modules, assets, avatar)',
    run: (p, a, c) => p.characterWorkbench.execute('character_clone', a, c),
  },
  set_avatar: {
    summary: '{characterId, attachmentId?|sourceCharacterId?} — set a character avatar from an attachment image or another card',
    run: (p, a, c) => p.characterWorkbench.execute('character_set_avatar', a, c),
  },
  copy_assets: {
    summary: '{characterId, sourceCharacterId, assetId?} — copy character assets; omit assetId to copy all',
    run: (p, a, c) =>
      p.characterWorkbench.execute(a['assetId'] !== undefined ? 'character_asset_copy' : 'character_assets_copy', a, c),
  },
  copy_module_assets: {
    summary: "{characterId, sourceCharacterId, moduleId} — copy a Risu module's stored assets onto another card",
    run: (p, a, c) => p.characterWorkbench.execute('risu_module_assets_copy', a, c),
  },
  move_lorebook_entry: {
    summary: '{characterId, entryId, index} — move a lorebook entry to a 0-based position',
    run: (p, a, c) => p.characterWorkbench.execute('lorebook_entry_move', a, c),
  },
  add_game_lib: {
    summary: "{characterId} — vendor the game lib (lib/*.lua: loop, transcript, ledger, todo, registry, …) into the card's backend_logic VFS",
    run: (p, a, c) => p.characterWorkbench.execute('backend_logic_add_game_lib', a, c),
  },
};

function runVerbMenu(): string {
  const lines = Object.entries(RUN_VERBS).map(([verb, v]) => `- ${verb} ${v.summary}`);
  return `run verbs (usage: run {"verb": "<name>", "args": {...}}):\n${lines.join('\n')}`;
}

export class WorkbenchTemplate implements ToolTemplate {
  id = 'workbench';
  name = 'Workbench';
  source = 'builtin' as const;

  constructor(private providers: WorkbenchProviders) {}

  getDefinition() {
    return {
      stateKey: 'workbench',
      configSchema: {},
      tools: [
        {
          name: 'ls',
          description:
            `List a directory in the workbench virtual filesystem (one entry per line; directories end in "/", files may show a display name). ` +
            `ls / shows the seven domain names. ${NO_COLLECTIONS} Allowed: entity dirs (/characters/<id>/, /custom-backends/<id>/, /luatools/<id>/), ` +
            `entity sub-collections (/characters/<id>/{lorebook,greetings,regex,assets,modules}/), and scoped /quickreplies/<scope>/<scopeId>/. ` +
            `A character dir lists only non-empty fields and present subdirs — empty fields are always hidden.`,
          parameters: z.toJSONSchema(LsArgs) as Record<string, unknown>,
        },
        {
          name: 'read',
          description:
            `Read a file. Full read returns raw content (pretty-printed JSON for .json files). offset/limit select a 1-based line range, ` +
            `rendered as tab-numbered lines; a negative offset reads the tail (offset -20 = last 20 lines). Output is capped at ~400 lines — ` +
            `page with offset. Reading a directory is an error: use ls.`,
          parameters: z.toJSONSchema(ReadArgs) as Record<string, unknown>,
        },
        {
          name: 'grep',
          description:
            `Search for text inside ONE entity (a character's fields + lorebook + scripts, one luatool's code, etc.) — never a cross-entity scan. ` +
            `${NO_COLLECTIONS} Output: path:line:text, capped at ${MAX_GREP_MATCHES} matches.`,
          parameters: z.toJSONSchema(GrepArgs) as Record<string, unknown>,
        },
        {
          name: 'write',
          description:
            `Create or replace a file. Create entities by writing to a path whose last segment is new or new.json ` +
            `(/characters/new, /backends/new.json, /characters/<id>/lorebook/new.json, /quickreplies/<scope>/<scopeId>/new.json, ...) — ` +
            `the result includes the real assigned path. meta.json files accept only their writable fields. ` +
            `.lua writes are load-validated and rejected unsaved when invalid. Modules and asset files are read-only.`,
          parameters: z.toJSONSchema(WriteArgs) as Record<string, unknown>,
        },
        {
          name: 'edit',
          description:
            `Surgical replace in a text or .lua file: oldString must match exactly once (or set replaceAll). JSON files: use write. ` +
            `The edited source is re-validated before saving (backend_logic.lua must define generate; luatool code.lua must load) — invalid edits are NOT saved.`,
          parameters: z.toJSONSchema(EditArgs) as Record<string, unknown>,
        },
        {
          name: 'rm',
          description:
            `Delete a file or entity directory. Allowed: lorebook entries, greetings, regex rules, assets, modules, /custom-backends/<id>/. ` +
            `Refused: characters, backend configs, toolsets (disable via write with "enabled": false), quick replies, lua tool templates, meta.json files, collections.`,
          parameters: z.toJSONSchema(RmArgs) as Record<string, unknown>,
        },
        {
          name: 'run',
          description:
            `Escape hatch for non-file actions: run {"verb": "<name>", "args": {...}}. An unknown or omitted verb returns the verb menu. ` +
            `Verbs: ${Object.keys(RUN_VERBS).join(', ')}.`,
          parameters: z.toJSONSchema(RunArgs) as Record<string, unknown>,
        },
      ],
    };
  }

  async execute(toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    try {
      switch (toolName) {
        case 'ls':
          return await this.ls(args, context);
        case 'read':
          return await this.read(args, context);
        case 'grep':
          return await this.grep(args, context);
        case 'write':
          return await this.write(args, context);
        case 'edit':
          return await this.edit(args, context);
        case 'rm':
          return await this.rm(args, context);
        case 'run':
          return await this.run(args, context);
        default:
          return { content: `Error: unknown tool ${toolName}` };
      }
    } catch (e) {
      return { content: err(e instanceof Error ? e.message : String(e)) };
    }
  }

  // ---------- path plumbing ----------

  /** Normalize + resolve to a domain route. Root is reported as a directory error by the callers. */
  private route(
    rawPath: string,
    context?: ToolContext,
  ): { ok: true; domainName: string; domain: DomainRoute; call: RouteCall; root: boolean } | { ok: false; error: string } {
    let path: string;
    let segs: string[];
    try {
      path = normalizePath(rawPath);
      segs = splitPath(rawPath);
    } catch (e) {
      return { ok: false, error: err(e instanceof Error ? e.message : String(e)) };
    }
    const first = segs[0];
    if (first === undefined) {
      return {
        ok: true,
        domainName: '',
        domain: { ls: notARoute, read: notARoute, write: notARoute, rm: notARoute },
        call: { providers: this.providers, context, path, segs },
        root: true,
      };
    }
    const domain = resolveDomain(first);
    if (domain === undefined) return { ok: false, error: err(`no such file: ${path}`) };
    return { ok: true, domainName: first, domain, call: { providers: this.providers, context, path, segs: segs.slice(1) }, root: false };
  }

  // ---------- tools ----------

  private async ls(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = LsArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments — ${formatZodIssues(parsed.error)}` };
    const routed = this.route(parsed.data.path ?? '/', context);
    if (!routed.ok) return { content: routed.error };
    if (routed.root) return { content: DOMAIN_NAMES.map((d) => `${d}/`).join('\n') };
    const entries = await routed.domain.ls(routed.call);
    if (!Array.isArray(entries)) return { content: entries.error };
    return { content: formatLs(entries) };
  }

  private async read(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = ReadArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments — ${formatZodIssues(parsed.error)}` };
    const routed = this.route(parsed.data.path, context);
    if (!routed.ok) return { content: routed.error };
    if (routed.root) return { content: err(`is a directory (use ls): /`) };
    const content = await routed.domain.read(routed.call);
    if (typeof content !== 'string') return { content: content.error };
    return { content: renderRange(content, routed.call.path, parsed.data.offset, parsed.data.limit) };
  }

  private async grep(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = GrepArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments — ${formatZodIssues(parsed.error)}` };
    const { pattern, regex } = parsed.data;
    const ignoreCase = parsed.data.ignoreCase !== false;

    let matcher: (line: string) => boolean;
    if (regex === true) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignoreCase ? 'i' : '');
      } catch (e) {
        return { content: err(`invalid regex — ${e instanceof Error ? e.message : String(e)}`) };
      }
      matcher = (line) => re.test(line);
    } else if (ignoreCase) {
      const needle = pattern.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(needle);
    } else {
      matcher = (line) => line.includes(pattern);
    }

    const routed = this.route(parsed.data.path, context);
    if (!routed.ok) return { content: routed.error };
    if (routed.root) return { content: COLLECTION_REFUSAL };

    const matches: string[] = [];
    // An object (not a bare let) so CFA doesn't mis-narrow the flag the walk closure mutates.
    const state = { truncated: false };

    // Recursive within-entity walk over the same ls/read route functions the
    // fs tools use — collection refusals surface as the walk's error. Reads
    // come back tagged, so file content starting with "Error:" is searched,
    // not mistaken for a route failure.
    const walk = async (call: RouteCall): Promise<string | null> => {
      const content = await routed.domain.read(call);
      if (typeof content === 'string') {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (matcher(line)) {
            matches.push(`${call.path}:${i + 1}:${line}`);
            if (matches.length >= MAX_GREP_MATCHES) {
              state.truncated = true;
              return null;
            }
          }
        }
        return null;
      }
      if (!content.error.startsWith('Error: is a directory')) return content.error;
      const entries = await routed.domain.ls(call);
      if (!Array.isArray(entries)) return entries.error;
      for (const entry of entries) {
        if (state.truncated) return null;
        const childPath = `${call.path}/${entry.name}`;
        const failure = await walk({ ...call, path: childPath, segs: [...call.segs, entry.name] });
        if (failure !== null) return failure;
      }
      return null;
    };

    const failure = await walk(routed.call);
    if (failure !== null) return { content: failure };
    if (matches.length === 0) return { content: `No matches in ${routed.call.path}.` };
    const suffix = state.truncated ? `\n… [truncated at ${MAX_GREP_MATCHES} matches]` : '';
    return { content: matches.join('\n') + suffix };
  }

  private async write(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = WriteArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments — ${formatZodIssues(parsed.error)}` };
    const routed = this.route(parsed.data.path, context);
    if (!routed.ok) return { content: routed.error };
    if (routed.root) return { content: err(`is a directory: /`) };
    return { content: await routed.domain.write(routed.call, parsed.data.content) };
  }

  private async edit(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = EditArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments — ${formatZodIssues(parsed.error)}` };
    const { oldString, newString } = parsed.data;
    const replaceAll = parsed.data.replaceAll === true;

    const routed = this.route(parsed.data.path, context);
    if (!routed.ok) return { content: routed.error };
    if (routed.root) return { content: err(`is a directory: /`) };
    const { call } = routed;
    const last = call.segs[call.segs.length - 1] ?? '';
    if (isJson(last)) return { content: err(`use write for JSON files: ${call.path}`) };

    // backend_logic files are the one area whose edits are delegated to the
    // provider: main.lua edits re-validate the edited script (must load and
    // define generate); module edits load-check the edited module.
    if (routed.domainName === 'characters' && isBackendLogicPath(call.segs) && call.segs[0] !== undefined) {
      const [characterId, , file, ...rest] = call.segs;
      const isMainEdit = call.segs.length === 2 || (file === 'main.lua' && rest.length === 0);
      const result = isMainEdit
        ? await this.providers.characterWorkbench.execute(
            'backend_logic_edit',
            { characterId, oldString, newString, ...(replaceAll ? { replaceAll: true } : {}) },
            context,
          )
        : await this.providers.characterWorkbench.execute(
            'backend_file_edit',
            { characterId, path: [file, ...rest].join('/'), oldString, newString, ...(replaceAll ? { replaceAll: true } : {}) },
            context,
          );
      return { content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) };
    }

    // Generic edit: read the full file, unique-match replace, write back.
    // .lua writes re-validate via the provider update path (which validates
    // before saving), so a rejected edit never reaches storage.
    const full = await routed.domain.read(call);
    if (typeof full !== 'string') return { content: full.error };
    const occurrences = full.split(oldString).length - 1;
    if (occurrences === 0) return { content: err(`oldString not found in ${call.path}`) };
    if (occurrences > 1 && !replaceAll) {
      return {
        content: err(
          `oldString matches ${occurrences} locations in ${call.path} — provide more surrounding context for a unique match, or set replaceAll: true`,
        ),
      };
    }
    const next = full.split(oldString).join(newString);
    const written = await routed.domain.write(call, next);
    if (isError(written)) return { content: written };
    return { content: `Edited ${call.path} (${occurrences} replacement${occurrences === 1 ? '' : 's'}).` };
  }

  private async rm(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = RmArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments — ${formatZodIssues(parsed.error)}` };
    const routed = this.route(parsed.data.path, context);
    if (!routed.ok) return { content: routed.error };
    if (routed.root) return { content: err(`is a directory: /`) };
    return { content: await routed.domain.rm(routed.call) };
  }

  private async run(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = RunArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments — ${formatZodIssues(parsed.error)}` };
    const { verb } = parsed.data;
    if (verb === undefined) return { content: runVerbMenu() };
    const entry = RUN_VERBS[verb];
    if (entry === undefined) return { content: `${err(`unknown run verb "${verb}"`)}\n\n${runVerbMenu()}` };
    return entry.run(this.providers, parsed.data.args ?? {}, context);
  }

  serialize(): string {
    return '';
  }
  deserialize(_raw: string): void {}
}

/** Placeholder route for the root path — callers special-case `root` before touching it. */
function notARoute(): Promise<never> {
  return Promise.reject(new Error('the vfs root has no domain route'));
}

/**
 * Apply offset/limit to a full file body. Full reads return raw content;
 * ranged reads render 1-based tab-numbered lines. Negative offset = tail.
 * Output is capped at MAX_READ_LINES with a paging hint.
 */
function renderRange(content: string, path: string, offset?: number, limit?: number): string {
  const lines = content.split('\n');
  if (offset === undefined && limit === undefined) {
    if (lines.length <= MAX_READ_LINES) return content;
    return `${lines.slice(0, MAX_READ_LINES).join('\n')}\n… [truncated — ${lines.length} lines total; page with offset/limit, e.g. read {"path":"${path}","offset":${MAX_READ_LINES + 1}}]`;
  }
  const start = offset !== undefined && offset < 0 ? Math.max(0, lines.length + offset) : Math.max(0, (offset ?? 1) - 1);
  let end = limit !== undefined ? start + limit : lines.length;
  let truncated = false;
  if (end - start > MAX_READ_LINES) {
    end = start + MAX_READ_LINES;
    truncated = true;
  }
  const numbered = lines
    .slice(start, end)
    .map((line, i) => `${start + i + 1}\t${line}`)
    .join('\n');
  if (!truncated) return numbered;
  return `${numbered}\n… [truncated at ${MAX_READ_LINES} lines — continue with offset ${end + 1}]`;
}
