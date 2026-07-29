/**
 * Lua tool workbench provider (behind the `workbench` fs template).
 *
 * Lets the model create, edit, and TEST Lua tool templates — the same
 * edit→test→iterate loop as the backend workbench provider. `luatool_create`/`luatool_update`
 * validate the code by actually loading it (getDefinition must succeed) before
 * saving; `luatool_test` runs a tool from a stored template or from raw,
 * unsaved code so the model can iterate without dirtying the library.
 *
 * Create/update only — no delete tool (consistent with the other workbenches).
 * All errors are returned as `content` strings, never thrown.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LuaSandboxFlagsSchema } from '@tamari/types';
import type { ToolTemplate as StoredToolTemplate } from '@tamari/types';
import type { ToolContext, ToolExecuteResult } from '../ToolTemplate.js';
import type { EventBus } from '../../bus/EventBus.js';
import type { IToolTemplateRepository } from '../../repos/ToolTemplateRepository.js';
import type { LuaToolExecutor } from '../LuaToolExecutor.js';

export interface LuaToolWorkbenchDeps {
  toolTemplates: IToolTemplateRepository;
  luaExecutor: LuaToolExecutor;
  registry: { invalidateLuaCache(): void };
  bus: EventBus;
}

const LuaToolGetArgs = z.object({
  id: z.string().describe('Lua tool template id (a /luatools/<id>/ path).'),
});

const LuaToolCreateArgs = z.object({
  name: z.string().min(1).describe('Template name.'),
  code: z.string().min(1).describe('Lua source. Must assign a global `Tool` table with getDefinition() and execute(args, context, toolName).'),
  sandbox: LuaSandboxFlagsSchema.optional().describe('Sandbox flags for this template (allowIo/allowOs/allowDebug/allowRequire). Fully sandboxed when omitted.'),
  configSchema: z.record(z.string(), z.unknown()).optional(),
});

const LuaToolUpdateArgs = z.object({
  id: z.string().describe('Lua tool template id (a /luatools/<id>/ path).'),
  patch: z.object({
    name: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    sandbox: LuaSandboxFlagsSchema.optional(),
    configSchema: z.record(z.string(), z.unknown()).optional(),
  }),
});

const LuaToolTestArgs = z
  .object({
    id: z.string().optional().describe('Stored template id — test its saved code.'),
    code: z.string().optional().describe('Raw, unsaved Lua code to test instead of a stored template.'),
    sandbox: LuaSandboxFlagsSchema.optional().describe('Sandbox flags for raw-code tests (ignored when id is given — the stored flags apply).'),
    toolName: z.string().describe('Name of the tool to invoke, as defined by the template\'s getDefinition().'),
    args: z.record(z.string(), z.unknown()).optional().describe('Tool arguments.'),
    config: z.record(z.string(), z.unknown()).optional().describe('Toolset config exposed to the tool as context.config.'),
  })
  .refine((v) => (v.id !== undefined) !== (v.code !== undefined), {
    message: 'Provide exactly one of id or code',
  });

export class LuaToolWorkbench {

  constructor(private deps: LuaToolWorkbenchDeps) {}

  async execute(toolName: string, args: Record<string, unknown>, _context?: ToolContext): Promise<ToolExecuteResult> {
    try {
      switch (toolName) {
        case 'luatool_get':
          return await this.getTemplate(args);
        case 'luatool_create':
          return await this.createTemplate(args);
        case 'luatool_update':
          return await this.updateTemplate(args);
        case 'luatool_test':
          return await this.testTemplate(args, _context);
        default:
          return { content: `Error: unknown tool ${toolName}` };
      }
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async getTemplate(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = LuaToolGetArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const template = await this.deps.toolTemplates.getById(parsed.data.id);
    if (!template) return { content: `Error: Lua tool template "${parsed.data.id}" not found` };
    return { content: JSON.stringify(template) };
  }

  /** Same broadcasts + cache invalidation as the dispatcher's toolTemplate.* handlers. */
  private async broadcastChange(kind: 'created' | 'updated', template: StoredToolTemplate): Promise<void> {
    this.deps.bus.broadcast({ type: `toolTemplate.${kind}`, toolTemplate: template });
    const list = await this.deps.toolTemplates.list();
    this.deps.bus.broadcast({ type: 'toolTemplate.listed', toolTemplates: list });
    this.deps.registry.invalidateLuaCache();
  }

  private async createTemplate(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = LuaToolCreateArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const { name, code, sandbox, configSchema } = parsed.data;

    // Validate by loading: getDefinition must succeed before anything is saved.
    const def = await this.deps.luaExecutor.getDefinition(code, sandbox);
    if ('error' in def) return { content: `Error: template validation failed: ${def.error}` };

    const template = await this.deps.toolTemplates.create(randomUUID(), {
      name,
      code,
      sandbox: sandbox ?? {},
      configSchema: configSchema ?? {},
    });
    await this.broadcastChange('created', template);
    return { content: JSON.stringify({ id: template.id, name: template.name, definition: def }) };
  }

  private async updateTemplate(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = LuaToolUpdateArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const { id, patch } = parsed.data;

    const existing = await this.deps.toolTemplates.getById(id);
    if (!existing) return { content: `Error: Lua tool template "${id}" not found` };

    // Validate the EFFECTIVE code + sandbox, not just the patch.
    const effectiveCode = patch.code ?? existing.code;
    const effectiveSandbox = patch.sandbox ?? existing.sandbox ?? {};
    const def = await this.deps.luaExecutor.getDefinition(effectiveCode, effectiveSandbox);
    if ('error' in def) return { content: `Error: template validation failed: ${def.error}` };

    const template = await this.deps.toolTemplates.update(id, patch);
    await this.broadcastChange('updated', template);
    return { content: JSON.stringify({ ...template, definition: def }) };
  }

  private async testTemplate(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = LuaToolTestArgs.safeParse(args);
    if (!parsed.success) {
      return { content: 'Error: invalid arguments (provide exactly one of id or code, plus toolName)' };
    }
    const { id, toolName, config } = parsed.data;
    let { code, sandbox } = parsed.data;

    if (id !== undefined) {
      const template = await this.deps.toolTemplates.getById(id);
      if (!template) return { content: `Error: Lua tool template "${id}" not found` };
      code = template.code;
      sandbox = template.sandbox ?? {};
    }

    const result = await this.deps.luaExecutor.execute(
      code!,
      toolName,
      parsed.data.args ?? {},
      // Forward the live chat context so allowSt templates can be tested for real.
      { config: config ?? {}, chatId: context?.chatId, clientId: context?.clientId },
      sandbox,
    );
    return { content: JSON.stringify({ content: result.content, extra: result.extra ?? null }) };
  }
}
