import { z } from 'zod';
import type { ToolRegistry } from '../ToolRegistry.js';
import type { ToolContext, ToolExecuteResult, ToolTemplate } from '../ToolTemplate.js';
import type { LuaRuntime } from '../../scripting/LuaRuntime.js';
import { installPrintCapture } from '../../scripting/LuaRuntime.js';

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
          description:
            'Execute a Lua script and return the result. Useful for calculations, string manipulation, or custom logic.',
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
      // print() goes into the tool result like a Lua repl: output first, then
      // the return value (or the error). Without the shim the wasmoon default
      // drops prints into the server log where the model never sees them.
      const prints = await installPrintCapture(lua);
      const result = await this.deps.luaRuntime.run(lua, script);
      const printed = prints.lines.join('\n');
      if (result.error) {
        return { content: printed ? `${printed}\nLua error: ${result.error}` : `Lua error: ${result.error}` };
      }
      const value = result.result;
      let valueText: string | null = null;
      if (value === null || value === undefined) {
        valueText = null;
      } else if (typeof value === 'object') {
        valueText = JSON.stringify(value);
      } else if (typeof value === 'string') {
        valueText = value;
      } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        valueText = `${value}`;
      }
      if (printed) return { content: valueText !== null ? `${printed}\n${valueText}` : printed };
      return { content: valueText ?? 'nil' };
    } catch (err) {
      return { content: `Execution error: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      // cleanup must run even when run() throws — otherwise the wasm engine leaks.
      cleanup();
    }
  }

  serialize(): string {
    return '';
  }
  deserialize(_raw: string): void {}
}
