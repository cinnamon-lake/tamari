import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { ToolTemplateRepository } from '../../repos/ToolTemplateRepository.js';
import {
  seedToolTemplates,
  memoryTemplate,
  todoTemplate,
  diceTemplate,
  choicesTemplate,
  timeTemplate,
  encouragementTemplate,
  npcRegistryTemplate,
  mapTemplate,
  forgeImageTemplate,
} from './toolTemplateSeeds.js';
import { LuaToolExecutor } from '../../services/LuaToolExecutor.js';
import type { ToolContextMessage } from '../../services/ToolTemplate.js';
import { LuaRuntime } from '../../scripting/LuaRuntime.js';

const EXPECTED_NAMES = [
  'lua_choices',
  'lua_dice',
  'lua_encouragement',
  'lua_forge_image',
  'lua_map',
  'lua_memory',
  'lua_npc_registry',
  'lua_time',
  'lua_todo',
];

let client: Client;
let repo: ToolTemplateRepository;

// Mirror the production `tool_templates` DDL (db/migrations/001_init.sql + 003_tool_template_sandbox.sql).
async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS tool_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      config_schema TEXT DEFAULT '{}',
      sandbox TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  await initSchema();
});

beforeEach(async () => {
  await client.execute('DELETE FROM tool_templates');
  repo = new ToolTemplateRepository(client);
});

afterAll(() => {
  client.close();
});

describe('toolTemplateSeeds definitions', () => {
  it('exports nine well-formed built-in Lua templates', () => {
    const seeds = [memoryTemplate, todoTemplate, diceTemplate, choicesTemplate, timeTemplate, encouragementTemplate, npcRegistryTemplate, mapTemplate, forgeImageTemplate];
    expect(seeds.map((s) => s.name).sort()).toEqual(EXPECTED_NAMES);
    for (const seed of seeds) {
      expect(seed.configSchema).toEqual({});
      expect(seed.code).toContain('function Tool.getDefinition()');
      expect(seed.code).toContain('function Tool.execute(');
    }
  });

  it('the forge image reference template opts into allowNet + allowFiles', () => {
    expect(forgeImageTemplate.sandbox).toEqual({ allowNet: true, allowFiles: true });
  });
});

describe('seedToolTemplates', () => {
  it('inserts all nine built-in templates with ids, configSchema, and Lua source', async () => {
    await seedToolTemplates(repo);
    const all = await repo.list();
    expect(all.map((t) => t.name).sort()).toEqual(EXPECTED_NAMES);
    for (const t of all) {
      expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(t.configSchema).toEqual({});
      expect(t.code.length).toBeGreaterThan(0);
      expect(t.createdAt).toBeGreaterThan(0);
      expect(t.updatedAt).toBeGreaterThan(0);
    }
  });

  it('persists config_schema as JSON text', async () => {
    await seedToolTemplates(repo);
    const rs = await client.execute({ sql: 'SELECT config_schema FROM tool_templates', args: [] });
    expect(rs.rows).toHaveLength(9);
    for (const row of rs.rows) {
      const raw = (row as Record<string, unknown>).config_schema;
      expect(typeof raw).toBe('string');
      expect(JSON.parse(raw as string)).toEqual({});
    }
  });

  it('is idempotent — a second run neither duplicates nor overwrites', async () => {
    await seedToolTemplates(repo);
    const first = await repo.list();
    await seedToolTemplates(repo);
    const second = await repo.list();
    expect(second).toHaveLength(9);
    expect(second.map((t) => t.id).sort()).toEqual(first.map((t) => t.id).sort());
  });

  it('only inserts missing templates and leaves existing rows untouched', async () => {
    await repo.create('custom-dice', { name: 'lua_dice', code: 'return "custom"', configSchema: { type: 'object' } });
    await seedToolTemplates(repo);
    const all = await repo.list();
    expect(all).toHaveLength(9);
    const dice = all.find((t) => t.name === 'lua_dice');
    expect(dice?.id).toBe('custom-dice');
    expect(dice?.code).toBe('return "custom"');
  });

  it('seeds Lua sources that load as valid tool definitions', async () => {
    await seedToolTemplates(repo);
    const executor = new LuaToolExecutor(new LuaRuntime());
    const all = await repo.list();
    for (const t of all) {
      const def = await executor.getDefinition(t.code);
      expect('error' in def, `template ${t.name} failed to load`).toBe(false);
      if ('error' in def) continue;
      expect(def.stateKey.length).toBeGreaterThan(0);
      expect(def.tools.length).toBeGreaterThan(0);
    }
  });
});

