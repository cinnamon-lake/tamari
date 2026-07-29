import { describe, it, expect, vi } from 'vitest';
import { WorkbenchTemplate, registerWorkbenchTemplate } from './WorkbenchTemplate.js';
import type { ToolContext, ToolExecuteResult, ToolTemplate } from '../../ToolTemplate.js';
import type { WorkbenchProviders } from './router.js';

/**
 * The providers are faked at the `execute(toolName, args, context)` boundary —
 * handlers return a payload (JSON-stringified, like the real providers) or a
 * raw/`Error: ...` content string, matching what router.callProvider parses.
 */
type Handler = (args: Record<string, unknown>, context?: ToolContext) => unknown;

interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
  context?: ToolContext;
}

interface FakeProvider {
  execute: (tool: string, args: Record<string, unknown>, context?: ToolContext) => Promise<ToolExecuteResult>;
  calls: FakeCall[];
}

function fakeProvider(handlers: Record<string, Handler>): FakeProvider {
  const calls: FakeCall[] = [];
  const execute = vi.fn(async (tool: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> => {
    calls.push({ tool, args, context });
    const handler = handlers[tool];
    if (handler === undefined) return { content: `Error: no fake handler for ${tool}` };
    const out = handler(args, context);
    return { content: typeof out === 'string' ? out : JSON.stringify(out) };
  });
  return { execute, calls };
}

const COLLECTION_REFUSAL = 'Error: cannot list collections — ids come from the user or chat context';

/** A card with some empty text fields, a lorebook binding and present sub-collections. */
const CARD: Record<string, unknown> = {
  id: 'c1',
  name: 'Aria',
  description: 'A wandering mage.\nShe collects dragons.',
  personality: '',
  scenario: 'A dragon appears',
  firstMes: 'Hello there',
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  creatorNotes: '',
  nickname: '',
  tags: ['mage'],
  alternateGreetings: ['Hi again'],
  avatarUrl: null,
  thumbnailUrl: null,
  worldInfoId: 'book1',
};

const LORE_ENTRIES = [{ id: 'e1', comment: 'Dragon lore', keys: ['dragon'], content: 'Dragons hoard gold' }];
const REGEX_RULES = [{ id: 'r1', name: 'Fix caps', findRegex: 'hello', replaceString: 'Hello' }];
const ASSETS = [{ id: 'a1', name: 'sprite' }];
const MODULES = [{ id: 'm1', name: 'Combat' }];
const LUA_SOURCE = 'function generate(prompt, ctx)\n  return prompt\nend';
const QUICK_REPLIES = [{ id: 'q1', label: 'Say hi', message: 'Hi!' }];

function defaultCharacterHandlers(): Record<string, Handler> {
  return {
    character_get: (args) => (args['characterId'] === CARD['id'] ? CARD : `Error: character not found: ${String(args['characterId'])}`),
    character_create: () => ({ id: 'c9', name: 'Newbie' }),
    character_update: () => ({ ok: true }),
    lorebook_get: () => ({ entries: LORE_ENTRIES }),
    regex_list: () => REGEX_RULES,
    character_asset_list: () => ({ assets: ASSETS, total: ASSETS.length }),
    risu_module_list: () => ({ modules: MODULES, total: MODULES.length }),
    risu_module_get: (args) => ({ moduleId: args['moduleId'], section: args['section'], name: 'Combat' }),
    backend_logic_get: () => ({ enabled: true, luaSource: LUA_SOURCE }),
    backend_logic_set: () => ({ ok: true }),
    backend_logic_edit: () => 'Edited backend logic',
    lorebook_entry_remove: () => 'Removed lorebook entry',
    regex_remove: () => 'Removed regex rule',
    character_asset_remove: () => 'Removed asset',
    risu_module_remove: () => 'Removed module',
  };
}

function setup(
  overrides: {
    character?: Record<string, Handler>;
    backend?: Record<string, Handler>;
    toolset?: Record<string, Handler>;
    quickReply?: Record<string, Handler>;
    luaTool?: Record<string, Handler>;
  } = {},
) {
  const fakes = {
    character: fakeProvider({ ...defaultCharacterHandlers(), ...overrides.character }),
    backend: fakeProvider(overrides.backend ?? {}),
    toolset: fakeProvider(overrides.toolset ?? {}),
    quickReply: fakeProvider({ quickreply_list: () => QUICK_REPLIES, ...overrides.quickReply }),
    luaTool: fakeProvider(overrides.luaTool ?? {}),
  };
  const providers: WorkbenchProviders = {
    characterWorkbench: fakes.character as unknown as WorkbenchProviders['characterWorkbench'],
    backendWorkbench: fakes.backend as unknown as WorkbenchProviders['backendWorkbench'],
    toolsetWorkbench: fakes.toolset as unknown as WorkbenchProviders['toolsetWorkbench'],
    quickReplyWorkbench: fakes.quickReply as unknown as WorkbenchProviders['quickReplyWorkbench'],
    luaToolWorkbench: fakes.luaTool as unknown as WorkbenchProviders['luaToolWorkbench'],
  };
  return { template: new WorkbenchTemplate(providers), providers, fakes };
}

async function exec(template: WorkbenchTemplate, tool: string, args: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const result = await template.execute(tool, args, context);
  return result.content as string;
}

describe('WorkbenchTemplate identity', () => {
  it('exposes id, name and builtin source', () => {
    const { template } = setup();
    expect(template.id).toBe('workbench');
    expect(template.name).toBe('Workbench');
    expect(template.source).toBe('builtin');
  });

  it('getDefinition exposes exactly the 7 fs tools with non-empty descriptions', async () => {
    const { template } = setup();
    const def = template.getDefinition();
    expect(def.stateKey).toBe('workbench');
    expect(def.tools.map((t) => t.name)).toEqual(['ls', 'read', 'grep', 'write', 'edit', 'rm', 'run']);
    for (const tool of def.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeTypeOf('object');
    }
  });

  it('registerWorkbenchTemplate registers a WorkbenchTemplate with the registry', () => {
    const { providers } = setup();
    const registered: ToolTemplate[] = [];
    registerWorkbenchTemplate({ registerTemplate: (t) => registered.push(t) }, providers);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toBeInstanceOf(WorkbenchTemplate);
    expect(registered[0]?.id).toBe('workbench');
  });
});

describe('path handling', () => {
  it('rejects paths without a leading slash', async () => {
    const { template } = setup();
    expect(await exec(template, 'ls', { path: 'characters/c1' })).toBe('Error: path must start with "/": characters/c1');
    expect(await exec(template, 'read', { path: 'characters/c1/description' })).toBe(
      'Error: path must start with "/": characters/c1/description',
    );
  });

  it('rejects ".." segments', async () => {
    const { template } = setup();
    expect(await exec(template, 'ls', { path: '/characters/../c1' })).toBe(
      'Error: "." and ".." segments are not allowed: /characters/../c1',
    );
  });

  it('rejects "." segments', async () => {
    const { template } = setup();
    expect(await exec(template, 'read', { path: '/characters/./c1/description' })).toBe(
      'Error: "." and ".." segments are not allowed: /characters/./c1/description',
    );
  });

  it('collapses duplicate slashes and trailing slashes', async () => {
    const { template } = setup();
    const plain = await exec(template, 'ls', { path: '/characters/c1' });
    expect(await exec(template, 'ls', { path: '//characters//c1//' })).toBe(plain);
    expect(await exec(template, 'read', { path: '//characters//c1//description//' })).toBe(CARD['description']);
  });

  it('tolerates a trailing slash on an entity directory', async () => {
    const { template } = setup();
    expect(await exec(template, 'ls', { path: '/characters/c1/' })).toBe(await exec(template, 'ls', { path: '/characters/c1' }));
  });
});

describe('ls', () => {
  it('lists the six domain names at the root', async () => {
    const { template } = setup();
    const expected = 'characters/\nbackends/\ncustom-backends/\ntoolsets/\nquickreplies/\nluatools/';
    expect(await exec(template, 'ls', { path: '/' })).toBe(expected);
    expect(await exec(template, 'ls', {})).toBe(expected);
  });

  it('refuses every collection path', async () => {
    const { template } = setup();
    for (const path of ['/characters/', '/backends/', '/custom-backends/', '/toolsets/', '/luatools/', '/quickreplies/', '/quickreplies/global/']) {
      expect(await exec(template, 'ls', { path })).toBe(COLLECTION_REFUSAL);
    }
  });

  it('lists only non-empty fields and present subdirs of a character dir by default', async () => {
    const { template } = setup();
    expect(await exec(template, 'ls', { path: '/characters/c1' })).toBe(
      ['description', 'scenario', 'first_mes', 'meta.json', 'lorebook/', 'greetings/', 'regex/', 'assets/', 'modules/', 'backend_logic.lua'].join('\n'),
    );
  });

  it('keeps empty fields hidden even if a leftover all flag is passed', async () => {
    const { template } = setup();
    expect(await exec(template, 'ls', { path: '/characters/c1', all: true })).toBe(
      ['description', 'scenario', 'first_mes', 'meta.json', 'lorebook/', 'greetings/', 'regex/', 'assets/', 'modules/', 'backend_logic.lua'].join('\n'),
    );
  });

  it('lists only meta.json for a card with no content', async () => {
    const emptyCard = { ...CARD, description: '', scenario: '', firstMes: '', worldInfoId: null, alternateGreetings: [] };
    const { template } = setup({
      character: {
        character_get: () => emptyCard,
        regex_list: () => [],
        character_asset_list: () => ({ assets: [], total: 0 }),
        risu_module_list: () => ({ modules: [], total: 0 }),
        backend_logic_get: () => ({ enabled: false, luaSource: '' }),
      },
    });
    expect(await exec(template, 'ls', { path: '/characters/c1' })).toBe('meta.json');
  });

  it('lists entity-internal sub-collections with annotations', async () => {
    const { template } = setup();
    expect(await exec(template, 'ls', { path: '/characters/c1/regex/' })).toBe('r1.json  "Fix caps"');
    expect(await exec(template, 'ls', { path: '/characters/c1/lorebook/' })).toBe('e1.json  "Dragon lore"');
  });

  it('lists a scoped quickreply collection and maps "_" to the empty scopeId', async () => {
    const { template, fakes } = setup();
    expect(await exec(template, 'ls', { path: '/quickreplies/global/_/' })).toBe('q1.json  "Say hi"');
    expect(fakes.quickReply.calls[0]).toMatchObject({ tool: 'quickreply_list', args: { scope: 'global', scopeId: '' } });
  });

  it('lists a file path as that file entry', async () => {
    const { template } = setup();
    expect(await exec(template, 'ls', { path: '/characters/c1/description' })).toBe('description');
    expect(await exec(template, 'ls', { path: '/quickreplies/global/_/q1.json/label' })).toBe('label');
  });

  it('returns an Error for a nonexistent entity', async () => {
    const { template } = setup();
    expect(await exec(template, 'ls', { path: '/characters/nope/' })).toBe('Error: character not found: nope');
  });
});

describe('read', () => {
  it('refuses directories (entity dir and root)', async () => {
    const { template } = setup();
    expect(await exec(template, 'read', { path: '/characters/c1' })).toBe('Error: is a directory (use ls): /characters/c1');
    expect(await exec(template, 'read', { path: '/' })).toBe('Error: is a directory (use ls): /');
  });

  it('reads a text field verbatim', async () => {
    const { template } = setup();
    expect(await exec(template, 'read', { path: '/characters/c1/description' })).toBe('A wandering mage.\nShe collects dragons.');
  });

  it('pretty-prints .json files', async () => {
    const { template } = setup();
    expect(await exec(template, 'read', { path: '/characters/c1/meta.json' })).toBe(
      [
        '{',
        '  "name": "Aria",',
        '  "tags": [',
        '    "mage"',
        '  ],',
        '  "alternateGreetings": [',
        '    "Hi again"',
        '  ],',
        '  "avatarUrl": null,',
        '  "thumbnailUrl": null,',
        '  "worldInfoId": "book1"',
        '}',
      ].join('\n'),
    );
  });

  it('renders offset/limit ranges as 1-based tab-numbered lines', async () => {
    const { template } = setup({
      character: { character_get: () => ({ ...CARD, description: 'l1\nl2\nl3\nl4\nl5' }) },
    });
    expect(await exec(template, 'read', { path: '/characters/c1/description', offset: 2, limit: 2 })).toBe('2\tl2\n3\tl3');
  });

  it('treats a negative offset as a tail read', async () => {
    const { template } = setup({
      character: { character_get: () => ({ ...CARD, description: 'l1\nl2\nl3\nl4\nl5' }) },
    });
    expect(await exec(template, 'read', { path: '/characters/c1/description', offset: -2 })).toBe('4\tl4\n5\tl5');
  });

  it('truncates full reads over 400 lines with a paging hint', async () => {
    const big = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n');
    const { template } = setup({ character: { character_get: () => ({ ...CARD, description: big }) } });
    const content = await exec(template, 'read', { path: '/characters/c1/description' });
    expect(content).toContain('line 1\n');
    expect(content).toContain('line 400');
    expect(content).not.toContain('line 401');
    expect(content).toContain(
      '… [truncated — 450 lines total; page with offset/limit, e.g. read {"path":"/characters/c1/description","offset":401}]',
    );
  });

  it('returns an Error for nonexistent files and characters', async () => {
    const { template } = setup();
    expect(await exec(template, 'read', { path: '/characters/c1/lorebook/nope.json' })).toBe(
      'Error: no such file: /characters/c1/lorebook/nope.json',
    );
    expect(await exec(template, 'read', { path: '/characters/nope/description' })).toBe('Error: character not found: nope');
  });

  it('rejects a missing path argument', async () => {
    const { template } = setup();
    expect(await exec(template, 'read', {})).toMatch(/^Error: invalid arguments/);
  });
});

describe('grep', () => {
  it('rejects a missing path argument', async () => {
    const { template } = setup();
    expect(await exec(template, 'grep', { pattern: 'dragon' })).toMatch(/^Error: invalid arguments/);
  });

  it('refuses the root and collection paths', async () => {
    const { template } = setup();
    for (const path of ['/', '/characters/', '/backends/', '/toolsets/']) {
      expect(await exec(template, 'grep', { pattern: 'dragon', path })).toBe(COLLECTION_REFUSAL);
    }
  });

  it('finds substring matches across fields and lorebook entries (recursive walk)', async () => {
    const { template } = setup();
    expect(await exec(template, 'grep', { pattern: 'dragon', path: '/characters/c1/' })).toBe(
      [
        '/characters/c1/description:2:She collects dragons.',
        '/characters/c1/scenario:1:A dragon appears',
        '/characters/c1/lorebook/e1.json:3:  "comment": "Dragon lore",',
        '/characters/c1/lorebook/e1.json:5:    "dragon"',
        '/characters/c1/lorebook/e1.json:7:  "content": "Dragons hoard gold"',
      ].join('\n'),
    );
  });

  it('ignores case by default', async () => {
    const { template } = setup();
    const content = await exec(template, 'grep', { pattern: 'DRAGON', path: '/characters/c1/' });
    expect(content).toContain('/characters/c1/description:2:She collects dragons.');
    expect(content).toContain('/characters/c1/lorebook/e1.json:3:  "comment": "Dragon lore",');
  });

  it('honors explicit ignoreCase: false', async () => {
    const { template } = setup();
    expect(await exec(template, 'grep', { pattern: 'dragon', path: '/characters/c1/', ignoreCase: false })).toBe(
      [
        '/characters/c1/description:2:She collects dragons.',
        '/characters/c1/scenario:1:A dragon appears',
        '/characters/c1/lorebook/e1.json:5:    "dragon"',
      ].join('\n'),
    );
    expect(await exec(template, 'grep', { pattern: 'DRAGON', path: '/characters/c1/', ignoreCase: false })).toBe('No matches in /characters/c1.');
  });

  it('returns an Error for an invalid regex pattern', async () => {
    const { template } = setup();
    expect(await exec(template, 'grep', { pattern: '(', path: '/characters/c1/', regex: true })).toMatch(/^Error: invalid regex — /);
  });

  it('supports regex: true for valid patterns', async () => {
    const { template } = setup();
    const content = await exec(template, 'grep', { pattern: '^A dragon', path: '/characters/c1/', regex: true });
    expect(content).toBe('/characters/c1/scenario:1:A dragon appears');
  });

  it('caps output at 50 matches with a truncation note', async () => {
    const manyHits = Array.from({ length: 60 }, () => 'hit').join('\n');
    const { template } = setup({ character: { character_get: () => ({ ...CARD, description: manyHits }) } });
    const content = await exec(template, 'grep', { pattern: 'hit', path: '/characters/c1/' });
    const lines = content.split('\n');
    expect(lines).toHaveLength(51);
    expect(lines.slice(0, 50).every((l) => /^\/characters\/c1\/description:\d+:hit$/.test(l))).toBe(true);
    expect(lines[50]).toBe('… [truncated at 50 matches]');
  });
});

describe('write', () => {
  it('creates a character via /characters/new and returns the assigned path', async () => {
    const { template, fakes } = setup();
    const content = await exec(template, 'write', { path: '/characters/new', content: JSON.stringify({ name: 'Newbie' }) });
    expect(content).toBe(['{', '  "id": "c9",', '  "name": "Newbie",', '  "path": "/characters/c9/"', '}'].join('\n'));
    expect(fakes.character.calls[0]).toMatchObject({ tool: 'character_create', args: { name: 'Newbie' } });
  });

  it('maps snake_case text-field writes to camelCase patch keys', async () => {
    const { template, fakes } = setup();
    await exec(template, 'write', { path: '/characters/c1/first_mes', content: 'Hi!' });
    expect(fakes.character.calls[0]).toMatchObject({ tool: 'character_update', args: { characterId: 'c1', patch: { firstMes: 'Hi!' } } });
  });

  it('routes .lua writes to backend_logic_set', async () => {
    const { template, fakes } = setup();
    await exec(template, 'write', { path: '/characters/c1/backend_logic.lua', content: LUA_SOURCE });
    expect(fakes.character.calls[0]).toMatchObject({ tool: 'backend_logic_set', args: { characterId: 'c1', luaSource: LUA_SOURCE } });
  });

  it('keeps only writable keys in meta.json writes', async () => {
    const { template, fakes } = setup();
    await exec(template, 'write', {
      path: '/characters/c1/meta.json',
      content: JSON.stringify({ name: 'X', tags: ['t'], avatarUrl: 'http://x', thumbnailUrl: 'http://y', worldInfoId: 'w9' }),
    });
    expect(fakes.character.calls[0]).toMatchObject({ tool: 'character_update', args: { characterId: 'c1', patch: { name: 'X', tags: ['t'] } } });
  });

  it('rejects meta.json writes without writable keys', async () => {
    const { template } = setup();
    expect(await exec(template, 'write', { path: '/characters/c1/meta.json', content: JSON.stringify({ avatarUrl: 'http://x' }) })).toBe(
      'Error: meta.json writable fields: name, tags, alternateGreetings (avatarUrl/thumbnailUrl/worldInfoId are read-only)',
    );
  });

  it('rejects invalid JSON bodies', async () => {
    const { template } = setup();
    expect(await exec(template, 'write', { path: '/characters/new', content: 'not json' })).toMatch(/^Error: invalid JSON — /);
    expect(await exec(template, 'write', { path: '/characters/new', content: '[1,2]' })).toBe('Error: the JSON body must be an object');
  });

  it('propagates provider Error strings', async () => {
    const { template } = setup({ character: { character_update: () => 'Error: boom' } });
    expect(await exec(template, 'write', { path: '/characters/c1/first_mes', content: 'x' })).toBe('Error: boom');
  });

  it('refuses read-only targets (modules, non-new assets)', async () => {
    const { template } = setup();
    expect(await exec(template, 'write', { path: '/characters/c1/modules/m1.json', content: '{}' })).toBe(
      'Error: /characters/c1/modules/m1.json is read-only',
    );
    expect(await exec(template, 'write', { path: '/characters/c1/assets/a1.json', content: '{}' })).toBe(
      'Error: /characters/c1/assets/a1.json is read-only',
    );
  });

  it('returns an Error for unknown paths', async () => {
    const { template } = setup();
    expect(await exec(template, 'write', { path: '/characters/c1/bogus', content: 'x' })).toBe('Error: no such file: /characters/c1/bogus');
    expect(await exec(template, 'write', { path: '/nowhere/x', content: 'x' })).toBe('Error: no such file: /nowhere/x');
  });
});

describe('edit', () => {
  it('refuses JSON files', async () => {
    const { template } = setup();
    expect(await exec(template, 'edit', { path: '/characters/c1/meta.json', oldString: 'a', newString: 'b' })).toBe(
      'Error: use write for JSON files: /characters/c1/meta.json',
    );
  });

  it('replaces a unique match via the read + write flow', async () => {
    const { template, fakes } = setup();
    const content = await exec(template, 'edit', { path: '/characters/c1/description', oldString: 'dragons', newString: 'wyverns' });
    expect(content).toBe('Edited /characters/c1/description (1 replacement).');
    expect(fakes.character.calls.map((c) => c.tool)).toEqual(['character_get', 'character_update']);
    expect(fakes.character.calls[1]?.args).toEqual({
      characterId: 'c1',
      patch: { description: 'A wandering mage.\nShe collects wyverns.' },
    });
  });

  it('returns an Error when oldString is not found', async () => {
    const { template } = setup();
    expect(await exec(template, 'edit', { path: '/characters/c1/description', oldString: 'zzz', newString: 'b' })).toBe(
      'Error: oldString not found in /characters/c1/description',
    );
  });

  it('returns an Error suggesting replaceAll on multiple matches', async () => {
    const { template } = setup({ character: { character_get: () => ({ ...CARD, description: 'cat and cat' }) } });
    expect(await exec(template, 'edit', { path: '/characters/c1/description', oldString: 'cat', newString: 'dog' })).toBe(
      'Error: oldString matches 2 locations in /characters/c1/description — provide more surrounding context for a unique match, or set replaceAll: true',
    );
  });

  it('honors replaceAll: true', async () => {
    const { template, fakes } = setup({ character: { character_get: () => ({ ...CARD, description: 'cat and cat' }) } });
    const content = await exec(template, 'edit', { path: '/characters/c1/description', oldString: 'cat', newString: 'dog', replaceAll: true });
    expect(content).toBe('Edited /characters/c1/description (2 replacements).');
    expect(fakes.character.calls[1]?.args).toEqual({ characterId: 'c1', patch: { description: 'dog and dog' } });
  });

  it('delegates backend_logic.lua edits to the backend_logic_edit provider op', async () => {
    const { template, fakes } = setup();
    const content = await exec(template, 'edit', { path: '/characters/c1/backend_logic.lua', oldString: 'prompt', newString: 'p' });
    expect(content).toBe('Edited backend logic');
    expect(fakes.character.calls).toHaveLength(1);
    expect(fakes.character.calls[0]?.tool).toBe('backend_logic_edit');
    expect(fakes.character.calls[0]?.args).toEqual({ characterId: 'c1', oldString: 'prompt', newString: 'p' });
  });

  it('passes replaceAll through to backend_logic_edit', async () => {
    const { template, fakes } = setup();
    await exec(template, 'edit', { path: '/characters/c1/backend_logic.lua', oldString: 'a', newString: 'b', replaceAll: true });
    expect(fakes.character.calls[0]?.args).toEqual({ characterId: 'c1', oldString: 'a', newString: 'b', replaceAll: true });
  });
});

describe('rm', () => {
  const allowed: Array<{ path: string; tool: string; args: Record<string, unknown>; content: string }> = [
    { path: '/characters/c1/lorebook/e1.json', tool: 'lorebook_entry_remove', args: { characterId: 'c1', entryId: 'e1' }, content: 'Removed lorebook entry' },
    { path: '/characters/c1/regex/r1.json', tool: 'regex_remove', args: { characterId: 'c1', ruleId: 'r1' }, content: 'Removed regex rule' },
    { path: '/characters/c1/assets/a1.json', tool: 'character_asset_remove', args: { characterId: 'c1', assetId: 'a1' }, content: 'Removed asset' },
    { path: '/characters/c1/modules/m1.json', tool: 'risu_module_remove', args: { characterId: 'c1', moduleId: 'm1' }, content: 'Removed module' },
  ];
  for (const { path, tool, args, content } of allowed) {
    it(`deletes ${path} via ${tool}`, async () => {
      const { template, fakes } = setup();
      expect(await exec(template, 'rm', { path })).toBe(content);
      expect(fakes.character.calls[0]).toMatchObject({ tool, args });
    });
  }

  it('deletes a custom-backend directory via custom_backend_delete', async () => {
    const { template, fakes } = setup({ backend: { custom_backend_delete: () => 'Deleted custom backend cb1' } });
    expect(await exec(template, 'rm', { path: '/custom-backends/cb1' })).toBe('Deleted custom backend cb1');
    expect(fakes.backend.calls[0]).toMatchObject({ tool: 'custom_backend_delete', args: { id: 'cb1' } });
  });

  const refused: Array<{ path: string; message: string }> = [
    { path: '/characters/c1', message: 'Error: cannot remove /characters/c1 — deleting characters is not supported by the workbench' },
    { path: '/backends/b1.json', message: 'Error: cannot remove /backends/b1.json — backend configs have no delete; overwrite with write or switch the active config' },
    { path: '/toolsets/t1.json', message: 'Error: cannot remove /toolsets/t1.json — disable it via write with "enabled": false' },
    { path: '/quickreplies/global/_/q1.json', message: 'Error: cannot remove /quickreplies/global/_/q1.json — quick replies have no delete (matching the existing no-delete policy)' },
    { path: '/luatools/lt1', message: 'Error: cannot remove /luatools/lt1 — Lua tool templates have no delete (matching the existing no-delete policy)' },
    { path: '/characters/c1/meta.json', message: 'Error: /characters/c1/meta.json is read-only' },
    { path: '/characters/c1/description', message: 'Error: cannot remove /characters/c1/description — clear it with write and empty content' },
    { path: '/characters/', message: 'Error: is a directory: /characters' },
    { path: '/', message: 'Error: is a directory: /' },
  ];
  for (const { path, message } of refused) {
    it(`refuses to remove ${path}`, async () => {
      const { template } = setup();
      expect(await exec(template, 'rm', { path })).toBe(message);
    });
  }
});

describe('greetings', () => {
  it('hides greetings/ in the character dir when the card has no alternate greetings', async () => {
    const { template } = setup({ character: { character_get: () => ({ ...CARD, alternateGreetings: [] }) } });
    expect(await exec(template, 'ls', { path: '/characters/c1' })).not.toContain('greetings/');
  });

  it('lists one text file per greeting with a one-line preview', async () => {
    const long = 'A very long greeting that exceeds forty characters yes indeed';
    const { template } = setup({
      character: { character_get: () => ({ ...CARD, alternateGreetings: ['First line\nsecond line', long, ''] }) },
    });
    expect(await exec(template, 'ls', { path: '/characters/c1/greetings/' })).toBe(
      [`0  "First line"`, `1  "${long.slice(0, 40)}…"`, '2'].join('\n'),
    );
  });

  it('reads a greeting verbatim by index', async () => {
    const { template } = setup({
      character: { character_get: () => ({ ...CARD, alternateGreetings: ['zero', 'one\ntwo'] }) },
    });
    expect(await exec(template, 'read', { path: '/characters/c1/greetings/1' })).toBe('one\ntwo');
  });

  it('returns no such file for out-of-bounds, non-numeric and trailing-junk reads', async () => {
    const { template } = setup();
    expect(await exec(template, 'read', { path: '/characters/c1/greetings/7' })).toBe('Error: no such file: /characters/c1/greetings/7');
    expect(await exec(template, 'read', { path: '/characters/c1/greetings/abc' })).toBe('Error: no such file: /characters/c1/greetings/abc');
    expect(await exec(template, 'read', { path: '/characters/c1/greetings/0/extra' })).toBe('Error: no such file: /characters/c1/greetings/0/extra');
  });

  it('appends via write .../greetings/new and reports the assigned path', async () => {
    const { template, fakes } = setup();
    const content = await exec(template, 'write', { path: '/characters/c1/greetings/new', content: 'Second hi' });
    expect(fakes.character.calls.map((c) => c.tool)).toEqual(['character_get', 'character_update']);
    expect(fakes.character.calls.at(-1)?.args).toEqual({ characterId: 'c1', patch: { alternateGreetings: ['Hi again', 'Second hi'] } });
    expect(content).toContain('"path": "/characters/c1/greetings/1"');
  });

  it('replaces a greeting by index with the full array patch', async () => {
    const { template, fakes } = setup({ character: { character_get: () => ({ ...CARD, alternateGreetings: ['a', 'b'] }) } });
    await exec(template, 'write', { path: '/characters/c1/greetings/1', content: 'B' });
    expect(fakes.character.calls.at(-1)?.args).toEqual({ characterId: 'c1', patch: { alternateGreetings: ['a', 'B'] } });
  });

  it('returns no such file for an out-of-bounds write', async () => {
    const { template } = setup();
    expect(await exec(template, 'write', { path: '/characters/c1/greetings/9', content: 'x' })).toBe(
      'Error: no such file: /characters/c1/greetings/9',
    );
  });

  it('edits a greeting via the generic read + write flow (numeric branch)', async () => {
    const { template, fakes } = setup({ character: { character_get: () => ({ ...CARD, alternateGreetings: ['hello world'] }) } });
    const content = await exec(template, 'edit', { path: '/characters/c1/greetings/0', oldString: 'world', newString: 'there' });
    expect(content).toBe('Edited /characters/c1/greetings/0 (1 replacement).');
    expect(fakes.character.calls.at(-1)?.args).toEqual({ characterId: 'c1', patch: { alternateGreetings: ['hello there'] } });
  });

  it('removes a greeting by index, splicing the array', async () => {
    const { template, fakes } = setup({ character: { character_get: () => ({ ...CARD, alternateGreetings: ['a', 'b', 'c'] }) } });
    await exec(template, 'rm', { path: '/characters/c1/greetings/1' });
    expect(fakes.character.calls.at(-1)?.args).toEqual({ characterId: 'c1', patch: { alternateGreetings: ['a', 'c'] } });
  });

  it('returns no such file for an out-of-bounds rm', async () => {
    const { template } = setup();
    expect(await exec(template, 'rm', { path: '/characters/c1/greetings/9' })).toBe('Error: no such file: /characters/c1/greetings/9');
  });
});

describe('per-field files', () => {
  const LUA_TOOL = { id: 'lt1', name: 'My tool', sandbox: { timeout: 5 }, configSchema: {}, code: 'x' };
  const CUSTOM_BACKEND = { id: 'cb1', name: 'My backend', description: 'Does things', updatedAt: 123, luaSource: 'x' };

  function setupAll() {
    return setup({
      luaTool: {
        luatool_get: () => LUA_TOOL,
        luatool_update: () => ({ ok: true }),
      },
      backend: {
        custom_backend_get: () => CUSTOM_BACKEND,
        custom_backend_update: () => ({ ok: true }),
      },
      character: {
        regex_update: () => ({ ok: true }),
        lorebook_entry_update: () => ({ ok: true }),
      },
      quickReply: {
        quickreply_update: () => ({ ok: true }),
      },
    });
  }

  it('lists the field files of every expandable JSON-blob file', async () => {
    const { template } = setupAll();
    expect(await exec(template, 'ls', { path: '/characters/c1/meta.json' })).toBe('name\ntags\nalternate_greetings');
    expect(await exec(template, 'ls', { path: '/characters/c1/regex/r1.json' })).toBe(
      'name\nfind_regex\nreplace_string\nreplace_lua\ndisabled\nuser_input\nai_output\nprompt\ndisplay',
    );
    expect(await exec(template, 'ls', { path: '/characters/c1/lorebook/e1.json' })).toBe(
      'keys\ncontent\ncomment\norder\nposition\ndepth\nrole\nprobability\nconstant\nselective\nsecondary_keys\nadd_memo\ndisable\nregex\nrecursive\nretrieval_mode\nsticky\ncooldown\ndelay',
    );
    expect(await exec(template, 'ls', { path: '/quickreplies/global/_/q1.json' })).toBe(
      'label\nicon\ncolor\nscript\nlanguage\nauto_execute\norder_index',
    );
    expect(await exec(template, 'ls', { path: '/luatools/lt1/meta.json' })).toBe('name\nsandbox\nconfig_schema');
    expect(await exec(template, 'ls', { path: '/custom-backends/cb1/meta.json' })).toBe('name\ndescription');
  });

  it('reads string fields raw and json fields as pretty JSON', async () => {
    const { template } = setupAll();
    expect(await exec(template, 'read', { path: '/characters/c1/regex/r1.json/find_regex' })).toBe('hello');
    expect(await exec(template, 'read', { path: '/characters/c1/lorebook/e1.json/content' })).toBe('Dragons hoard gold');
    expect(await exec(template, 'read', { path: '/quickreplies/global/_/q1.json/label' })).toBe('Say hi');
    expect(await exec(template, 'read', { path: '/characters/c1/meta.json/tags' })).toBe('[\n  "mage"\n]');
    expect(await exec(template, 'read', { path: '/characters/c1/lorebook/e1.json/keys' })).toBe('[\n  "dragon"\n]');
    expect(await exec(template, 'read', { path: '/luatools/lt1/meta.json/sandbox' })).toBe('{\n  "timeout": 5\n}');
  });

  it('returns no such file for unknown fields and deeper paths', async () => {
    const { template } = setupAll();
    expect(await exec(template, 'read', { path: '/characters/c1/regex/r1.json/bogus' })).toBe(
      'Error: no such file: /characters/c1/regex/r1.json/bogus',
    );
    expect(await exec(template, 'read', { path: '/characters/c1/meta.json/avatarUrl' })).toBe(
      'Error: no such file: /characters/c1/meta.json/avatarUrl',
    );
    expect(await exec(template, 'read', { path: '/characters/c1/regex/r1.json/name/extra' })).toBe(
      'Error: no such file: /characters/c1/regex/r1.json/name/extra',
    );
    expect(await exec(template, 'read', { path: '/quickreplies/global/_/q1.json/bogus' })).toBe(
      'Error: no such file: /quickreplies/global/_/q1.json/bogus',
    );
  });

  it('writes string fields verbatim as single-key camelCase patches', async () => {
    const { template, fakes } = setupAll();
    await exec(template, 'write', { path: '/characters/c1/regex/r1.json/find_regex', content: '/foo\\d+/gi' });
    expect(fakes.character.calls[0]).toMatchObject({
      tool: 'regex_update',
      args: { characterId: 'c1', ruleId: 'r1', patch: { findRegex: '/foo\\d+/gi' } },
    });
    await exec(template, 'write', { path: '/quickreplies/global/_/q1.json/script', content: 'return "hi"' });
    expect(fakes.quickReply.calls[0]).toMatchObject({ tool: 'quickreply_update', args: { id: 'q1', patch: { script: 'return "hi"' } } });
    await exec(template, 'write', { path: '/characters/c1/meta.json/name', content: 'Aria II' });
    expect(fakes.character.calls[1]).toMatchObject({ tool: 'character_update', args: { characterId: 'c1', patch: { name: 'Aria II' } } });
    await exec(template, 'write', { path: '/custom-backends/cb1/meta.json/description', content: 'New desc' });
    expect(fakes.backend.calls[0]).toMatchObject({ tool: 'custom_backend_update', args: { id: 'cb1', patch: { description: 'New desc' } } });
  });

  it('parses json field values before patching', async () => {
    const { template, fakes } = setupAll();
    await exec(template, 'write', { path: '/characters/c1/regex/r1.json/disabled', content: 'true' });
    expect(fakes.character.calls[0]).toMatchObject({ tool: 'regex_update', args: { characterId: 'c1', ruleId: 'r1', patch: { disabled: true } } });
    await exec(template, 'write', { path: '/characters/c1/lorebook/e1.json/keys', content: '["dragon", "wyrm"]' });
    expect(fakes.character.calls[1]).toMatchObject({
      tool: 'lorebook_entry_update',
      args: { characterId: 'c1', entryId: 'e1', patch: { keys: ['dragon', 'wyrm'] } },
    });
    await exec(template, 'write', { path: '/luatools/lt1/meta.json/config_schema', content: '{"level": {"type": "number"}}' });
    expect(fakes.luaTool.calls[0]).toMatchObject({
      tool: 'luatool_update',
      args: { id: 'lt1', patch: { configSchema: { level: { type: 'number' } } } },
    });
  });

  it('rejects invalid JSON in json fields before any provider call', async () => {
    const { template, fakes } = setupAll();
    expect(await exec(template, 'write', { path: '/characters/c1/regex/r1.json/disabled', content: 'yes' })).toMatch(/^Error: invalid JSON — /);
    expect(fakes.character.calls).toHaveLength(0);
  });

  it('returns no such file for field writes on unknown fields and new segments', async () => {
    const { template } = setupAll();
    expect(await exec(template, 'write', { path: '/characters/c1/meta.json/bogus', content: 'x' })).toBe(
      'Error: no such file: /characters/c1/meta.json/bogus',
    );
    expect(await exec(template, 'write', { path: '/characters/c1/regex/new.json/find_regex', content: 'x' })).toBe(
      'Error: no such file: /characters/c1/regex/new.json/find_regex',
    );
  });

  it('edits a string field via the generic read + write flow', async () => {
    const { template, fakes } = setupAll();
    const content = await exec(template, 'edit', {
      path: '/characters/c1/lorebook/e1.json/content',
      oldString: 'hoard',
      newString: 'guard',
    });
    expect(content).toBe('Edited /characters/c1/lorebook/e1.json/content (1 replacement).');
    expect(fakes.character.calls.map((c) => c.tool)).toEqual(['lorebook_get', 'lorebook_entry_update']);
    expect(fakes.character.calls[1]?.args).toEqual({ characterId: 'c1', entryId: 'e1', patch: { content: 'Dragons guard gold' } });
  });

  it('refuses to remove field files', async () => {
    const { template } = setupAll();
    expect(await exec(template, 'rm', { path: '/characters/c1/meta.json/name' })).toBe(
      'Error: /characters/c1/meta.json/name is read-only — clear string fields with write and empty content',
    );
    expect(await exec(template, 'rm', { path: '/characters/c1/regex/r1.json/find_regex' })).toBe(
      'Error: /characters/c1/regex/r1.json/find_regex is read-only',
    );
  });
});

describe('run', () => {
  const VERBS = [
    'test_backend',
    'test_custom_backend',
    'test_backend_logic',
    'test_luatool',
    'test_regex',
    'clone_character',
    'set_avatar',
    'copy_assets',
    'copy_module_assets',
    'move_lorebook_entry',
  ];

  it('returns the verb menu listing all 10 verbs when the verb is omitted', async () => {
    const { template } = setup();
    const content = await exec(template, 'run', {});
    expect(content.startsWith('run verbs (usage: run {"verb": "<name>", "args": {...}}):')).toBe(true);
    for (const verb of VERBS) expect(content).toContain(`- ${verb} `);
  });

  it('returns an Error plus the menu for an unknown verb', async () => {
    const { template } = setup();
    const content = await exec(template, 'run', { verb: 'bogus' });
    expect(content.startsWith('Error: unknown run verb "bogus"')).toBe(true);
    expect(content).toContain('run verbs');
    for (const verb of VERBS) expect(content).toContain(`- ${verb} `);
  });

  const dispatch: Array<{ verb: string; fake: 'character' | 'backend' | 'luaTool'; tool: string; args: Record<string, unknown> }> = [
    { verb: 'test_backend', fake: 'backend', tool: 'backend_test', args: { configId: 'b1', mode: 'dry' } },
    { verb: 'test_custom_backend', fake: 'backend', tool: 'custom_backend_test', args: { luaSource: 'x', input: 'hi' } },
    { verb: 'test_backend_logic', fake: 'character', tool: 'backend_logic_test', args: { characterId: 'c1', input: 'hi' } },
    { verb: 'test_luatool', fake: 'luaTool', tool: 'luatool_test', args: { code: 'x', toolName: 't' } },
    { verb: 'test_regex', fake: 'character', tool: 'regex_test', args: { text: 'hello' } },
    { verb: 'clone_character', fake: 'character', tool: 'character_clone', args: { sourceCharacterId: 'c1' } },
    { verb: 'set_avatar', fake: 'character', tool: 'character_set_avatar', args: { characterId: 'c1', attachmentId: 'att1' } },
    { verb: 'copy_assets', fake: 'character', tool: 'character_asset_copy', args: { characterId: 'c1', sourceCharacterId: 'c2', assetId: 'a1' } },
    { verb: 'copy_assets', fake: 'character', tool: 'character_assets_copy', args: { characterId: 'c1', sourceCharacterId: 'c2' } },
    { verb: 'copy_module_assets', fake: 'character', tool: 'risu_module_assets_copy', args: { characterId: 'c1', sourceCharacterId: 'c2', moduleId: 'm1' } },
    { verb: 'move_lorebook_entry', fake: 'character', tool: 'lorebook_entry_move', args: { characterId: 'c1', entryId: 'e1', index: 0 } },
  ];
  for (const { verb, fake, tool, args } of dispatch) {
    it(`dispatches ${verb} (${tool === 'character_assets_copy' ? 'no assetId' : tool}) to ${tool}`, async () => {
      const handler: Handler = () => ({ ran: tool });
      const { template, fakes } = setup({ [fake]: { [tool]: handler } });
      const content = await exec(template, 'run', { verb, args });
      expect(fakes[fake].calls).toHaveLength(1);
      expect(fakes[fake].calls[0]?.tool).toBe(tool);
      expect(fakes[fake].calls[0]?.args).toEqual(args);
      expect(content).toBe(JSON.stringify({ ran: tool }));
    });
  }

  it('threads the ToolContext through to the provider', async () => {
    const { template, fakes } = setup({ luaTool: { luatool_test: () => ({ ok: true }) } });
    const context: ToolContext = { chatId: 'chat1', clientId: 'client1' };
    await exec(template, 'run', { verb: 'test_luatool', args: { toolName: 't' } }, context);
    expect(fakes.luaTool.calls[0]?.context).toBe(context);
  });
});

describe('unknown tool', () => {
  it('returns an Error string for an unknown tool name', async () => {
    const { template } = setup();
    expect(await exec(template, 'bogus', {})).toBe('Error: unknown tool bogus');
  });
});
