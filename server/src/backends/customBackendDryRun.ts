/**
 * Dry-run a custom/contextual backend script without a live generation.
 *
 * Runs the script's `generate(prompt, ctx)` exactly like a real turn, except
 * delegation goes to a RECORDING delegate: every `backends.generate()` call is
 * logged and answered with canned text, and `__passthrough` is refused (a
 * dry-run has no real backend to stream from). Used by the workbench
 * `run test_backend_logic` verb so an author (human or LLM) can verify
 * parsing, state updates, and delegation behavior before enabling a script.
 */

import { LuaBackendAdapter, type CustomBackendDelegate, type DelegatedGenerateResult } from './LuaBackendAdapter.js';
import { consumeStream, type BackendStreamItem, type Prompt } from './BackendAdapter.js';
import type { LuaRuntime } from '../scripting/LuaRuntime.js';

export interface DryRunCharacterContext {
  id?: string;
  name?: string;
  description?: string;
  firstMes?: string;
}

export interface DryRunOptions {
  luaSource: string;
  /** Sample user message fed to the script as the last prompt message. */
  input: string;
  /** Canned script-state snapshot (raw string, same format as _toolState values). */
  state?: string;
  /** Canned text returned by every delegated backends.generate() call. */
  delegateResponse?: string;
  /** Character context woven into the sample prompt (description → system, firstMes → assistant). */
  character?: DryRunCharacterContext;
  /** Card VFS module map visible to the script's `require` (matches generation). */
  files?: Record<string, string>;
}

export interface DryRunDelegation {
  configId: string | null;
  promptPreview: string;
  response: string;
}

export interface DryRunOutcome {
  ok: boolean;
  /** Text the script produced (joined text stream items). */
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: { promptTokens: number; completionTokens: number };
  /** Captured script-state snapshot — what a real turn would persist to _toolState. */
  stateOut?: string;
  /** Every delegated backends.generate() call, in order. */
  delegations: DryRunDelegation[];
  error?: string;
}

const PREVIEW_LIMIT = 4000;

function promptPreview(prompt: Prompt): string {
  const raw = prompt.messages
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');
  return raw.length > PREVIEW_LIMIT ? raw.slice(0, PREVIEW_LIMIT) + '…[truncated]' : raw;
}

export async function dryRunBackendScript(runtime: LuaRuntime, opts: DryRunOptions): Promise<DryRunOutcome> {
  const delegations: DryRunDelegation[] = [];
  const cannedResponse = opts.delegateResponse ?? '[dry-run delegate response]';

  const delegate: CustomBackendDelegate = {
    generate: async (configId, prompt): Promise<DelegatedGenerateResult> => {
      delegations.push({ configId, promptPreview: promptPreview(prompt), response: cannedResponse });
      return { text: cannedResponse, finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } };
    },
    resolveAdapter: async () => {
      throw new Error('passthrough (__passthrough) is not supported in a dry-run — there is no real backend to stream from');
    },
  };

  const adapter = new LuaBackendAdapter({
    id: 'dry-run',
    name: 'dry-run',
    luaSource: opts.luaSource,
    vfsFiles: opts.files,
    runtime,
    delegate,
  });

  const messages: Prompt['messages'] = [];
  if (opts.character?.description) messages.push({ role: 'system', content: opts.character.description });
  if (opts.character?.firstMes) messages.push({ role: 'assistant', content: opts.character.firstMes });
  messages.push({ role: 'user', content: opts.input });
  const prompt: Prompt = { messages, tokenUsage: { prompt: 0, completion: 0 } };

  const { items, result } = await consumeStream(
    adapter.stream(prompt, new AbortController().signal, {
      characterId: opts.character?.id,
      generationType: 'normal',
      scriptState: opts.state,
    }),
  );

  const text = items
    .filter((i): i is Extract<BackendStreamItem, { type: 'text' }> => i.type === 'text')
    .map((i) => i.token)
    .join('');

  const outcome: DryRunOutcome = {
    ok: result.finishReason !== 'error',
    usage: result.usage,
    delegations,
  };
  if (text.length > 0) outcome.text = text;
  if (result.reasoningText) outcome.reasoning = result.reasoningText;
  if (result.toolCalls && result.toolCalls.length > 0) outcome.toolCalls = result.toolCalls;
  if (result.scriptState !== undefined) outcome.stateOut = result.scriptState;
  if (result.error) outcome.error = result.error;
  return outcome;
}