describe('lua_npc_registry template', () => {
  const executor = new LuaToolExecutor(new LuaRuntime());

  // The executor is stateless between calls — state travels via the
  // `_toolState` snapshot in each result, mirroring the production flow.
  function stateMessages(raw: string): ToolContextMessage[] {
    return [
      {
        id: '1',
        role: 'assistant',
        content: '',
        extra: {
          parts: [{ type: 'tool_result' as const, toolUseId: 'call-1', content: '', extra: { _toolState: { npc_registry: raw } } }],
        },
      },
    ];
  }

  function stateOf(result: { extra?: Record<string, unknown> }): { messages: ReturnType<typeof stateMessages> } {
    const raw = (result.extra!._toolState as Record<string, string>).npc_registry!;
    return { messages: stateMessages(raw) };
  }

  it('registers, updates, gets, lists, and forgets NPCs', async () => {
    const reg = await executor.execute(npcRegistryTemplate.code, 'npc_register', {
      name: 'Bram',
      description: 'A gruff blacksmith',
      personality: 'Stern but fair',
    });
    expect(reg.content).toBe('NPC registered: Bram');

    const get = await executor.execute(npcRegistryTemplate.code, 'npc_get', { name: 'Bram' }, stateOf(reg));
    expect(get.content).toContain('Name: Bram');
    expect(get.content).toContain('Description: A gruff blacksmith');
    expect(get.content).toContain('Personality: Stern but fair');

    const upd = await executor.execute(
      npcRegistryTemplate.code,
      'npc_update',
      { name: 'Bram', notes: 'Owes the party a favor' },
      stateOf(reg),
    );
    expect(upd.content).toBe('NPC updated: Bram');
    const afterUpd = await executor.execute(npcRegistryTemplate.code, 'npc_get', { name: 'Bram' }, stateOf(upd));
    expect(afterUpd.content).toContain('Notes: Owes the party a favor');

    const list = await executor.execute(npcRegistryTemplate.code, 'npc_list', {}, stateOf(upd));
    expect(list.content).toBe('Bram');
    const filtered = await executor.execute(npcRegistryTemplate.code, 'npc_list', { query: 'gruff' }, stateOf(upd));
    expect(filtered.content).toBe('Bram');
    const noMatch = await executor.execute(npcRegistryTemplate.code, 'npc_list', { query: 'wizard' }, stateOf(upd));
    expect(noMatch.content).toBe('No NPCs registered.');

    const forget = await executor.execute(npcRegistryTemplate.code, 'npc_forget', { name: 'Bram' }, stateOf(upd));
    expect(forget.content).toBe('NPC forgotten: Bram');
    const missing = await executor.execute(npcRegistryTemplate.code, 'npc_get', { name: 'Bram' }, stateOf(forget));
    expect(missing.content).toBe('NPC not found: Bram');
  });

  it('npc_update and npc_forget report unknown NPCs', async () => {
    const upd = await executor.execute(npcRegistryTemplate.code, 'npc_update', { name: 'Ghost', notes: 'x' });
    expect(upd.content).toBe('NPC not found: Ghost');
    const forget = await executor.execute(npcRegistryTemplate.code, 'npc_forget', { name: 'Ghost' });
    expect(forget.content).toBe('NPC not found: Ghost');
  });

  it('restores branch-aware state via serialize/deserialize', async () => {
    const reg = await executor.execute(npcRegistryTemplate.code, 'npc_register', {
      name: 'Bram',
      description: 'A gruff blacksmith',
    });
    const toolState = reg.extra!._toolState as Record<string, string>;
    expect(toolState.npc_registry).toBeDefined();

    const restored = await executor.execute(
      npcRegistryTemplate.code,
      'npc_get',
      { name: 'Bram' },
      { messages: stateMessages(toolState.npc_registry!) },
    );
    expect(restored.content).toContain('Name: Bram');
    expect(restored.content).toContain('Description: A gruff blacksmith');
  });

  it('mutation results carry the npc_roster render payload; query results do not', async () => {
    const reg = await executor.execute(npcRegistryTemplate.code, 'npc_register', {
      name: 'Bram',
      description: 'A gruff blacksmith',
      personality: 'Stern but fair',
    });
    expect(reg.extra?.renderType).toBe('npc_roster');
    expect(reg.extra?.npcs).toEqual({
      Bram: { description: 'A gruff blacksmith', personality: 'Stern but fair', notes: '' },
    });

    const reg2 = await executor.execute(
      npcRegistryTemplate.code,
      'npc_register',
      { name: 'Marta', description: 'Innkeeper' },
      stateOf(reg),
    );
    expect(reg2.extra?.renderType).toBe('npc_roster');
    expect(reg2.extra?.npcs).toEqual({
      Bram: { description: 'A gruff blacksmith', personality: 'Stern but fair', notes: '' },
      Marta: { description: 'Innkeeper', personality: '', notes: '' },
    });

    const upd = await executor.execute(
      npcRegistryTemplate.code,
      'npc_update',
      { name: 'Bram', notes: 'Owes the party a favor' },
      stateOf(reg2),
    );
    expect(upd.extra?.renderType).toBe('npc_roster');
    const updNpcs = upd.extra?.npcs as Record<string, { notes?: string }>;
    expect(updNpcs.Bram?.notes).toBe('Owes the party a favor');
    expect(updNpcs.Marta).toBeDefined();

    // Query tools keep generic text results — no render payload.
    const get = await executor.execute(npcRegistryTemplate.code, 'npc_get', { name: 'Bram' }, stateOf(upd));
    expect(get.extra?.renderType).toBeUndefined();
    expect(get.extra?.npcs).toBeUndefined();
    const list = await executor.execute(npcRegistryTemplate.code, 'npc_list', {}, stateOf(upd));
    expect(list.extra?.renderType).toBeUndefined();
    expect(list.extra?.npcs).toBeUndefined();

    const forget = await executor.execute(npcRegistryTemplate.code, 'npc_forget', { name: 'Bram' }, stateOf(upd));
    expect(forget.extra?.renderType).toBe('npc_roster');
    expect(forget.extra?.npcs).toEqual({
      Marta: { description: 'Innkeeper', personality: '', notes: '' },
    });
  });
});

