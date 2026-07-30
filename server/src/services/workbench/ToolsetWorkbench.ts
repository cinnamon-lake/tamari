/**
 * Toolset workbench provider (behind the `workbench` fs template).
 *
 * Lets the model manage toolsets — the enabled instances of tool templates
 * that actually expose tools to generation. Templates (builtin or Lua) are
 * inert until a toolset is created and enabled from them; this closes the
 * loop started by the lua-tool provider (author a template → test it → enable it).
 *
 * Timing note surfaced in tool descriptions: tools are collected at generation
 * start, so a toolset enabled mid-turn goes live on the NEXT message.
 *
 * Create/update only — no delete tool (disable via toolset_update instead).
 * All errors are returned as `content` strings, never thrown.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Toolset } from '@tamari/types';
import type { ToolContext, ToolExecuteResult, ToolTemplate, ToolTemplateDefinition } from '../ToolTemplate.js';
import type { EventBus } from '../../bus/EventBus.js';
import type { IToolsetRepository } from '../../repos/ToolsetRepository.js';

export interface ToolsetWorkbenchDeps {
  toolsets: IToolsetRepository;
  /** Minimal slice of ToolRegistry — resolves builtin AND Lua templates by id. */
  toolRegistry: { getTemplate(id: string): Promise<ToolTemplate | undefined> };
  bus: EventBus;
}

const ToolOverridesSchema = z.record(
  z.string(),
  z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    parameterDescriptions: z.record(z.string(), z.string()).optional(),
  }),
);

const ToolsetGetArgs = z.object({
  id: z.string().describe('Toolset id (a /toolsets/<id>.json path).'),
});

const ToolsetCreateArgs = z.object({
  templateId: z
    .string()
    .describe('Template id: a builtin id (e.g. "workbench") or a Lua template id (a /luatools/<id>/ path).'),
  name: z.string().optional().describe('Toolset name. Defaults to the template name.'),
  config: z.record(z.string(), z.unknown()).optional().describe('Config values matching the template\'s configSchema.'),
  toolOverrides: ToolOverridesSchema.optional().describe('Per-tool name/description/parameter-description overrides, keyed by tool name.'),
  enabled: z.boolean().optional().describe('Enabled by default; tools go live on the NEXT message after enabling.'),
});

const ToolsetUpdateArgs = z.object({
  id: z.string().describe('Toolset id (a /toolsets/<id>.json path).'),
  patch: z.object({
    name: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional().describe('Replaces the whole config object.'),
    toolOverrides: ToolOverridesSchema.optional(),
    enabled: z.boolean().optional().describe('Enable/disable. Takes effect on the NEXT message.'),
  }),
});

export class ToolsetWorkbench {

  constructor(private deps: ToolsetWorkbenchDeps) {}

  async execute(toolName: string, args: Record<string, unknown>, _context?: ToolContext): Promise<ToolExecuteResult> {
    try {
      switch (toolName) {
        case 'toolset_get':
          return await this.getToolset(args);
        case 'toolset_create':
          return await this.createToolset(args);
        case 'toolset_update':
          return await this.updateToolset(args);
        default:
          return { content: `Error: unknown tool ${toolName}` };
      }
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Tool names a toolset currently exposes (empty when the template can't load). */
  private async toolNames(templateId: string): Promise<string[]> {
    const template = await this.deps.toolRegistry.getTemplate(templateId);
    if (!template) return [];
    try {
      const def = await template.getDefinition();
      return def.tools.map((t) => t.name);
    } catch {
      return [];
    }
  }

  private async getToolset(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = ToolsetGetArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const toolset = await this.deps.toolsets.getById(parsed.data.id);
    if (!toolset) return { content: `Error: toolset "${parsed.data.id}" not found` };
    const template = await this.deps.toolRegistry.getTemplate(toolset.templateId);
    let definition: ToolTemplateDefinition | null = null;
    if (template) {
      try {
        definition = await template.getDefinition();
      } catch {
        definition = null;
      }
    }
    return { content: JSON.stringify({ ...toolset, definition }) };
  }

  /** Same broadcasts as the dispatcher's toolset.* handlers. */
  private async broadcastChange(kind: 'created' | 'updated', toolset: Toolset): Promise<void> {
    this.deps.bus.broadcast({ type: `toolset.${kind}`, toolset });
    const list = await this.deps.toolsets.list();
    this.deps.bus.broadcast({ type: 'toolset.listed', toolsets: list });
  }

  private async createToolset(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = ToolsetCreateArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const { templateId, config, toolOverrides, enabled } = parsed.data;

    const template = await this.deps.toolRegistry.getTemplate(templateId);
    if (!template) {
      return { content: `Error: template "${templateId}" not found (use a builtin id or a Lua template id)` };
    }
    // Surface load errors (e.g. broken Lua) instead of enabling a dead toolset.
    let def: ToolTemplateDefinition;
    try {
      def = await template.getDefinition();
    } catch (err) {
      return { content: `Error: template failed to load: ${err instanceof Error ? err.message : String(err)}` };
    }

    const toolset = await this.deps.toolsets.create(randomUUID(), {
      templateId,
      name: parsed.data.name ?? template.name,
      config: config ?? {},
      toolOverrides: (toolOverrides ?? {}),
      enabled: enabled ?? true,
      agentVisible: false,
    });
    await this.broadcastChange('created', toolset);
    return {
      content: JSON.stringify({
        ...toolset,
        tools: def.tools.map((t) => t.name),
        note: (enabled ?? true) ? 'Tools go live on the next message.' : 'Toolset created disabled.',
      }),
    };
  }

  private async updateToolset(args: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = ToolsetUpdateArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid arguments' };
    const { id, patch } = parsed.data;

    const existing = await this.deps.toolsets.getById(id);
    if (!existing) return { content: `Error: toolset "${id}" not found` };

    const toolset = await this.deps.toolsets.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.config !== undefined ? { config: patch.config } : {}),
      ...(patch.toolOverrides !== undefined ? { toolOverrides: patch.toolOverrides } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    await this.broadcastChange('updated', toolset);
    return { content: JSON.stringify({ ...toolset, tools: await this.toolNames(toolset.templateId) }) };
  }
}
