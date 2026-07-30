import { describe, it, expect, vi } from 'vitest';
import { ToolsetWorkbench } from './ToolsetWorkbench.js';
import { LuaRuntime } from '../../scripting/LuaRuntime.js';
import { LuaToolExecutor } from '../LuaToolExecutor.js';
import type { Toolset, ToolsetCreateInput, ToolsetUpdateInput } from '@tamari/types';
import type { EventBus } from '../../bus/EventBus.js';
import type { ToolTemplate, ToolTemplateDefinition } from '../ToolTemplate.js';

const echoCode = `
Tool = {}
function Tool.getDefinition()
  return { stateKey = "echo", configSchema = {}, tools = { { name = "echo_test", description = "Echoes", parameters = {} } } }
end
function Tool.execute(args, context, toolName)
  return "echo"
end
return Tool
`;

function makeBuiltin(id: string, tools: string[]): ToolTemplate {
  return {
    id,
    name: `Builtin ${id}`,
    source: 'builtin',
    getDefinition: async (): Promise<ToolTemplateDefinition> => ({
      stateKey: id,
      configSchema: {},
      tools: tools.map((name) => ({ name, description: '', parameters: {} })),
    }),
    execute: async () => ({ content: 'ok' }),
    serialize: () => '',
    deserialize: () => {},
  };
}

function makeToolset(overrides: Partial<Toolset> = {}): Toolset {
  return {
    id: 'ts1',
    templateId: 'workbench',
    name: 'BW',
    config: {},
    toolOverrides: {},
    enabled: true,
    agentVisible: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeTemplate(opts: { toolsets?: Toolset[]; luaTemplates?: Record<string, string> } = {}) {
  const store = new Map((opts.toolsets ?? []).map((t) => [t.id, t]));
  const toolsets = {
    list: async () => [...store.values()],
    listEnabled: async () => [...store.values()].filter((t) => t.enabled),
    listAgentVisible: async () => [...store.values()].filter((t) => t.enabled && t.agentVisible),
    getById: async (id: string) => store.get(id),
    create: async (id: string, data: ToolsetCreateInput) => {
      const ts = makeToolset({ id, ...data });
      store.set(id, ts);
      return ts;
    },
    update: async (id: string, patch: ToolsetUpdateInput) => {
      const existing = store.get(id);
      if (!existing) throw new Error('not found');
      const updated = { ...existing, ...patch };
      store.set(id, updated);
      return updated;
    },
    delete: async (id: string) => {
      store.delete(id);
    },
  };

  const luaExecutor = new LuaToolExecutor(new LuaRuntime());
  const builtins = new Map([makeBuiltin('workbench', ['backend_get', 'backend_test'])].map((t) => [t.id, t]));
  const toolRegistry = {
    getTemplate: async (id: string): Promise<ToolTemplate | undefined> => {
      const builtin = builtins.get(id);
      if (builtin) return builtin;
      const code = opts.luaTemplates?.[id];
      if (!code) return undefined;
      return {
        id,
        name: `Lua ${id}`,
        source: 'lua',
        getDefinition: async () => {
          const def = await luaExecutor.getDefinition(code);
          if ('error' in def) throw new Error(def.error);
          return def;
        },
        execute: async () => ({ content: 'ok' }),
        serialize: () => '',
        deserialize: () => {},
      };
    },
  };

  const bus = { broadcast: vi.fn() } as unknown as EventBus;

  const template = new ToolsetWorkbench({ toolsets, toolRegistry, bus });
  return { template, bus, store };
}

function broadcastTypes(bus: EventBus): string[] {
  const broadcast = bus.broadcast as ReturnType<typeof vi.fn>;
  return broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
}

describe('ToolsetWorkbench', () => {
  describe('toolset_get', () => {
    it('gets a toolset with the template definition', async () => {
      const { template } = makeTemplate({ toolsets: [makeToolset()] });
      const res = await template.execute('toolset_get', { id: 'ts1' });
      const parsed = JSON.parse(res.content as string) as { id: string; definition: { tools: Array<{ name: string }> } };
      expect(parsed.id).toBe('ts1');
      expect(parsed.definition.tools).toHaveLength(2);
    });

    it('errors for an unknown id', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('toolset_get', { id: 'nope' });
      expect(res.content).toBe('Error: toolset "nope" not found');
    });
  });

  describe('toolset_create', () => {
    it('creates an enabled toolset from a builtin template', async () => {
      const { template, bus, store } = makeTemplate();
      const res = await template.execute('toolset_create', { templateId: 'workbench' });
      const parsed = JSON.parse(res.content as string) as { id: string; name: string; enabled: boolean; tools: string[] };
      expect(parsed.enabled).toBe(true);
      expect(parsed.name).toBe('Builtin workbench');
      expect(parsed.tools).toEqual(['backend_get', 'backend_test']);
      expect(store.size).toBe(1);
      expect(broadcastTypes(bus)).toEqual(['toolset.created', 'toolset.listed']);
    });

    it('creates a toolset from a Lua template id', async () => {
      const { template } = makeTemplate({ luaTemplates: { lua1: echoCode } });
      const res = await template.execute('toolset_create', { templateId: 'lua1', enabled: true });
      const parsed = JSON.parse(res.content as string) as { tools: string[] };
      expect(parsed.tools).toEqual(['echo_test']);
    });

    it('rejects an unknown template without saving', async () => {
      const { template, store } = makeTemplate();
      const res = await template.execute('toolset_create', { templateId: 'nope' });
      expect(res.content).toContain('Error: template "nope" not found');
      expect(store.size).toBe(0);
    });

    it('rejects a Lua template that fails to load', async () => {
      const { template, store } = makeTemplate({ luaTemplates: { broken: 'this is not lua' } });
      const res = await template.execute('toolset_create', { templateId: 'broken' });
      expect(res.content).toContain('Error: template failed to load');
      expect(store.size).toBe(0);
    });
  });

  describe('toolset_update', () => {
    it('disables a toolset and broadcasts', async () => {
      const { template, bus, store } = makeTemplate({ toolsets: [makeToolset()] });
      const res = await template.execute('toolset_update', { id: 'ts1', patch: { enabled: false } });
      const parsed = JSON.parse(res.content as string) as { enabled: boolean };
      expect(parsed.enabled).toBe(false);
      expect(store.get('ts1')?.enabled).toBe(false);
      expect(broadcastTypes(bus)).toEqual(['toolset.updated', 'toolset.listed']);
    });

    it('replaces config wholesale', async () => {
      const { template, store } = makeTemplate({ toolsets: [makeToolset({ config: { a: 1 } })] });
      await template.execute('toolset_update', { id: 'ts1', patch: { config: { b: 2 } } });
      expect(store.get('ts1')?.config).toEqual({ b: 2 });
    });

    it('errors for an unknown id', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('toolset_update', { id: 'nope', patch: { enabled: false } });
      expect(res.content).toBe('Error: toolset "nope" not found');
    });
  });
});
