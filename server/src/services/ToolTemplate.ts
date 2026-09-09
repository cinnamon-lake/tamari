import type { InlineContentPart } from '../backends/BackendAdapter.js';
import type { MessageExtra, MessageRole, ToolParameters } from '@tamari/types';
import type { ChatLock } from '../generation/AsyncMutex.js';

// Re-exported so template authors can import it alongside ToolTemplateDefinition.
export type { ToolParameters };

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
  /** Debug-output sink for tool internals (captured Lua print() lines, request
      script output). The generation runner wires it to backend_debug parts on
      the target; surfaces without a target leave it unset and callers fall
      back to the debug log. */
  onDebug?: (text: string) => void;
}

export interface ToolTemplateToolDef {
  name: string;
  description: string;
  parameters?: ToolParameters;
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
  /**
   * Tool/config-schema definition. `config` is the owning toolset's config when
   * the definition is resolved for a concrete toolset (model-facing tool list,
   * execution); it is omitted for config-less UI previews. Templates may use it
   * to hide tools that don't apply to the configured options.
   */
  getDefinition(config?: Record<string, unknown>): Promise<ToolTemplateDefinition> | ToolTemplateDefinition;
  execute(toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult>;
  serialize(): string;
  deserialize(raw: string): void;
}

/** Zod issues as a compact string, so a model-facing tool can say WHAT was wrong and the model can retry. */
export function formatZodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
}