describe('lua_choices template', () => {
  const executor = new LuaToolExecutor(new LuaRuntime());

  it('returns renderType, prompt, and choices for a valid call', async () => {
    const res = await executor.execute(choicesTemplate.code, 'present_choices', {
      options: ['Open the door', 'Sneak around', 'Turn back'],
      prompt: 'What do you do?',
    });
    expect(res.content).toBe('Presented 3 choices to the user: Open the door, Sneak around, Turn back');
    expect(res.extra?.renderType).toBe('choices');
    expect(res.extra?.choicesPrompt).toBe('What do you do?');
    expect(res.extra?.choices).toEqual(['Open the door', 'Sneak around', 'Turn back']);
  });

  it('defaults choicesPrompt to an empty string when prompt is omitted', async () => {
    const res = await executor.execute(choicesTemplate.code, 'present_choices', {
      options: ['Left', 'Right'],
    });
    expect(res.extra?.renderType).toBe('choices');
    expect(res.extra?.choicesPrompt).toBe('');
    expect(res.extra?.choices).toEqual(['Left', 'Right']);
  });

  it('rejects fewer than 2 options', async () => {
    const res = await executor.execute(choicesTemplate.code, 'present_choices', {
      options: ['Only one'],
    });
    expect(res.content).toContain('Error');
    expect(res.extra?.renderType).toBeUndefined();
  });

  it('rejects more than 6 options', async () => {
    const res = await executor.execute(choicesTemplate.code, 'present_choices', {
      options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    expect(res.content).toContain('Error');
    expect(res.extra?.renderType).toBeUndefined();
  });

  it('rejects empty-string options', async () => {
    const res = await executor.execute(choicesTemplate.code, 'present_choices', {
      options: ['Valid', ''],
    });
    expect(res.content).toContain('Error');
    expect(res.extra?.renderType).toBeUndefined();
  });

  it('is stateless — serialize returns an empty string', async () => {
    const res = await executor.execute(choicesTemplate.code, 'present_choices', {
      options: ['A', 'B'],
    });
    const toolState = res.extra?._toolState as Record<string, string> | undefined;
    expect(toolState?.choices).toBe('');
  });

  it('declares endsTurn on present_choices', async () => {
    const def = await executor.getDefinition(choicesTemplate.code);
    expect('error' in def).toBe(false);
    if ('error' in def) return;
    expect(def.tools.find((t) => t.name === 'present_choices')?.endsTurn).toBe(true);
  });
});

describe('lua_map template', () => {
  const executor = new LuaToolExecutor(new LuaRuntime());

  interface MapPayload {
    width: number;
    height: number;
    grid: Array<Array<{ t: string; l?: string }>>;
    player: { x: number; y: number };
    explored: string[];
  }

  // The executor is stateless between calls — state travels via the
  // `_toolState` snapshot in each result, mirroring the production flow.
  function stateMessages(raw: string): ToolContextMessage[] {
    return [
      {
        id: '1',
        role: 'assistant',
        content: '',
        extra: {
          parts: [{ type: 'tool_result' as const, toolUseId: 'call-1', content: '', extra: { _toolState: { map: raw } } }],
        },
      },
    ];
  }

  function stateOf(result: { extra?: Record<string, unknown> }): { messages: ReturnType<typeof stateMessages> } {
    const raw = (result.extra!._toolState as Record<string, string>).map!;
    return { messages: stateMessages(raw) };
  }

  function payloadOf(result: { extra?: Record<string, unknown> }): MapPayload {
    return result.extra!.map as MapPayload;
  }

  it('map_create builds a filled map, places the player, and reveals fog around the start', async () => {
    const res = await executor.execute(mapTemplate.code, 'map_create', { width: 8, height: 6 });
    expect(res.content).toContain('Map created: 8x6 of grass');
    expect(res.content).toContain('The party starts at (0,0)');
    expect(res.extra?.renderType).toBe('map');

    const map = payloadOf(res);
    expect(map.width).toBe(8);
    expect(map.height).toBe(6);
    expect(map.grid).toHaveLength(6);
    for (const row of map.grid) {
      expect(row).toHaveLength(8);
      for (const tile of row) {
        expect(tile.t).toBe('grass');
      }
    }
    expect(map.player).toEqual({ x: 0, y: 0 });
    // Radius-2 reveal clipped to the corner: x 0..2, y 0..2.
    expect(map.explored).toHaveLength(9);
    expect(map.explored).toContain('0,0');
    expect(map.explored).toContain('2,2');
    expect(map.explored).not.toContain('3,0');

    expect((res.extra!._toolState as Record<string, string>).map).toBeDefined();
  });

  it('map_create clamps dimensions to 1-40 and validates fill terrain and start position', async () => {
    const clamped = await executor.execute(mapTemplate.code, 'map_create', { width: 100, height: 0 });
    const map = payloadOf(clamped);
    expect(map.width).toBe(40);
    expect(map.height).toBe(1);

    const badFill = await executor.execute(mapTemplate.code, 'map_create', { width: 4, height: 4, fill: 'lava' });
    expect(badFill.content).toContain("unknown terrain 'lava'");
    expect(badFill.extra?.renderType).toBeUndefined();

    const badStart = await executor.execute(mapTemplate.code, 'map_create', { width: 4, height: 4, startX: 4, startY: 0 });
    expect(badStart.content).toContain('outside a 4x4 map');
    expect(badStart.extra?.renderType).toBeUndefined();
  });

  it('map_set_tile paints terrain and labels, keeping the label on later terrain-only paints', async () => {
    const created = await executor.execute(mapTemplate.code, 'map_create', { width: 8, height: 6 });
    const set = await executor.execute(
      mapTemplate.code,
      'map_set_tile',
      { x: 3, y: 2, terrain: 'forest', label: 'Darkwood' },
      stateOf(created),
    );
    expect(set.content).toBe('Tile (3,2) set to forest (Darkwood).');
    expect(set.extra?.renderType).toBe('map');
    expect(payloadOf(set).grid[2]![3]).toEqual({ t: 'forest', l: 'Darkwood' });

    const repaint = await executor.execute(mapTemplate.code, 'map_set_tile', { x: 3, y: 2, terrain: 'road' }, stateOf(set));
    expect(payloadOf(repaint).grid[2]![3]).toEqual({ t: 'road', l: 'Darkwood' });
  });

  it('map_set_tile rejects unknown terrain and out-of-bounds coordinates without a payload', async () => {
    const created = await executor.execute(mapTemplate.code, 'map_create', { width: 4, height: 4 });
    const badTerrain = await executor.execute(
      mapTemplate.code,
      'map_set_tile',
      { x: 1, y: 1, terrain: 'lava' },
      stateOf(created),
    );
    expect(badTerrain.content).toContain("unknown terrain 'lava'");
    expect(badTerrain.extra?.renderType).toBeUndefined();

    const outOfBounds = await executor.execute(
      mapTemplate.code,
      'map_set_tile',
      { x: 9, y: 1, terrain: 'forest' },
      stateOf(created),
    );
    expect(outOfBounds.content).toContain('outside the map');
    expect(outOfBounds.extra?.renderType).toBeUndefined();
  });

  it('map_move updates the player, describes the surroundings, and reveals fog', async () => {
    const created = await executor.execute(mapTemplate.code, 'map_create', { width: 8, height: 6 });
    const moved = await executor.execute(mapTemplate.code, 'map_move', { direction: 'east' }, stateOf(created));
    expect(moved.content).toContain('The party moves east to (1,0): grass.');
    expect(moved.content).toContain('north: map edge');
    expect(moved.content).toContain('south: grass');
    const map = payloadOf(moved);
    expect(map.player).toEqual({ x: 1, y: 0 });
    expect(map.explored).toContain('3,0');
    expect(map.explored).toContain('3,2');
  });

  it('map_move is blocked by impassable terrain and by the map edge, still emitting the map payload', async () => {
    const created = await executor.execute(mapTemplate.code, 'map_create', { width: 4, height: 4 });
    const walled = await executor.execute(
      mapTemplate.code,
      'map_set_tile',
      { x: 1, y: 0, terrain: 'water' },
      stateOf(created),
    );
    const blocked = await executor.execute(mapTemplate.code, 'map_move', { direction: 'east' }, stateOf(walled));
    expect(blocked.content).toContain('Blocked: water lies east and cannot be crossed');
    expect(blocked.content).toContain('remains at (0,0)');
    expect(blocked.extra?.renderType).toBe('map');
    expect(payloadOf(blocked).player).toEqual({ x: 0, y: 0 });

    const edge = await executor.execute(mapTemplate.code, 'map_move', { direction: 'west' }, stateOf(walled));
    expect(edge.content).toContain('Blocked: the map edge lies west');
    expect(edge.extra?.renderType).toBe('map');
    expect(payloadOf(edge).player).toEqual({ x: 0, y: 0 });

    const badDir = await executor.execute(mapTemplate.code, 'map_move', { direction: 'north-east' }, stateOf(walled));
    expect(badDir.content).toContain('direction must be one of');
    expect(badDir.extra?.renderType).toBeUndefined();
  });

  it('map_teleport places the party anywhere in bounds — even on impassable tiles — and reveals fog', async () => {
    const created = await executor.execute(mapTemplate.code, 'map_create', { width: 8, height: 6 });
    const lake = await executor.execute(
      mapTemplate.code,
      'map_set_tile',
      { x: 5, y: 4, terrain: 'water' },
      stateOf(created),
    );
    const teleported = await executor.execute(mapTemplate.code, 'map_teleport', { x: 5, y: 4 }, stateOf(lake));
    expect(teleported.content).toContain('The party appears at (5,4): water.');
    const map = payloadOf(teleported);
    expect(map.player).toEqual({ x: 5, y: 4 });
    expect(map.explored).toContain('5,4');
    expect(map.explored).toContain('7,5');

    const outOfBounds = await executor.execute(mapTemplate.code, 'map_teleport', { x: 8, y: 0 }, stateOf(lake));
    expect(outOfBounds.content).toContain('outside the map');
    expect(outOfBounds.extra?.renderType).toBeUndefined();
  });

  it('map_get returns a text-only description with no render payload', async () => {
    const created = await executor.execute(mapTemplate.code, 'map_create', { width: 8, height: 6 });
    const moved = await executor.execute(mapTemplate.code, 'map_move', { direction: 'east' }, stateOf(created));
    const got = await executor.execute(mapTemplate.code, 'map_get', {}, stateOf(moved));
    expect(got.content).toContain('The party is at (1,0): grass.');
    expect(got.content).toContain('west: grass');
    expect(got.extra?.renderType).toBeUndefined();
    expect(got.extra?.map).toBeUndefined();
  });

  it('mutation tools report the missing map until map_create runs', async () => {
    const move = await executor.execute(mapTemplate.code, 'map_move', { direction: 'east' });
    expect(move.content).toContain('no map exists yet');
    const set = await executor.execute(mapTemplate.code, 'map_set_tile', { x: 0, y: 0, terrain: 'forest' });
    expect(set.content).toContain('no map exists yet');
    const teleport = await executor.execute(mapTemplate.code, 'map_teleport', { x: 0, y: 0 });
    expect(teleport.content).toContain('no map exists yet');
    const get = await executor.execute(mapTemplate.code, 'map_get', {});
    expect(get.content).toContain('No map exists yet');
  });

  it('restores branch-aware state via serialize/deserialize', async () => {
    const created = await executor.execute(mapTemplate.code, 'map_create', { width: 4, height: 4 });
    const moved = await executor.execute(mapTemplate.code, 'map_move', { direction: 'south' }, stateOf(created));
    const toolState = (moved.extra!._toolState as Record<string, string>).map!;

    const restored = await executor.execute(
      mapTemplate.code,
      'map_get',
      {},
      { messages: stateMessages(toolState) },
    );
    expect(restored.content).toContain('The party is at (0,1): grass.');
  });
});
