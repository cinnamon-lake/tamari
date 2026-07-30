import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from './ToolRegistry.js';
import { LuaToolExecutor } from './LuaToolExecutor.js';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import type { ToolTemplate, ToolExecuteResult } from './ToolTemplate.js';

function makeMockTemplate(id: string, toolNames: string[]): ToolTemplate {
  return {
    id,
    name: id,
    source: 'builtin',
    getDefinition: () => ({
      stateKey: id,
      configSchema: {},
      tools: toolNames.map((name) => ({
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object', properties: {} },
      })),
    }),
    execute: async (toolName: string): Promise<ToolExecuteResult> => ({
      content: `${id}:${toolName}`,
    }),
    serialize: () => '',
    deserialize: () => {},
  };
}

describe('ToolRegistry', () => {
  it('registers and retrieves templates', () => {
    const registry = new ToolRegistry();
    const tmpl = makeMockTemplate('test', ['a']);
    registry.registerTemplate(tmpl);
    expect(registry.getBuiltinTemplate('test')).toBe(tmpl);
    expect(registry.getAllBuiltinTemplates()).toHaveLength(1);
  });

  it('resolves definitions from toolsets', async () => {
    const registry = new ToolRegistry();
    registry.registerTemplate(makeMockTemplate('alpha', ['a1', 'a2']));
    registry.registerTemplate(makeMockTemplate('beta', ['b1']));

    const defs = await registry.getDefinitionsByToolsets([
      { templateId: 'alpha', toolOverrides: {} },
      { templateId: 'beta', toolOverrides: { b1: { name: 'B1_Renamed' } } },
    ]);
    expect(defs).toHaveLength(3);
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('a1');
    expect(names).toContain('a2');
    expect(names).toContain('B1_Renamed');
  });

  it('strips the JSON-Schema $schema marker from emitted parameters', async () => {
    const registry = new ToolRegistry();
    const tmpl = makeMockTemplate('schema-y', ['tool1']);
    tmpl.getDefinition = () => ({
      stateKey: 'schema-y',
      configSchema: {},
      tools: [
        {
          name: 'tool1',
          description: 'Tool tool1',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      ],
    });
    registry.registerTemplate(tmpl);

    const defs = await registry.getDefinitionsByToolsets([{ templateId: 'schema-y', toolOverrides: {} }]);
    const params = defs[0]!.function.parameters as Record<string, unknown>;
    expect('$schema' in params).toBe(false);
    expect(params['required']).toEqual(['name']);
    expect(params['properties']).toEqual({ name: { type: 'string' } });
  });

  it('executes a tool via toolset', async () => {
    const registry = new ToolRegistry();
    const toolsetRepo = {
      list: vi.fn(async () => [
        { id: 'ts1', templateId: 'test', name: 'Test Toolset', config: {}, toolOverrides: {}, enabled: true, agentVisible: false, createdAt: 0, updatedAt: 0 },
      ]),
      listEnabled: vi.fn(),
      listAgentVisible: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    registry.registerTemplate(makeMockTemplate('test', ['greet']));
    registry.setToolsetRepository(toolsetRepo);

    const result = await registry.execute({ id: 'call_1', name: 'greet', arguments: {} });
    expect(result.content).toBe('test:greet');
  });

  it('returns error when tool is not found', async () => {
    const registry = new ToolRegistry();
    const toolsetRepo = {
      list: vi.fn(async () => []),
      listEnabled: vi.fn(),
      listAgentVisible: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    registry.setToolsetRepository(toolsetRepo);

    const result = await registry.execute({ id: 'call_1', name: 'missing', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('returns error when execution throws', async () => {
    const registry = new ToolRegistry();
    const tmpl: ToolTemplate = {
      id: 'fail',
      name: 'fail',
      source: 'builtin',
      getDefinition: () => ({ stateKey: 'fail', configSchema: {}, tools: [{ name: 'fail_tool', description: 'Fails', parameters: {} }] }),
      execute: async () => { throw new Error('boom'); },
      serialize: () => '',
      deserialize: () => {},
    };
    registry.registerTemplate(tmpl);
    const toolsetRepo = {
      list: vi.fn(async () => [
        { id: 'ts1', templateType: 'builtin' as const, templateId: 'fail', name: 'Fail', config: {}, toolOverrides: {}, enabled: true, agentVisible: false, createdAt: 0, updatedAt: 0 },
      ]),
      listEnabled: vi.fn(),
      listAgentVisible: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    registry.setToolsetRepository(toolsetRepo);

    const result = await registry.execute({ id: 'call_1', name: 'fail_tool', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toBe('boom');
  });
});

describe('Lua tools in ToolRegistry', () => {
  const luaCode = `
Tool = {}
function Tool.getDefinition()
  return {
    stateKey = "lua_greet",
    configSchema = {},
    tools = {
      { name = "lua_greet", description = "Lua greeting", parameters = { type = "object", properties = { name = { type = "string" } } } }
    }
  }
end
function Tool.execute(args, context, toolName)
  return "Lua says hello, " .. tostring(args.name)
end
return Tool
`;

  function makeTemplateRepo(tools: Array<{ id: string; name: string; code: string }>) {
    const full = tools.map((t) => ({
      ...t,
      configSchema: {},
      createdAt: 0,
      updatedAt: 0,
    }));
    return {
      list: vi.fn(async () => full),
      getById: vi.fn(async (id: string) => full.find((t) => t.id === id)),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
  }

  it('includes Lua tools in getDefinitionsByToolsets', async () => {
    const registry = new ToolRegistry();
    registry.registerTemplate(makeMockTemplate('base', ['base_tool']));
    const templateRepo = makeTemplateRepo([{ id: '1', name: 'lua_greet', code: luaCode }]);
    const executor = new LuaToolExecutor(new LuaRuntime());
    registry.setTemplateRepository(templateRepo);
    registry.setLuaToolExecutor(executor);

    const toolsets = [
      { templateId: 'base', toolOverrides: {} },
      { templateId: '1', toolOverrides: {} },
    ];
    const defs = await registry.getDefinitionsByToolsets(toolsets);
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('base_tool');
    expect(names).toContain('lua_greet');
  });

  it('executes a Lua tool by name', async () => {
    const registry = new ToolRegistry();
    const templateRepo = makeTemplateRepo([{ id: '1', name: 'lua_greet', code: luaCode }]);
    const executor = new LuaToolExecutor(new LuaRuntime());
    registry.setTemplateRepository(templateRepo);
    registry.setLuaToolExecutor(executor);

    const toolsetRepo = {
      list: vi.fn(async () => [
        { id: 'ts1', templateId: '1', name: 'Lua Greet', config: {}, toolOverrides: {}, enabled: true, agentVisible: false, createdAt: 0, updatedAt: 0 },
      ]),
      listEnabled: vi.fn(),
      listAgentVisible: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    registry.setToolsetRepository(toolsetRepo);

    const result = await registry.execute({ id: 'c1', name: 'lua_greet', arguments: { name: 'World' } });
    expect(result.content).toBe('Lua says hello, World');
  });

  it('skips broken Lua tools silently from definitions', async () => {
    const registry = new ToolRegistry();
    const badCode = 'this is not lua';
    const templateRepo = makeTemplateRepo([{ id: '1', name: 'bad', code: badCode }]);
    const executor = new LuaToolExecutor(new LuaRuntime());
    registry.setTemplateRepository(templateRepo);
    registry.setLuaToolExecutor(executor);

    const toolsets = [{ templateId: '1', toolOverrides: {} }];
    const defs = await registry.getDefinitionsByToolsets(toolsets);
    expect(defs).toHaveLength(0);
  });
});

describe('ToolRegistry endsTurn', () => {
  function makeToolsetRepo(templateId: string) {
    return {
      list: vi.fn(async () => [
        { id: 'ts1', templateId, name: 'TS', config: {}, toolOverrides: {}, enabled: true, agentVisible: false, createdAt: 0, updatedAt: 0 },
      ]),
      listEnabled: vi.fn(),
      listAgentVisible: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
  }

  function makeTemplate(id: string, endsTurn: boolean, fail = false): ToolTemplate {
    return {
      id,
      name: id,
      source: 'builtin',
      getDefinition: () => ({
        stateKey: id,
        configSchema: {},
        tools: [{ name: 'tool', description: 'T', parameters: {}, endsTurn }],
      }),
      execute: async (): Promise<ToolExecuteResult> => {
        if (fail) throw new Error('boom');
        return { content: 'ok' };
      },
      serialize: () => '',
      deserialize: () => {},
    };
  }

  it('returns endsTurn: true for a flagged tool on success', async () => {
    const registry = new ToolRegistry();
    registry.registerTemplate(makeTemplate('t', true));
    registry.setToolsetRepository(makeToolsetRepo('t'));

    const result = await registry.execute({ id: 'c1', name: 'tool', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.endsTurn).toBe(true);
  });

  it('returns falsy endsTurn for an unflagged tool', async () => {
    const registry = new ToolRegistry();
    registry.registerTemplate(makeTemplate('t', false));
    registry.setToolsetRepository(makeToolsetRepo('t'));

    const result = await registry.execute({ id: 'c1', name: 'tool', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.endsTurn).toBeFalsy();
  });

  it('returns falsy endsTurn when execution errors, so the model can retry', async () => {
    const registry = new ToolRegistry();
    registry.registerTemplate(makeTemplate('t', true, true));
    registry.setToolsetRepository(makeToolsetRepo('t'));

    const result = await registry.execute({ id: 'c1', name: 'tool', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.endsTurn).toBeFalsy();
  });

  it('does not leak endsTurn into provider-facing tool definitions', async () => {
    const registry = new ToolRegistry();
    registry.registerTemplate(makeTemplate('t', true));

    const defs = await registry.getDefinitionsByToolsets([{ templateId: 't', toolOverrides: {} }]);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.function).not.toHaveProperty('endsTurn');
  });
});
