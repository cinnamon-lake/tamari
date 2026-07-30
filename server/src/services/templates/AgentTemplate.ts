/**
 * AgentTemplate — the `run_agent` builtin tool: delegate a task to a
 * sub-agent and return its final text.
 *
 * The sub-agent is a TranscriptTarget (kind 'subagent', seed assembly) run
 * through the same GenerationRunner loop as everything else, nested under
 * the caller's lock tenure (docs/design/generation-runner.md §Sub-agents) —
 * so it gets the full tool loop, a generation record with a parent
 * reference, and consistent error routing. Recursion is bounded HERE, not
 * in the runner: the tool refuses to spawn once context.depth reaches
 * maxAgentDepth; the sub-agent's own tool executions receive depth + 1 via
 * the runner's context pass-through.
 */

import { z } from 'zod';
import type { ToolRegistry } from '../ToolRegistry.js';
import type { ToolContext, ToolExecuteResult, ToolTemplate } from '../ToolTemplate.js';
import type { GenerationRunner } from '../../generation/GenerationRunner.js';
import { TranscriptTarget, type TranscriptTargetDeps } from '../../generation/TranscriptTarget.js';
import { TOOL_STATE_KEY } from '../toolState.js';
import { getLogger } from '../../lib/logger.js';
import { str } from '../../lib/coerce.js';

const logger = getLogger('agent-tool');

const DEFAULT_AGENT_SYSTEM_PROMPT =
  'You are a helpful, concise assistant. Complete the task accurately and return only the result.';

/** Args for `run_agent`. Single source of truth for the LLM schema and runtime validation. */
const AgentArgs = z.object({
  prompt: z.string().describe('The task or question to give the agent. Be specific and self-contained.'),
  system: z.string().optional().describe('Override the system prompt for this call (defaults to the toolset config).'),
  backend: z.string().optional().describe('Backend config id for this call (defaults to the toolset config, then the active config).'),
});

export interface AgentTemplateDeps {
  runner: GenerationRunner;
  targetDeps: TranscriptTargetDeps;
  /** Recursion bound: spawning at or beyond this depth returns an error. */
  maxAgentDepth: number;
}

export function registerAgentTemplate(registry: ToolRegistry, deps: AgentTemplateDeps): void {
  registry.registerTemplate(new AgentTemplate(deps));
}

class AgentTemplate implements ToolTemplate {
  id = 'agent';
  name = 'Agent';
  source = 'builtin' as const;

  constructor(private deps: AgentTemplateDeps) {}

  getDefinition() {
    return {
      stateKey: 'agent',
      configSchema: {
        type: 'object',
        properties: {
          backendConfigId: {
            type: 'string',
            description: 'ID of the backend config to use for agent calls. Leave empty to use the main chat backend.',
            default: '',
          },
          systemPrompt: {
            type: 'string',
            format: 'textarea',
            description: 'System prompt for the agent. Leave empty to use the default.',
            default: '',
          },
        },
      },
      tools: [
        {
          name: 'run_agent',
          description:
            'Delegate a task to an autonomous sub-agent that runs a separate generation loop with its own tool access. Useful for complex reasoning, research, drafting, or multi-step tool work whose intermediate steps should not pollute the main chat history.',
          parameters: z.toJSONSchema(AgentArgs) as Record<string, unknown>,
        },
      ],
    };
  }

  async execute(_toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = AgentArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: prompt is required' };
    const userPrompt = parsed.data.prompt.trim();
    if (!userPrompt) return { content: 'Error: prompt is required' };

    const depth = context?.depth ?? 0;
    if (depth >= this.deps.maxAgentDepth) {
      return {
        content: `Error: maximum sub-agent depth (${this.deps.maxAgentDepth}) reached — cannot spawn another agent from this one. Complete the task directly instead.`,
      };
    }

    if (!context?.chatId) {
      return { content: 'Error: run_agent requires a chat context.' };
    }

    // Per-call args override the toolset config; both default to the
    // template's stock system prompt / the active backend config.
    const toolConfig = context.config ?? {};
    const system =
      str(parsed.data.system).trim() ||
      str(toolConfig['systemPrompt']).trim() ||
      DEFAULT_AGENT_SYSTEM_PROMPT;
    const backendOverride = str(parsed.data.backend) || str(toolConfig['backendConfigId']) || undefined;

    const target = new TranscriptTarget(this.deps.targetDeps, {
      chatId: context.chatId,
      clientId: context.clientId,
      character: null,
      kind: 'subagent',
      seed: userPrompt,
      systemPrompt: system,
      assembly: 'seed',
      depth: depth + 1,
      parentGenerationId: context.generationId,
      broadcast: false,
      backendOverride,
    });

    logger.info({ depth: depth + 1, backendOverride, prompt: userPrompt.slice(0, 200) }, 'run_agent: running sub-agent');

    try {
      // Nested run under the parent's tenure (context.lock may be undefined
      // when the parent itself was top-level — the runner acquires then).
      const outcome = await this.deps.runner.run(target, context.lock);
      if (outcome.error) {
        const message = outcome.error === 'NO_BACKEND'
          ? 'no backend configured. Set API key and model in settings.'
          : outcome.error;
        return { content: `Agent error: ${message}` };
      }

      // State write-back (delegate semantics): the newest `_toolState`
      // snapshot per stateKey from the sub-agent's transcript rides the spawn
      // tool_result, so the sub-agent's tool mutations land on the parent
      // branch exactly once — and swiping away the spawn message undoes them.
      // The 'agent' stateKey itself is never propagated (this template is
      // stateless; its serialize() returns '', so the registry leaves
      // result.extra untouched).
      const stateMap: Record<string, string> = {};
      const parts = target.read();
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i]!;
        if (part.type !== 'tool_result') continue;
        const map = part.extra?.[TOOL_STATE_KEY] as Record<string, string> | undefined;
        if (!map) continue;
        for (const [key, snapshot] of Object.entries(map)) {
          if (key !== 'agent' && !(key in stateMap)) stateMap[key] = snapshot;
        }
      }
      const extra = Object.keys(stateMap).length > 0 ? { [TOOL_STATE_KEY]: stateMap } : undefined;

      if (!outcome.text) return { content: 'Agent returned empty response.', extra };
      return { content: outcome.text, extra };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'run_agent: sub-agent run threw');
      return { content: `Agent execution failed: ${message}` };
    }
  }

  serialize(): string { return ''; }
  deserialize(_raw: string): void {}
}
