/**
 * ToolRegistry — IoC registry for LLM-callable tool templates.
 *
 * Templates define arrays of tools + shared serialize/deserialize + global config.
 * Toolsets are user-created instances based on templates.
 */

import { logger } from '../lib/logger.js';
import type { IToolsetRepository } from '../repos/ToolsetRepository.js';
import type { IToolTemplateRepository } from '../repos/ToolTemplateRepository.js';
import type { LuaToolExecutor } from './LuaToolExecutor.js';
import type { LuaRuntimeOptions } from '../scripting/LuaRuntime.js';
import type { ToolContext, ToolTemplate, ToolTemplateDefinition, ToolTemplateToolDef } from './ToolTemplate.js';
import type { InlineContentPart, ToolCall } from '../backends/BackendAdapter.js';
import { findLatestStateSnapshot, TOOL_STATE_KEY } from './toolState.js';

// ToolCall's single definition site is backends/BackendAdapter.ts (it is part
// of the adapter streaming contract); re-exported here so tool consumers can
// import it alongside ToolResult.
export type { ToolCall };

export interface BackendToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolResult {
  id: string;
  name: string;
  content: string | InlineContentPart[];
  isError?: boolean;
  extra?: Record<string, unknown>;
  /**
   * True when the executed tool's definition sets `endsTurn` and the execution
   * succeeded — the generation loop should end the turn instead of running a
   * follow-up round. Always falsy on error results.
   */
  endsTurn?: boolean;
}

function applyParameterDescriptions(
  parameters: Record<string, unknown>,
  overrides: Record<string, string>,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive runtime guard
  if (!parameters || typeof parameters !== 'object') return parameters;
  const result = structuredClone(parameters);
  const props = result.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return result;
  for (const [key, desc] of Object.entries(overrides)) {
    if (props[key]) {
      props[key] = { ...props[key], description: desc };
    }
  }
  return result;
}

/**
 * Remove the JSON-Schema `$schema` dialect marker from a tool's parameters.
 * It means nothing to LLM providers, and some OpenAI-compatible backends fail
 * to generate structured tool arguments when unexpected keywords are present.
 */
function stripSchemaMarker(parameters: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!parameters || typeof parameters !== 'object') return parameters;
  if (!('$schema' in parameters)) return parameters;
  const { $schema: _dropped, ...rest } = parameters;
  return rest;
}

export class ToolRegistry {
  private builtinTemplates = new Map<string, ToolTemplate>();
  private templateRepo?: IToolTemplateRepository;
  private toolsetRepo?: IToolsetRepository;
  private luaExecutor?: LuaToolExecutor;
  private luaDefCache = new Map<string, { def: ToolTemplateDefinition; ts: number }>();
  private luaCacheTtl = 30_000;

  registerTemplate(template: ToolTemplate): void {
    this.builtinTemplates.set(template.id, template);
  }

  unregisterTemplate(id: string): void {
    this.builtinTemplates.delete(id);
  }

  setTemplateRepository(repo: IToolTemplateRepository): void {
    this.templateRepo = repo;
  }

  setToolsetRepository(repo: IToolsetRepository): void {
    this.toolsetRepo = repo;
  }

  setLuaToolExecutor(executor: LuaToolExecutor): void {
    this.luaExecutor = executor;
  }

  getBuiltinTemplate(id: string): ToolTemplate | undefined {
    return this.builtinTemplates.get(id);
  }

  getAllBuiltinTemplates(): ToolTemplate[] {
    return Array.from(this.builtinTemplates.values());
  }

  async getTemplate(id: string): Promise<ToolTemplate | undefined> {
    const builtin = this.builtinTemplates.get(id);
    if (builtin) return builtin;
    const luaTemplate = await this.templateRepo?.getById(id);
    if (!luaTemplate || !this.luaExecutor) return undefined;
    return this.wrapLuaTemplate(luaTemplate);
  }

  private wrapLuaTemplate(luaTemplate: { id: string; name: string; code: string; sandbox?: LuaRuntimeOptions }): ToolTemplate {
    const executor = this.luaExecutor!;
    return {
      id: luaTemplate.id,
      name: luaTemplate.name,
      source: 'lua',
      getDefinition: async () => {
        const cached = this.luaDefCache.get(luaTemplate.id);
        if (cached && Date.now() - cached.ts < this.luaCacheTtl) {
          return cached.def;
        }
        const result = await executor.getDefinition(luaTemplate.code, luaTemplate.sandbox);
        if ('error' in result) {
          throw new Error(result.error);
        }
        this.luaDefCache.set(luaTemplate.id, { def: result, ts: Date.now() });
        return result;
      },
      execute: (toolName, args, context) => executor.execute(luaTemplate.code, toolName, args, context, luaTemplate.sandbox),
      // Deliberate no-ops: for Lua templates the executor owns the whole
      // state protocol (deserialize → execute → serialize) inside
      // LuaToolExecutor.execute(), so the registry-level calls below must be
      // inert. The registry's own protocol only applies to builtin TS
      // templates. See services/toolState.ts for the ownership split.
      serialize: () => '',
      deserialize: () => {},
    };
  }

