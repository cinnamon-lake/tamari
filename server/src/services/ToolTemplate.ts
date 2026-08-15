import type { InlineContentPart } from '../backends/BackendAdapter.js';
import type { MessageExtra, MessageRole } from '@tamari/types';
import type { ChatLock } from '../generation/AsyncMutex.js';

export interface ToolExecuteResult {
  content: string | InlineContentPart[];
  extra?: Record<string, unknown>;
}

/** A branch-history message as seen by tools (shape used by the tool state protocol). */
export interface ToolContextMessage {
  id: string;
  role: MessageRole;
  content: string;
  extra?: MessageExtra;
}

export interface ToolContext {
  chatId?: string;
  clientId?: string;
  config?: Record<string, unknown>;
  messages?: ToolContextMessage[];
  /** The generation tenure the tool runs inside (sub-agents nest under it). */
  lock?: ChatLock;
  /** Agent nesting depth: 0 at top level, +1 per spawned sub-agent. The spawn
      tool enforces the cap; the runner only passes it through. */
  depth?: number;
  /** The generation record id of the run this tool executes in (parent
      reference for sub-agent records). */
  generationId?: string;
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
