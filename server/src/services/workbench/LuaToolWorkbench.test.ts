import { describe, it, expect, vi } from 'vitest';
import { LuaToolWorkbench } from './LuaToolWorkbench.js';
import { LuaRuntime } from '../../scripting/LuaRuntime.js';
import { LuaToolExecutor } from '../LuaToolExecutor.js';
import type { ToolTemplate, ToolTemplateCreateInput, ToolTemplateUpdateInput } from '@tamari/types';
import type { EventBus } from '../../bus/EventBus.js';

const echoCode = `
Tool = {}
function Tool.getDefinition()
  return {
    stateKey = "echo",
    configSchema = {},
    tools = {
      {
        name = "echo_test",
        description = "Echoes text",
        parameters = { type = "object", properties = { text = { type = "string" } } }
      }
    }
  }
end
function Tool.execute(args, context, toolName)
  return "echo:" .. tostring(args.text) .. " os:" .. type(os)
end
return Tool
`;

function makeStored(overrides: Partial<ToolTemplate> = {}): ToolTemplate {
  return {
    id: 'tpl1',
    name: 'Echo',
    code: echoCode,
    configSchema: {},
    sandbox: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeTemplate(opts: { stored?: ToolTemplate[] } = {}) {
  const store = new Map((opts.stored ?? []).map((t) => [t.id, t]));
  const toolTemplates = {
    list: async () => [...store.values()],
    getById: async (id: string) => store.get(id),
    create: async (id: string, data: ToolTemplateCreateInput) => {
      const t = makeStored({ id, ...data, name: data.name, code: data.code });
      store.set(id, t);
      return t;
    },
    update: async (id: string, patch: ToolTemplateUpdateInput) => {
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

  const bus = { broadcast: vi.fn() } as unknown as EventBus;
  const registry = { invalidateLuaCache: vi.fn() };
  const luaExecutor = new LuaToolExecutor(new LuaRuntime());

  const template = new LuaToolWorkbench({ toolTemplates, luaExecutor, registry, bus });
  return { template, bus, registry, store };
}

function broadcastTypes(bus: EventBus): string[] {
  const broadcast = bus.broadcast as ReturnType<typeof vi.fn>;
  return broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
}

describe('LuaToolWorkbench', () => {
  describe('luatool_get', () => {
    it('gets a template with full code', async () => {
      const { template } = makeTemplate({ stored: [makeStored()] });
      const res = await template.execute('luatool_get', { id: 'tpl1' });
      const parsed = JSON.parse(res.content as string) as ToolTemplate;
      expect(parsed.code).toBe(echoCode);
    });

    it('errors for an unknown id', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('luatool_get', { id: 'nope' });
      expect(res.content).toBe('Error: Lua tool template "nope" not found');
    });
  });

  describe('luatool_create', () => {
    it('validates, saves, and returns the parsed definition', async () => {
      const { template, bus, registry, store } = makeTemplate();
      const res = await template.execute('luatool_create', { name: 'Echo', code: echoCode });
      const parsed = JSON.parse(res.content as string) as { id: string; name: string; definition: { tools: Array<{ name: string }> } };
      expect(parsed.id).toBeTruthy();
      expect(parsed.definition.tools[0]?.name).toBe('echo_test');
      expect(store.size).toBe(1);
      expect(broadcastTypes(bus)).toEqual(['toolTemplate.created', 'toolTemplate.listed']);
      expect(registry.invalidateLuaCache).toHaveBeenCalled();
    });

    it('rejects invalid code without saving', async () => {
      const { template, bus, store } = makeTemplate();
      const res = await template.execute('luatool_create', { name: 'Broken', code: 'this is not lua' });
      expect(res.content).toContain('Error: template validation failed');
      expect(store.size).toBe(0);
      expect(broadcastTypes(bus)).toEqual([]);
    });

    it('rejects code without a Tool table', async () => {
      const { template, store } = makeTemplate();
      const res = await template.execute('luatool_create', { name: 'Empty', code: 'return {}' });
      expect(res.content).toContain('Error: template validation failed');
      expect(store.size).toBe(0);
    });
  });

  describe('luatool_update', () => {
    it('updates code after validating the effective source', async () => {
      const { template, bus, store } = makeTemplate({ stored: [makeStored()] });
      const newCode = echoCode.replace('echo:', 'reply:');
      const res = await template.execute('luatool_update', { id: 'tpl1', patch: { code: newCode } });
      const parsed = JSON.parse(res.content as string) as { code: string };
      expect(parsed.code).toBe(newCode);
      expect(store.get('tpl1')?.code).toBe(newCode);
      expect(broadcastTypes(bus)).toEqual(['toolTemplate.updated', 'toolTemplate.listed']);
    });

    it('rejects an invalid patch without saving', async () => {
      const { template, store } = makeTemplate({ stored: [makeStored()] });
      const res = await template.execute('luatool_update', { id: 'tpl1', patch: { code: 'garbage(' } });
      expect(res.content).toContain('Error: template validation failed');
      expect(store.get('tpl1')?.code).toBe(echoCode);
    });

    it('errors for an unknown id', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('luatool_update', { id: 'nope', patch: { name: 'x' } });
      expect(res.content).toBe('Error: Lua tool template "nope" not found');
    });
  });

  describe('luatool_test', () => {
    it('runs a stored template with fresh state', async () => {
      const { template } = makeTemplate({ stored: [makeStored()] });
      const res = await template.execute('luatool_test', { id: 'tpl1', toolName: 'echo_test', args: { text: 'hi' } });
      const parsed = JSON.parse(res.content as string) as { content: string };
      expect(parsed.content).toBe('echo:hi os:nil');
    });

    it('runs raw unsaved code', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('luatool_test', { code: echoCode, toolName: 'echo_test', args: { text: 'raw' } });
      const parsed = JSON.parse(res.content as string) as { content: string };
      expect(parsed.content).toBe('echo:raw os:nil');
    });

    it('honors sandbox flags for raw code', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('luatool_test', {
        code: echoCode,
        sandbox: { allowOs: true },
        toolName: 'echo_test',
        args: { text: 'x' },
      });
      const parsed = JSON.parse(res.content as string) as { content: string };
      expect(parsed.content).toBe('echo:x os:table');
    });

    it('honors stored sandbox flags when testing by id', async () => {
      const { template } = makeTemplate({ stored: [makeStored({ sandbox: { allowOs: true } })] });
      const res = await template.execute('luatool_test', { id: 'tpl1', toolName: 'echo_test', args: { text: 'x' } });
      const parsed = JSON.parse(res.content as string) as { content: string };
      expect(parsed.content).toBe('echo:x os:table');
    });

    it('rejects when both id and code are given', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('luatool_test', { id: 'tpl1', code: echoCode, toolName: 'echo_test' });
      expect(res.content).toContain('Error: invalid arguments');
    });

    it('returns Lua execution errors as content', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('luatool_test', { code: 'this is not lua', toolName: 'x' });
      const parsed = JSON.parse(res.content as string) as { content: string };
      expect(parsed.content).toContain('Lua compilation error');
    });

    it('forwards chatId/clientId from its own context (allowSt testing)', async () => {
      const luaExecutor = {
        execute: vi.fn(async () => ({ content: 'ok' })),
        getDefinition: vi.fn(async () => ({ stateKey: 'x', configSchema: {}, tools: [] })),
      };
      const store = new Map<string, ToolTemplate>();
      const toolTemplates = {
        list: async () => [...store.values()],
        getById: async (id: string) => store.get(id),
      };
      const template = new LuaToolWorkbench({
        toolTemplates: toolTemplates as never,
        luaExecutor: luaExecutor as never,
        registry: { invalidateLuaCache: vi.fn() },
        bus: { broadcast: vi.fn() } as never,
      });
      await template.execute('luatool_test', { code: 'Tool = {}', toolName: 't' }, { chatId: 'chat1', clientId: 'client1' });
      expect(luaExecutor.execute).toHaveBeenCalledWith(
        'Tool = {}',
        't',
        {},
        { config: {}, chatId: 'chat1', clientId: 'client1' },
        undefined,
      );
    });
  });
});