  invalidateLuaCache(): void {
    this.luaDefCache.clear();
  }

  async getDefinitionsByToolsets(toolsets: Array<{ templateId: string; toolOverrides: Record<string, { name?: string; description?: string; parameterDescriptions?: Record<string, string> }> }>): Promise<BackendToolDefinition[]> {
    const results: BackendToolDefinition[] = [];
    for (const ts of toolsets) {
      const template = await this.getTemplate(ts.templateId);
      if (!template) continue;
      let def: ToolTemplateDefinition;
      try {
        def = await template.getDefinition();
      } catch (err) {
        logger.warn({ err, templateId: template.id }, 'ToolRegistry: getDefinition failed');
        continue;
      }
      for (const tool of def.tools) {
        const override = ts.toolOverrides[tool.name];
        const name = override?.name || tool.name;
        const description = override?.description || tool.description;
        const parameters = stripSchemaMarker(
          override?.parameterDescriptions
            ? applyParameterDescriptions(tool.parameters ?? {}, override.parameterDescriptions)
            : tool.parameters,
        );
        results.push({
          type: 'function',
          function: { name, description, parameters },
        });
      }
    }
    return results;
  }

  async execute(call: ToolCall, context?: ToolContext): Promise<ToolResult> {
    if (!this.toolsetRepo) {
      return { id: call.id, name: call.name, content: `Tool "${call.name}" not found`, isError: true };
    }

    // Find the toolset that owns this tool name
    const allToolsets = await this.toolsetRepo.list();
    let owningToolset: typeof allToolsets[0] | undefined;
    let matchedToolDef: ToolTemplateToolDef | undefined;

    for (const ts of allToolsets) {
      if (!ts.enabled) continue;
      const template = await this.getTemplate(ts.templateId);
      if (!template) continue;
      let def: ToolTemplateDefinition;
      try {
        def = await template.getDefinition();
      } catch (err) {
        logger.warn({ err, templateId: template.id }, 'ToolRegistry: getDefinition failed');
        continue;
      }
      for (const tool of def.tools) {
        const effectiveName = ts.toolOverrides[tool.name]?.name || tool.name;
        if (effectiveName === call.name) {
          owningToolset = ts;
          matchedToolDef = tool;
          break;
        }
      }
      if (owningToolset) break;
    }

    if (!owningToolset || !matchedToolDef) {
      return { id: call.id, name: call.name, content: `Tool "${call.name}" not found`, isError: true };
    }
    const matchedToolName = matchedToolDef.name;

    const template = await this.getTemplate(owningToolset.templateId);
    if (!template) {
      return { id: call.id, name: call.name, content: `Template for "${call.name}" not found`, isError: true };
    }

    // Deserialize state from message history
    let def: ToolTemplateDefinition;
    try {
      def = await template.getDefinition();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: call.id, name: call.name, content: `Template error: ${msg}`, isError: true };
    }

    const stateKey = def.stateKey || matchedToolName;
    const stateSnapshot = findLatestStateSnapshot(stateKey, context?.messages);
    if (stateSnapshot !== undefined) {
      try {
        template.deserialize(stateSnapshot);
      } catch (err) {
        logger.warn({ err, stateSnapshot: String(stateSnapshot).slice(0, 200) }, 'ToolRegistry: deserialize failed, starting fresh');
      }
    }

    try {
      const ctx: ToolContext = {
        ...context,
        config: { ...(context?.config ?? {}), ...owningToolset.config },
      };
      const result = await template.execute(matchedToolName, call.arguments, ctx);

      // Serialize state
      let stateExtra: Record<string, unknown> | undefined;
      try {
        const serialized = template.serialize();
        if (serialized) {
          stateExtra = { [TOOL_STATE_KEY]: { [stateKey]: serialized } };
        }
      } catch (err) {
        logger.warn({ err }, 'ToolRegistry: serialize failed');
      }

      return {
        id: call.id,
        name: call.name,
        content: result.content,
        extra: stateExtra ? { ...result.extra, ...stateExtra } : result.extra,
        endsTurn: matchedToolDef.endsTurn === true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: call.id, name: call.name, content: msg, isError: true };
    }
  }
}
