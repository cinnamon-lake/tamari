/**
 * Request transformers — named, ordered, reusable chains of message-array
 * transforms that run on the final rendered `Prompt.messages`
 * (`PipelineMessage[]`) before any backend adapter sees them.
 *
 * A chain is a standalone entity referenced by a backend config
 * (`BackendConfig.transformerChainId`), like an instruct template — not a
 * per-config flag. Steps are either built-in transforms (typed params) or
 * user-authored Lua transformer scripts (`transformer_scripts` table).
 */

import { z } from 'zod';

export const BuiltinTransformerIdSchema = z.enum([
  'squash-system',
  'whitespace',
  'strip-reasoning',
  'history-squash',
  'ensure-thinking',
]);
export type BuiltinTransformerId = z.infer<typeof BuiltinTransformerIdSchema>;

export const TransformerStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('builtin'),
    id: BuiltinTransformerIdSchema,
    enabled: z.boolean(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal('lua'),
    scriptId: z.string(),
    enabled: z.boolean(),
  }),
]);
export type TransformerStep = z.infer<typeof TransformerStepSchema>;

export const TransformerChainSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  steps: z.array(TransformerStepSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TransformerChain = z.infer<typeof TransformerChainSchema>;
export type TransformerChainInsert = Omit<TransformerChain, 'id' | 'createdAt' | 'updatedAt'>;
export type TransformerChainUpdate = Partial<TransformerChainInsert>;

export const TransformerScriptSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  luaSource: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TransformerScript = z.infer<typeof TransformerScriptSchema>;
export type TransformerScriptInsert = Omit<TransformerScript, 'id' | 'createdAt' | 'updatedAt'>;
export type TransformerScriptUpdate = Partial<TransformerScriptInsert>;
