/**
 * Trace rendering for debug traces (docs/design/debug-traces.md).
 *
 * Each generation node stores only its OWN layer + structured error (in
 * `generations.meta`); the full ancestry is composed by walking `parent_id`
 * links at render time — a sub-agent's record is created while its parent is
 * mid-run, so accumulating chains in records would capture incomplete state.
 */

import type { TraceError } from '../backends/BackendAdapter.js';
import type { Generation } from '@tamari/types';

/** Render a TraceError chain: "outer → inner → innermost: CODE: message". */
export function renderTraceError(err: TraceError): string {
  const layers: string[] = [];
  let node: TraceError | undefined = err;
  let innermost: TraceError = err;
  while (node) {
    layers.push(node.layer);
    innermost = node;
    node = node.cause;
  }
  return `${layers.join(' → ')}: ${innermost.code}: ${innermost.message}`;
}

/** One line per node, outermost parent first, the failing node's chain rendered. */
export interface ComposedTrace {
  /** Per-node lines, root first: "send(openai) — 2 rounds, ok" */
  lines: string[];
  /** The rendered error chain of the failing node, if any. */
  error?: string;
}

/**
 * Compose the ancestry trace for a generation record by walking parent_id
 * links (root first). `getById` is the repo lookup, injectable for tests.
 */
export async function composeGenerationTrace(
  record: Generation,
  getById: (id: string) => Promise<Generation | undefined>,
): Promise<ComposedTrace> {
  const chain: Generation[] = [record];
  let node = record;
  const seen = new Set<string>([record.id]);
  while (node.parentId && !seen.has(node.parentId)) {
    seen.add(node.parentId);
    const parent = await getById(node.parentId);
    if (!parent) break;
    chain.unshift(parent);
    node = parent;
  }

  const lines = chain.map((g) => {
    const meta = g.meta;
    const bits: string[] = [`${g.kind}(${g.backend})`];
    if (meta?.rounds !== undefined) bits.push(`${meta.rounds} round${meta.rounds === 1 ? '' : 's'}`);
    if (meta?.toolCalls && meta.toolCalls.length > 0) {
      bits.push(`tools: ${meta.toolCalls.map((t) => (t.isError ? `${t.name}!` : t.name)).join(', ')}`);
    }
    bits.push(g.status === 'complete' ? 'ok' : g.status);
    return bits.join(' — ');
  });

  const traceError = record.meta?.traceError;
  return { lines, error: traceError ? renderTraceError(traceError) : record.errorMessage ?? undefined };
}
