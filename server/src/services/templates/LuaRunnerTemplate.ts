import { z } from 'zod';
import type { ToolRegistry } from '../ToolRegistry.js';
import type { ToolContext, ToolExecuteResult, ToolTemplate } from '../ToolTemplate.js';
import type { LuaRuntime } from '../../scripting/LuaRuntime.js';

export interface LuaRunnerTemplateDeps {
  luaRuntime: LuaRuntime;
}

export function registerLuaRunnerTemplate(registry: ToolRegistry, deps: LuaRunnerTemplateDeps): void {
  registry.registerTemplate(new LuaRunnerTemplate(deps));
}

/** Args for `run_lua`. Single source of truth for the LLM schema and runtime validation. */
const LuaRunnerArgs = z.object({
  script: z.string().describe('The Lua script to execute.'),
});

class LuaRunnerTemplate implements ToolTemplate {
  id = 'lua_runner';
  name = 'Lua Runner';
  source = 'builtin' as const;

  constructor(private deps: LuaRunnerTemplateDeps) {}

  getDefinition() {
    return {
      stateKey: 'lua_runner',
      configSchema: {},
      tools: [
        {
          name: 'run_lua',
          description: 'Execute a Lua script and return the result. Useful for calculations, string manipulation, or custom logic.',
          parameters: z.toJSONSchema(LuaRunnerArgs) as Record<string, unknown>,
        },
      ],
    };
  }

  async execute(_toolName: string, args: Record<string, unknown>, _context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = LuaRunnerArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: script is required' };
    const script = parsed.data.script;
    if (!script) return { content: 'Error: script is required' };

    const { lua, cleanup } = await this.deps.luaRuntime.createState();
    try {
      const result = await this.deps.luaRuntime.run(lua, script);
      if (result.error) return { content: `Lua error: ${result.error}` };
      const value = result.result;
      if (value === null || value === undefined) return { content: 'nil' };
      if (typeof value === 'object') return { content: JSON.stringify(value) };
      if (typeof value === 'string') return { content: value };
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return { content: `${value}` };
      }
      return { content: 'nil' };
    } catch (err) {
      return { content: `Execution error: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      // cleanup must run even when run() throws — otherwise the wasm engine leaks.
      cleanup();
    }
  }

  serialize(): string { return ''; }
  deserialize(_raw: string): void {}
}
