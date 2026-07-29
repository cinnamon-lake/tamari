import type { InlineContentPart } from '../backends/BackendAdapter.js';
import type { MessageExtra } from '@tamari/types';

export interface ToolExecuteResult {
  content: string | InlineContentPart[];
  extra?: Record<string, unknown>;
}

/** A branch-history message as seen by tools (shape used by the tool state protocol). */
export interface ToolContextMessage {
  id: string;
  role: string;
  content: string;
  extra?: MessageExtra;
}

export interface ToolContext {
  chatId?: string;
  clientId?: string;
  config?: Record<string, unknown>;
  messages?: ToolContextMessage[];
}

export interface ToolTemplateToolDef {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  /**
   * When true, the generation turn ends after this tool executes successfully —
   * no follow-up generation round runs. The tool result is still persisted and
   * rendered (display is governed by the renderType contract). On error the
   * flag is ignored so the model can retry.
   */
  endsTurn?: boolean;
}

export interface ToolTemplateDefinition {
  stateKey: string;
  configSchema: Record<string, unknown>;
  tools: ToolTemplateToolDef[];
}

export interface ToolTemplate {
  id: string;
  name: string;
  source: 'builtin' | 'lua';
  getDefinition(): Promise<ToolTemplateDefinition> | ToolTemplateDefinition;
  execute(toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult>;
  serialize(): string;
  deserialize(raw: string): void;
}

/** Zod issues as a compact string, so a model-facing tool can say WHAT was wrong and the model can retry. */
export function formatZodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
}
