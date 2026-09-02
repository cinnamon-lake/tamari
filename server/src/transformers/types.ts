/**
 * Shared types for the request-transformer module.
 *
 * A transformer chain runs on the final rendered `Prompt.messages`
 * (`PipelineMessage[]`) after the render stage, before any backend adapter
 * sees them. Built-in steps are typed transforms with zod-validated params;
 * Lua steps run user scripts in the sandboxed runner (luaRunner.ts).
 */

import type { z } from 'zod';
import type { BuiltinTransformerId, PipelineMessage } from '@tamari/types';

/**
 * Context handed to every step. Macros are already resolved by render time,
 * so names are final: `userName` / `charName` feed history-squash prefixes
 * and are visible to Lua scripts alongside the generation metadata.
 */
export interface TransformerContext {
  userName: string;
  charName?: string;
  generationType?: string;
  model?: string;
  backendProvider?: string;
}

export interface BuiltinTransformer {
  id: BuiltinTransformerId;
  /** One-line description for the chain editor's add-builtin picker. */
  description: string;
  /**
   * Zod schema for the step's `params`. The chain executor validates params
   * before calling `apply`; invalid params skip the step with a trace note
   * (never an abort). `apply` receives the raw params as `unknown` and
   * re-parses through the same schema — single source of truth, no casts.
   */
  paramSchema: z.ZodTypeAny;
  apply(messages: PipelineMessage[], params: unknown, ctx: TransformerContext): PipelineMessage[];
}
