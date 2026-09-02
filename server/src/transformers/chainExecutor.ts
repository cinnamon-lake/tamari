/**
 * Chain executor — run a transformer chain's steps sequentially over the
 * rendered message array.
 *
 * Failure philosophy: a chain never aborts a generation. Disabled steps are
 * skipped silently; invalid builtin params, unknown builtin ids, missing Lua
 * sources, and Lua failures all skip the step with a trace note (surfaced on
 * `Prompt.transformerTrace` → generations.meta.transformers).
 */

import type { PipelineMessage, TransformerStep } from '@tamari/types';
import { getBuiltinTransformer } from './registry.js';
import { runLuaTransformer } from './luaRunner.js';
import type { TransformerContext } from './types.js';

export interface ChainExecutionResult {
  messages: PipelineMessage[];
  trace: string[];
}

export async function executeChain(
  messages: PipelineMessage[],
  steps: TransformerStep[],
  ctx: TransformerContext,
  luaSources?: Map<string, string>,
): Promise<ChainExecutionResult> {
  let current = messages;
  const trace: string[] = [];

  for (const step of steps) {
    if (!step.enabled) continue;

    if (step.kind === 'builtin') {
      const builtin = getBuiltinTransformer(step.id);
      if (!builtin) {
        trace.push(`builtin step '${step.id}': unknown transformer id — skipped`);
        continue;
      }
      const parsed = builtin.paramSchema.safeParse(step.params ?? {});
      if (!parsed.success) {
        trace.push(
          `builtin step '${step.id}': invalid params (${parsed.error.issues[0]?.message ?? 'invalid'}) — skipped`,
        );
        continue;
      }
      current = builtin.apply(current, step.params ?? {}, ctx);
      continue;
    }

    const source = luaSources?.get(step.scriptId);
    if (source === undefined) {
      trace.push(`lua step '${step.scriptId}': script not found — skipped`);
      continue;
    }
    const result = await runLuaTransformer(source, current, ctx);
    if (result.note) trace.push(`lua step '${step.scriptId}': ${result.note}`);
    current = result.messages;
  }

  return { messages: current, trace };
}
