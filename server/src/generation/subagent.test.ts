/**
 * Sub-agent plumbing (docs/design/generation-runner.md §Sub-agents):
 * - run_agent runs a nested TranscriptTarget through the runner under the
 *   parent's lock tenure; the sub-agent gets the full tool loop itself.
 * - Recursion is bounded by depth in the tool execution context.
 * - Quiet generations (st.generate) feed tool results into follow-up rounds.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { TrivialBackendAdapter } from '../backends/TrivialBackendAdapter.js';
import type { Prompt } from '../backends/BackendAdapter.js';
import { ToolRegistry } from '../services/ToolRegistry.js';
import { GenerationRepository } from '../repos/GenerationRepository.js';
import { registerAgentTemplate } from '../services/templates/AgentTemplate.js';

/** Trivial backend that also records every prompt it receives. */
class RecordingBackend extends TrivialBackendAdapter {
  readonly prompts: Prompt[] = [];

  override async *stream(prompt: Prompt, signal: AbortSignal) {
    this.prompts.push(prompt);
    // `yield*` evaluates to the inner generator's RETURN value — re-return it.
    return yield* super.stream(prompt, signal);
  }
}

/** Marker tool: proves a (sub-)agent's tool actually executed. */
function registerEchoTemplate(toolRegistry: ToolRegistry): void {
  toolRegistry.registerTemplate({
    id: 'echo',
    name: 'Echo',
    source: 'builtin',
    getDefinition: () => ({
      stateKey: 'echo',
      configSchema: {},
      tools: [
        {
          name: 'echo_marker',
          description: 'Echo a value back with a marker.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
    }),
    execute: (_toolName, args) =>
      Promise.resolve({ content: `ECHO_EXECUTED:${(args as { value: string }).value}` }),
    serialize: () => '',
    deserialize: () => {},
  });
}

describe('sub-agents', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;
  let toolRegistry: ToolRegistry;

  function setup(backend: RecordingBackend, maxAgentDepth = 4) {
    toolRegistry = new ToolRegistry();
    registerEchoTemplate(toolRegistry);
    h = new TestHarness({ backendFactory: { create: async () => backend }, toolRegistry });
    return (async () => {
      await h.initSchema();
      client = h.connectClient();
      registerAgentTemplate(toolRegistry, {
        runner: h.generationRunner,
        targetDeps: {
          chats: h.deps.chats,
          generationBroadcast: h.generationBroadcast,
          assembly: h.chatPromptAssembly,
          toolRegistry,
          toolsetRepo: h.deps.toolsets,
          maxAgentDepth,
        },
        generations: new GenerationRepository(h.db),
        maxAgentDepth,
      });

      await h.deps.settings.setValue('model', 'trivial-model');
      await h.deps.settings.setValue('apiKey', 'fake-key');
      await h.deps.settings.setValue('backendProvider', 'openai');
      await h.deps.settings.setValue('maxResponseTokens', 100);
    })();
  }

  afterEach(async () => {
    await h.teardown();
  });

  async function createChatWithTools(toolNames: Array<{ templateId: string; name: string; agentVisible?: boolean }>): Promise<string> {
    await h.send(client, {
      type: 'character.create',
      data: { name: 'AgentHost', description: 'hosts agents.', firstMes: 'Ready.' },
    });
    const charId = h.expectBroadcast('character.created').character.id;
    await h.send(client, { type: 'chat.create', data: { characterId: charId, name: 'Agent Chat' } });
    const chatId = h.expectBroadcast('chat.created').chat.id;
    await h.send(client, { type: 'chat.materialize', chatId });

    for (const t of toolNames) {
      await h.send(client, {
        type: 'toolset.create',
        data: { templateId: t.templateId, name: t.name, config: {}, toolOverrides: {}, enabled: true, agentVisible: t.agentVisible ?? false },
      });
      h.expectBroadcast('toolset.created');
    }
    return chatId;
  }

  it('run_agent runs a nested generation with its own tool loop and a parent-linked record', async () => {
    const backend = new RecordingBackend([
      // Parent round 1: the model spawns a sub-agent.
      [{ type: 'tool_use', id: 'spawn_1', name: 'run_agent', input: { prompt: 'compute the thing' } }],
      // Sub-agent round 1: it calls a tool of its own (the whole point).
      [{ type: 'tool_use', id: 'echo_1', name: 'echo_marker', input: { value: 'nested' } }],
      // Sub-agent round 2: final text.
      [{ type: 'content', content: 'SUBAGENT_FINAL_TEXT' }],
      // Parent round 2: the parent answers with the sub-agent's result.
      [{ type: 'content', content: 'Parent done.' }],
    ]);
    await setup(backend);
    const chatId = await createChatWithTools([
      { templateId: 'echo', name: 'Echo', agentVisible: true },
      { templateId: 'agent', name: 'Agent', agentVisible: true },
    ]);

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'run an agent' });
    h.expectBroadcast('generation.done');

    // Four stream calls in order: parent r1, sub-agent r1, sub-agent r2, parent r2.
    expect(backend.prompts).toHaveLength(4);

    // The sub-agent's own tool loop: round-2 prompt carries the echo result.
    expect(JSON.stringify(backend.prompts[2]!.messages)).toContain('ECHO_EXECUTED:nested');
    // Sub-agent prompts are seed-assembled (no chat pipeline markers).
    expect(JSON.stringify(backend.prompts[1]!.messages)).toContain('compute the thing');

    // The sub-agent's token stream must NOT reach clients (broadcast: false).
    const tokens = client.messages.filter((m) => m.type === 'generation.token');
    expect(tokens.map((m) => m.type === 'generation.token' && 'token' in m ? (m as { token: string }).token : '').join('')).not.toContain('SUBAGENT_FINAL_TEXT');

    // Parent message: spawn tool_use + tool_result with the sub-agent's final text.
    const branch = await h.deps.chats.getActiveBranch(chatId);
    const assistant = branch.filter((m) => m.role === 'assistant').at(-1)!;
    const parts = assistant.extra.parts ?? [];
    expect(parts.some((p) => p.type === 'tool_use' && p.name === 'run_agent')).toBe(true);
    const spawnResult = parts.find((p) => p.type === 'tool_result' && p.toolUseId === 'spawn_1');
    expect(spawnResult).toBeDefined();
    expect(spawnResult!.type === 'tool_result' && String(spawnResult!.content)).toContain('SUBAGENT_FINAL_TEXT');

    // Generation records: parent (kind 'send') and sub-agent (kind 'subagent',
    // parent_id → the parent's record).
    const generations = new GenerationRepository(h.db);
    const records = await generations.listByChat(chatId);
    const parent = records.find((r) => r.kind === 'send');
    const subagent = records.find((r) => r.kind === 'subagent');
    expect(parent).toBeDefined();
    expect(subagent).toBeDefined();
    expect(subagent!.parentId).toBe(parent!.id);
  });

  it('run_agent error results carry the composed ancestry trace', async () => {
    // First stream call (parent) spawns; the second (the sub-agent's) errors.
    let calls = 0;
    const backend: import('../backends/BackendAdapter.js').BackendAdapter = {
      id: 'scripted',
      supportsStreaming: true,
      supportsTools: true,
      async *stream(): AsyncGenerator<import('../backends/BackendAdapter.js').BackendStreamItem, import('../backends/BackendAdapter.js').GenerationResult> {
        calls++;
        if (calls === 1) {
          yield { type: 'toolCall', id: 'spawn_1', name: 'run_agent', arguments: { prompt: 'go deep' } };
          return {
            finishReason: 'stop',
            usage: { promptTokens: 0, completionTokens: 0 },
            toolCalls: [{ id: 'spawn_1', name: 'run_agent', arguments: { prompt: 'go deep' } }],
          };
        }
        return { finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 }, error: 'inner exploded' };
      },
      async listModels() {
        return [];
      },
    };
    await setup(backend as RecordingBackend);
    const chatId = await createChatWithTools([{ templateId: 'agent', name: 'Agent', agentVisible: true }]);

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'spawn' });
    h.expectBroadcast('generation.done');

    const branch = await h.deps.chats.getActiveBranch(chatId);
    const assistant = branch.filter((m) => m.role === 'assistant').at(-1)!;
    const spawnResult = (assistant.extra.parts ?? []).find((p) => p.type === 'tool_result' && p.toolUseId === 'spawn_1');
    expect(spawnResult).toBeDefined();
    const content = spawnResult!.type === 'tool_result' ? String(spawnResult!.content) : '';
    // The composed trace: parent line, sub-agent line, rendered error chain.
    expect(content).toContain('Agent error:');
    expect(content).toContain('send(scripted)');
    expect(content).toContain('subagent(scripted)');
    expect(content).toContain('UNKNOWN: inner exploded');

    // The trace reference points at the sub-agent's generation record.
    const records = await new GenerationRepository(h.db).listByChat(chatId);
    const subagent = records.find((r) => r.kind === 'subagent');
    expect(subagent).toBeDefined();
    const extra = spawnResult!.type === 'tool_result' ? (spawnResult!.extra as Record<string, unknown> | undefined) : undefined;
    expect(extra?.['generationId']).toBe(subagent!.id);
  });

  it('refuses to spawn at the depth cap without running a nested generation', async () => {
    const backend = new RecordingBackend([[{ type: 'content', content: 'unused' }]]);
    await setup(backend, 4);
    const chatId = await createChatWithTools([{ templateId: 'agent', name: 'Agent' }]);

    const result = await toolRegistry.execute(
      { id: 'deep_1', name: 'run_agent', arguments: { prompt: 'too deep' } },
      { chatId, depth: 4, generationId: 'parent-gen', messages: [] },
    );

    expect(String(result.content)).toContain('maximum sub-agent depth');
    // No nested generation ran: no backend call, no subagent record.
    expect(backend.prompts).toHaveLength(0);
    const records = await new GenerationRepository(h.db).listByChat(chatId);
    expect(records.filter((r) => r.kind === 'subagent')).toHaveLength(0);
  });

  it('quiet generation (st.generate) feeds tool results into the follow-up round', async () => {
    const backend = new RecordingBackend([
      [{ type: 'tool_use', id: 'echo_q', name: 'echo_marker', input: { value: 'quiet' } }],
      [{ type: 'content', content: 'QUIET_FINAL_TEXT' }],
    ]);
    await setup(backend);
    const chatId = await createChatWithTools([{ templateId: 'echo', name: 'Echo' }]);

    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'chat',
        scopeId: chatId,
        label: 'quiet tools',
        script: "st.generate('call the echo tool'):await()",
        language: 'lua',
      },
    });
    const created = client.messages.filter((m) => m.type === 'quickreply.created').at(-1);
    const qrId = created && created.type === 'quickreply.created' ? created.item.id : '';

    await h.send(client, { type: 'quickreply.execute', id: qrId, chatId });

    expect(backend.prompts).toHaveLength(2);
    // Round 2 of the quiet generation must SEE the tool result — the legacy
    // quiet path dropped it (the follow-up-prompt gap).
    expect(JSON.stringify(backend.prompts[1]!.messages)).toContain('ECHO_EXECUTED:quiet');
  });

  it('sub-agents do NOT see tools from enabled-but-not-agentVisible toolsets', async () => {
    const backend = new RecordingBackend([
      [{ type: 'tool_use', id: 'spawn_1', name: 'run_agent', input: { prompt: 'look around' } }],
      [{ type: 'content', content: 'nothing to call' }],
      [{ type: 'content', content: 'Parent done.' }],
    ]);
    await setup(backend);
    // echo is enabled but NOT agent-visible; agent is agent-visible.
    const chatId = await createChatWithTools([
      { templateId: 'echo', name: 'Echo' },
      { templateId: 'agent', name: 'Agent', agentVisible: true },
    ]);

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'spawn' });
    h.expectBroadcast('generation.done');

    // The PARENT (main chat path) sees every enabled toolset's tools…
    const parentToolNames = (backend.prompts[0]!.tools ?? []).map((t) => t.function.name);
    expect(parentToolNames).toContain('echo_marker');
    expect(parentToolNames).toContain('run_agent');
    // …but the sub-agent only sees agentVisible toolsets — echo is hidden.
    const subToolNames = (backend.prompts[1]!.tools ?? []).map((t) => t.function.name);
    expect(subToolNames).toContain('run_agent');
    expect(subToolNames).not.toContain('echo_marker');
  });

  it('hides run_agent from a sub-agent at the depth cap (by owning template, not name)', async () => {
    const backend = new RecordingBackend([
      [{ type: 'tool_use', id: 'spawn_1', name: 'run_agent', input: { prompt: 'go deeper' } }],
      [{ type: 'content', content: 'bottom level' }],
      [{ type: 'content', content: 'Parent done.' }],
    ]);
    // maxAgentDepth 2: the spawned sub-agent runs at depth 1, and (1 + 1) >= 2
    // hides the spawn tool from its definitions.
    await setup(backend, 2);
    const chatId = await createChatWithTools([
      { templateId: 'echo', name: 'Echo', agentVisible: true },
      { templateId: 'agent', name: 'Agent', agentVisible: true },
    ]);

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'spawn' });
    h.expectBroadcast('generation.done');

    const subToolNames = (backend.prompts[1]!.tools ?? []).map((t) => t.function.name);
    expect(subToolNames).toContain('echo_marker');
    expect(subToolNames).not.toContain('run_agent');
  });

  it('writes the sub-agent’s tool state back onto the parent branch', async () => {
    // Minimal stateful builtin: registry drives deserialize → execute →
    // serialize, so the tool_result carries an extra._toolState snapshot.
    let stored = 'initial';
    const stateful = {
      id: 'stateful',
      name: 'Stateful',
      source: 'builtin' as const,
      getDefinition: () => ({
        stateKey: 'stateful',
        configSchema: {},
        tools: [
          {
            name: 'bump_state',
            description: 'Append +x to the stored state and return it.',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }),
      execute: () => {
        stored = `${stored}+x`;
        return Promise.resolve({ content: `state is now ${stored}` });
      },
      serialize: () => stored,
      deserialize: (raw: string) => {
        stored = raw;
      },
    };

    const backend = new RecordingBackend([
      [{ type: 'tool_use', id: 'spawn_1', name: 'run_agent', input: { prompt: 'bump it' } }],
      // Sub-agent bumps the state once.
      [{ type: 'tool_use', id: 'bump_1', name: 'bump_state', input: {} }],
      [{ type: 'content', content: 'SUBAGENT_DONE' }],
      // Parent bumps it again — it must deserialize the SUB-AGENT's snapshot.
      [{ type: 'tool_use', id: 'bump_2', name: 'bump_state', input: {} }],
      [{ type: 'content', content: 'Parent done.' }],
    ]);
    await setup(backend);
    toolRegistry.registerTemplate(stateful);
    const chatId = await createChatWithTools([
      { templateId: 'agent', name: 'Agent', agentVisible: true },
      { templateId: 'stateful', name: 'Stateful', agentVisible: true },
    ]);

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'spawn' });
    h.expectBroadcast('generation.done');

    expect(backend.prompts).toHaveLength(5);

    // The spawn tool_result on the parent branch carries the sub-agent's
    // state snapshot (newest per stateKey, 'agent' itself excluded).
    const branch = await h.deps.chats.getActiveBranch(chatId);
    const assistant = branch.filter((m) => m.role === 'assistant').at(-1)!;
    const spawnResult = (assistant.extra.parts ?? []).find(
      (p) => p.type === 'tool_result' && p.toolUseId === 'spawn_1',
    );
    expect(spawnResult).toBeDefined();
    const stateMap = spawnResult!.type === 'tool_result'
      ? (spawnResult!.extra?.['_toolState'] as Record<string, string> | undefined)
      : undefined;
    expect(stateMap?.['stateful']).toBe('initial+x');
    expect(stateMap?.['agent']).toBeUndefined();

    // The parent's own bump deserialized the sub-agent's snapshot:
    // 'initial' → (sub) 'initial+x' → (parent, inherited) 'initial+x+x'.
    const parentBump = (assistant.extra.parts ?? []).find(
      (p) => p.type === 'tool_result' && p.toolUseId === 'bump_2',
    );
    expect(parentBump).toBeDefined();
    expect(parentBump!.type === 'tool_result' && String(parentBump!.content)).toBe('state is now initial+x+x');
  });
});
