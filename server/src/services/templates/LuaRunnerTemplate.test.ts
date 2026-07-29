import { describe, it, expect } from 'vitest';
import { registerLuaRunnerTemplate } from './LuaRunnerTemplate.js';
import { ToolRegistry } from '../ToolRegistry.js';
import { LuaRuntime } from '../../scripting/LuaRuntime.js';
import type { ToolTemplate } from '../ToolTemplate.js';

function makeTemplate(luaRuntime: LuaRuntime = new LuaRuntime()): ToolTemplate {
  const registry = new ToolRegistry();
  registerLuaRunnerTemplate(registry, { luaRuntime });
  const template = registry.getBuiltinTemplate('lua_runner');
  if (!template) throw new Error('lua_runner template was not registered');
  return template;
}

describe('LuaRunnerTemplate', () => {
  const template = makeTemplate();

  describe('registration', () => {
    it('registers the lua_runner template as builtin', () => {
      expect(template.id).toBe('lua_runner');
      expect(template.name).toBe('Lua Runner');
      expect(template.source).toBe('builtin');
    });
  });

  describe('getDefinition', () => {
    it('exposes a single run_lua tool with a required script parameter', async () => {
      const def = await template.getDefinition();
      expect(def.stateKey).toBe('lua_runner');
      expect(def.configSchema).toEqual({});
      expect(def.tools).toHaveLength(1);
      const tool = def.tools[0]!;
      expect(tool.name).toBe('run_lua');
      expect(tool.description).toContain('Lua');
      const props = tool.parameters?.properties as Record<string, { type?: string }> | undefined;
      expect(props?.script?.type).toBe('string');
    });
  });

  describe('execute', () => {
    it('returns string results as-is', async () => {
      const result = await template.execute('run_lua', { script: 'return "hello, " .. "world"' });
      expect(result.content).toBe('hello, world');
    });

    it('stringifies numeric and boolean results', async () => {
      expect((await template.execute('run_lua', { script: 'return 6 * 7' })).content).toBe('42');
      expect((await template.execute('run_lua', { script: 'return 1 < 2' })).content).toBe('true');
    });

    it('JSON-encodes table results', async () => {
      const result = await template.execute('run_lua', { script: 'return { a = 1, b = "x" }' });
      expect(JSON.parse(result.content as string)).toEqual({ a: 1, b: 'x' });
    });

    it('returns "nil" when the script returns nothing', async () => {
      const result = await template.execute('run_lua', { script: 'local x = 1' });
      expect(result.content).toBe('nil');
    });

    it('reports Lua runtime errors', async () => {
      const result = await template.execute('run_lua', { script: 'error("boom")' });
      expect(result.content).toContain('Lua error:');
      expect(result.content).toContain('boom');
    });

    it('rejects missing, non-string, or empty script arguments', async () => {
      expect((await template.execute('run_lua', {})).content).toBe('Error: script is required');
      expect((await template.execute('run_lua', { script: 42 })).content).toBe('Error: script is required');
      expect((await template.execute('run_lua', { script: '' })).content).toBe('Error: script is required');
    });

    it('returns "nil" for results without a string representation (e.g. functions)', async () => {
      const result = await template.execute('run_lua', { script: 'return print' });
      expect(result.content).toBe('nil');
    });

    it('stringifies bigint results', async () => {
      // Real Lua states only produce numbers/strings/tables; exercise the bigint branch via a stub runtime.
      const stubRuntime = {
        createState: async () => ({ lua: {}, cleanup: () => {} }),
        run: async () => ({ result: 10n }),
      } as unknown as LuaRuntime;
      const result = await makeTemplate(stubRuntime).execute('run_lua', { script: 'return 1' });
      expect(result.content).toBe('10');
    });

    it('wraps unexpected executor failures', async () => {
      const brokenRuntime = {
        createState: async () => ({ lua: {}, cleanup: () => {} }),
        run: async (): Promise<never> => {
          throw new Error('kaboom');
        },
      } as unknown as LuaRuntime;
      const result = await makeTemplate(brokenRuntime).execute('run_lua', { script: 'return 1' });
      expect(result.content).toBe('Execution error: kaboom');
    });

    it('wraps non-Error executor failures', async () => {
      const brokenRuntime = {
        createState: async () => ({ lua: {}, cleanup: () => {} }),
        run: async (): Promise<never> => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentionally throwing a non-Error
          throw 'plain failure';
        },
      } as unknown as LuaRuntime;
      const result = await makeTemplate(brokenRuntime).execute('run_lua', { script: 'return 1' });
      expect(result.content).toBe('Execution error: plain failure');
    });
  });

  describe('serialize / deserialize', () => {
    it('is stateless', () => {
      expect(template.serialize()).toBe('');
      expect(() => template.deserialize('anything')).not.toThrow();
    });
  });
});
