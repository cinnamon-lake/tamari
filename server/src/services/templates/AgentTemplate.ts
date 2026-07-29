import { z } from 'zod';
import type { ToolRegistry } from '../ToolRegistry.js';
import type { ToolContext, ToolExecuteResult, ToolTemplate } from '../ToolTemplate.js';
import type { ISettingsRepository } from '../../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../../repos/BackendConfigRepository.js';
import type { BackendAdapterFactory } from '../../backends/factory.js';
import { buildBackendSettings } from '../../backends/buildBackendSettings.js';
import type { Prompt, GenerationResult } from '../../backends/BackendAdapter.js';
import { getLogger } from '../../lib/logger.js';
import { str } from '../../lib/coerce.js';

const logger = getLogger('agent-tool');

/** Args for `run_agent`. Single source of truth for the LLM schema and runtime validation. */
const AgentArgs = z.object({
  prompt: z.string().describe('The task or question to give the agent. Be specific.'),
});

export interface AgentTemplateDeps {
  settings: ISettingsRepository;
  backendConfigs: IBackendConfigRepository;
  backendFactory: BackendAdapterFactory;
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
          description: 'Delegate a task to an autonomous agent that runs a separate LLM call. Useful for complex reasoning, research, drafting, or calculations without polluting the main chat history.',
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

    const allSettings = await this.deps.settings.list();
    const toolConfig = context?.config ?? {};
    const backendConfigId = str(toolConfig['backendConfigId']);
    const activeBackendConfigId = String(allSettings['activeBackendConfigId']);
    const configId = backendConfigId || activeBackendConfigId;
    const backendConfig = configId ? await this.deps.backendConfigs.getById(configId) : null;

    const backendSettings = buildBackendSettings(allSettings, backendConfig);

    logger.debug({ backendProvider: backendSettings['backendProvider'], model: backendSettings['model'] }, 'AgentTemplate: creating backend');

    const backend = await this.deps.backendFactory.create(backendSettings);
    if (!backend) {
      logger.warn({ backendSettingsKeys: Object.keys(backendSettings) }, 'AgentTemplate: backend factory returned null');
      return { content: 'Error: no backend configured. Set API key and model in settings.' };
    }

    const systemPrompt =
      str(context?.config?.systemPrompt).trim() ||
      'You are a helpful, concise assistant. Complete the task accurately and return only the result.';
    const maxTokens = Math.max(1, Math.min(4096, backendConfig?.maxTokens ?? 512));

    const prompt: Prompt = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      tokenUsage: { prompt: 0, completion: maxTokens },
      params: {
        max_tokens: maxTokens,
        temperature: 0.7,
      },
    };

    logger.info({ prompt: userPrompt.slice(0, 200), maxTokens, messageCount: prompt.messages.length }, 'AgentTemplate: streaming agent task');

    const agentBackend = backend;

    async function runStream(p: Prompt): Promise<{ text: string; result: GenerationResult }> {
      const streamTokens: string[] = [];
      const gen = agentBackend.stream(p, new AbortController().signal);
      let next = await gen.next();
      while (!next.done) {
        const item = next.value;
        if (item.type === 'text') {
          streamTokens.push(item.token);
        }
        next = await gen.next();
      }
      const text = streamTokens.join('').trim();
      return { text, result: next.value };
    }

    try {
      const { text, result } = await runStream(prompt);
      logger.info({ finishReason: result.finishReason, textLength: text.length, hasError: !!result.error }, 'AgentTemplate: stream completed');

      if (result.error) return { content: `Agent error: ${result.error}` };

      if (!text) return { content: 'Agent returned empty response.' };
      return { content: text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'AgentTemplate: stream threw');
      return { content: `Agent execution failed: ${message}` };
    }
  }

  serialize(): string { return ''; }
  deserialize(_raw: string): void {}
}
