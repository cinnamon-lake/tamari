import { describe, it, expect } from 'vitest';
import { renderTraceError, composeGenerationTrace } from './trace.js';
import type { TraceError } from '../backends/BackendAdapter.js';
import type { Generation } from '@tamari/types';

function gen(partial: Partial<Generation> & { id: string }): Generation {
  return {
    chatId: 'chat-1',
    messageId: null,
    status: 'complete',
    backend: 'openai',
    promptTokens: null,
    completionTokens: null,
    errorMessage: null,
    kind: 'send',
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe('renderTraceError', () => {
  it('renders a single-layer error', () => {
    const err: TraceError = { code: 'LUA_ERROR', layer: 'custom-backend(research)', message: 'boom' };
    expect(renderTraceError(err)).toBe('custom-backend(research): LUA_ERROR: boom');
  });

  it('renders a nested chain outermost-first with the innermost code', () => {
    const err: TraceError = {
      code: 'DELEGATE_ERROR',
      layer: 'run_agent',
      message: 'delegation failed',
      cause: {
        code: 'DELEGATE_ERROR',
        layer: 'custom-backend(research)',
        message: 'delegate call failed',
        cause: { code: 'LUA_ERROR', layer: 'openai(gpt-4o)', message: '[string "lib/roll.lua"]:14: nil index' },
      },
    };
    expect(renderTraceError(err)).toBe(
      'run_agent → custom-backend(research) → openai(gpt-4o): LUA_ERROR: [string "lib/roll.lua"]:14: nil index',
    );
  });
});

describe('composeGenerationTrace', () => {
  it('walks parent links root-first and renders the failing node', async () => {
    const root = gen({ id: 'root', kind: 'send', backend: 'openai', meta: { rounds: 1 } });
    const child = gen({
      id: 'child',
      kind: 'subagent',
      backend: 'custom:research',
      parentId: 'root',
      status: 'error',
      errorMessage: 'rendered fallback',
      meta: {
        rounds: 2,
        toolCalls: [{ name: 'map_set_tile' }, { name: 'run_agent', isError: true }],
        traceError: { code: 'LUA_ERROR', layer: 'custom-backend(research)', message: 'boom' },
      },
    });
    const byId = new Map([[root.id, root], [child.id, child]]);
    const trace = await composeGenerationTrace(child, async (id) => byId.get(id));

    expect(trace.lines).toEqual([
      'send(openai) — 1 round — ok',
      'subagent(custom:research) — 2 rounds — tools: map_set_tile, run_agent! — error',
    ]);
    expect(trace.error).toBe('custom-backend(research): LUA_ERROR: boom');
  });

  it('falls back to errorMessage when no structured error exists', async () => {
    const rec = gen({ id: 'x', status: 'error', errorMessage: 'plain failure' });
    const trace = await composeGenerationTrace(rec, async () => undefined);
    expect(trace.lines).toEqual(['send(openai) — error']);
    expect(trace.error).toBe('plain failure');
  });

  it('stops at a missing parent without looping', async () => {
    const rec = gen({ id: 'y', parentId: 'ghost' });
    const trace = await composeGenerationTrace(rec, async () => undefined);
    expect(trace.lines).toEqual(['send(openai) — ok']);
  });
});
