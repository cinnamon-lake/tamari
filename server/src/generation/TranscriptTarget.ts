/**
 * TranscriptTarget — ephemeral transcript generations: quiet (st.generate),
 * genraw, and sub-agents. No chat message is created; the outcome text is
 * read from the GenerationOutcome the runner returns.
 *
 * Two assembly policies, chosen at construction:
 * - 'chat'  (quiet): the full chat pipeline with the seed appended as a
 *   trailing synthetic user message. On follow-up rounds the accumulated
 *   transcript (text + tool_use/tool_result parts) is appended as a trailing
 *   synthetic assistant message, so the model sees its own tool results.
 * - 'seed'  (genraw/subagent): round 1 is the bare seed (genraw stays
 *   byte-identical to the legacy handleGenRaw prompt); round N appends the
 *   accumulated parts as a trailing assistant message. Sub-agents also
 *   receive tool definitions from the enabled toolsets; genraw sends none.
 *
 * `broadcast: false` (sub-agents) keeps the token stream off the client's
 * chat view; the generation record is still written by the runner.
 */

import type { Character, ContentPart } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import type { BackendStreamItem, GenerationResult, Prompt, ToolCall, ToolDefinition } from '../backends/BackendAdapter.js';
import type { GenerationBroadcastService } from '../services/GenerationBroadcastService.js';
import type { ToolRegistry, ToolResult } from '../services/ToolRegistry.js';
import type { IToolsetRepository } from '../repos/ToolsetRepository.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ChatPromptAssembly } from './ChatPromptAssembly.js';
import type { GenerationTarget, ResolvedGenerationBackend, ToolContextMessage } from './GenerationTarget.js';
import { FULL_BRANCH_MESSAGE_LIMIT } from './GenerationTarget.js';

export interface TranscriptTargetDeps {
  chats: IChatRepository;
  generationBroadcast: GenerationBroadcastService;
  assembly: ChatPromptAssembly;
  /** Tool definitions for sub-agent prompts (enabled toolsets). */
  toolRegistry?: ToolRegistry;
  toolsetRepo?: IToolsetRepository;
  /** Sub-agent recursion bound: at the last allowed depth the spawn tool is
      hidden from the sub-agent's definitions. */
  maxAgentDepth?: number;
}

export interface TranscriptTargetOptions {
  chatId: string;
  clientId?: string;
  character: Character | null;
  kind: 'quiet' | 'genraw' | 'subagent';
  seed: string;
  /** Seed-assembly only: emitted as a leading system message (sub-agents).
      Kept out of the user message so prompt-prefix selectors (and models)
      see the task text exactly as sent. */
  systemPrompt?: string;
  assembly: 'chat' | 'seed';
  maxResponseTokensOverride?: number;
  temperatureOverride?: number;
  backendOverride?: string;
  depth?: number;
  parentGenerationId?: string;
  /** Token broadcasts to clients (default true; sub-agents pass false). */
  broadcast?: boolean;
}

export class TranscriptTarget implements GenerationTarget {
  readonly persistent = false;
  readonly messageId = null;

  readonly chatId: string;
  readonly clientId?: string;
  readonly character: Character | null;
  readonly kind: 'quiet' | 'genraw' | 'subagent';
  readonly backendOverride?: string;
  readonly depth?: number;
  readonly parentGenerationId?: string;

  private seed: string;
  private systemPrompt?: string;
  private assemblyKind: 'chat' | 'seed';
  private maxResponseTokensOverride?: number;
  private temperatureOverride?: number;
  private broadcast: boolean;

  private generationId = '';
  private parts: ContentPart[] = [];

  constructor(
    private deps: TranscriptTargetDeps,
    opts: TranscriptTargetOptions,
  ) {
    this.chatId = opts.chatId;
    this.clientId = opts.clientId;
    this.character = opts.character;
    this.kind = opts.kind;
    this.backendOverride = opts.backendOverride;
    this.depth = opts.depth;
    this.parentGenerationId = opts.parentGenerationId;
    this.seed = opts.seed;
    this.systemPrompt = opts.systemPrompt;
    this.assemblyKind = opts.assembly;
    this.maxResponseTokensOverride = opts.maxResponseTokensOverride;
    this.temperatureOverride = opts.temperatureOverride;
    this.broadcast = opts.broadcast ?? true;
  }

  bindGeneration(generationId: string): void {
    this.generationId = generationId;
  }

  async prepare(): Promise<void> {
    // Ephemeral — no message to create.
  }

  async prompt(resolved: ResolvedGenerationBackend): Promise<Prompt> {
    if (this.assemblyKind === 'seed') {
      const { allSettings, backendConfig } = resolved;
      const maxResponseTokens = Math.max(1, backendConfig?.maxTokens ?? allSettings.maxResponseTokens);
      // Minimal prompt — seed + accumulated transcript, no chat
      // history/character/WI/pipeline. Round 1 (no parts yet) is the bare
      // seed message, byte-identical to the legacy genraw prompt.
      const messages: Prompt['messages'] = [];
      if (this.systemPrompt) {
        messages.push({ role: 'system', content: this.systemPrompt });
      }
      messages.push({ role: 'user', content: this.seed });
      if (this.parts.length > 0) {
        messages.push({ role: 'assistant', content: [...this.parts] });
      }
      const prompt: Prompt = {
        messages,
        tokenUsage: { prompt: 0, completion: maxResponseTokens },
        params: {},
      };
      if (this.kind === 'subagent') {
        prompt.tools = await this.loadToolDefinitions();
      }
      return prompt;
    }

    // quietGenerate's per-call temperature override rides the backendSettings
    // copy handed to assembly (the legacy code mutated the resolved bundle
    // after adapter creation, so it never reached the adapter — preserved).
    let backendSettings = resolved.backendSettings;
    if (this.temperatureOverride !== undefined && !isNaN(this.temperatureOverride) && resolved.backendConfig) {
      backendSettings = { ...backendSettings, temperature: this.temperatureOverride };
    }

    const chat = await this.deps.chats.getChatById(this.chatId);
    const trailingMessages: Array<{ role: 'system' | 'user' | 'assistant'; parts: ContentPart[] }> = [
      { role: 'user', parts: [{ type: 'text', text: this.seed }] },
    ];
    if (this.parts.length > 0) {
      trailingMessages.push({ role: 'assistant', parts: [...this.parts] });
    }
    const { prompt } = await this.deps.assembly.build({
      chatId: this.chatId,
      chat: chat ?? null,
      character: this.character,
      resolved: { ...resolved, backendSettings },
      maxResponseTokensOverride: this.maxResponseTokensOverride,
      lastGenerationType: 'quiet',
      trailingMessages,
    });
    return prompt;
  }

  /** Tool definitions for a sub-agent: enabled toolsets the user explicitly
      marked agent-visible, minus the spawn tool at the depth cap. */
  private async loadToolDefinitions(): Promise<ToolDefinition[] | undefined> {
    const { toolRegistry, toolsetRepo, maxAgentDepth } = this.deps;
    if (!toolRegistry || !toolsetRepo) return undefined;
    const toolsets = await toolsetRepo.listAgentVisible();
    if (toolsets.length === 0) return undefined;
    // Depth cap: hide the spawn tool when a nested spawn would exceed the
    // cap. Filter by owning toolset's templateId — tool overrides can rename
    // run_agent, so a name match would miss renamed tools.
    const atDepthCap = maxAgentDepth !== undefined && (this.depth ?? 0) + 1 >= maxAgentDepth;
    const definitions: ToolDefinition[] = [];
    for (const toolset of toolsets) {
      if (atDepthCap && toolset.templateId === 'agent') continue;
      definitions.push(...(await toolRegistry.getDefinitionsByToolsets([toolset])));
    }
    return definitions.length > 0 ? definitions : undefined;
  }

  read(): ContentPart[] {
    return this.parts;
  }

  pendingToolCalls(): ToolCall[] {
    const pending: ToolCall[] = [];
    for (const p of this.parts) {
      if (p.type !== 'tool_use') continue;
      const hasResult = this.parts.some((q) => q.type === 'tool_result' && q.toolUseId === p.id);
      if (!hasResult) pending.push({ id: p.id, name: p.name, arguments: p.input });
    }
    return pending;
  }

  /** Tool-execution context: the parent branch (reads inherit) followed by
      the accumulated transcript. genraw stays transcript-only. */
  async toolContextMessages(): Promise<ToolContextMessage[]> {
    const transcript: ToolContextMessage[] = [
      { id: 'seed', role: 'user', content: this.seed },
    ];
    if (this.parts.length > 0) {
      transcript.push({
        id: 'transcript',
        role: 'assistant',
        content: getMessageText(this.parts),
        extra: { parts: this.parts },
      });
    }
    if (this.kind === 'genraw') return transcript;
    const branch = await this.deps.chats.getActiveBranch(this.chatId, { limit: 100 });
    return [
      ...branch.map((m) => ({
        id: String(m.id),
        role: m.role,
        content: getMessageText(m.extra.parts),
        extra: m.extra,
      })),
      ...transcript,
    ];
  }

  /** Full-history variant: same span, but the parent branch is uncapped. */
  async fullBranchMessages(): Promise<ToolContextMessage[]> {
    const transcript: ToolContextMessage[] = [
      { id: 'seed', role: 'user', content: this.seed },
    ];
    if (this.parts.length > 0) {
      transcript.push({
        id: 'transcript',
        role: 'assistant',
        content: getMessageText(this.parts),
        extra: { parts: this.parts },
      });
    }
    if (this.kind === 'genraw') return transcript;
    const branch = await this.deps.chats.getActiveBranch(this.chatId, { limit: FULL_BRANCH_MESSAGE_LIMIT });
    return [
      ...branch.map((m) => ({
        id: String(m.id),
        role: m.role,
        content: getMessageText(m.extra.parts),
        extra: m.extra,
      })),
      ...transcript,
    ];
  }

  write(item: BackendStreamItem): void {
    if (item.type === 'text') {
      const last = this.parts[this.parts.length - 1];
      if (last && last.type === 'text') {
        last.text += item.token;
      } else {
        this.parts.push({ type: 'text', text: item.token });
      }
      if (this.broadcast) {
        this.deps.generationBroadcast.broadcastGenerationToken(this.chatId, this.generationId, item.token);
      }
    } else if (item.type === 'reasoning') {
      const last = this.parts[this.parts.length - 1];
      if (last && last.type === 'reasoning') {
        last.text += item.token;
      } else {
        this.parts.push({ type: 'reasoning', text: item.token });
      }
      if (this.broadcast) {
        this.deps.generationBroadcast.broadcastGenerationReasoningToken(this.chatId, this.generationId, item.token);
      }
    } else if (item.type === 'reasoningSignature') {
      // Accumulated by the legacy quiet path but never persisted — dropped.
    } else if (item.type === 'backendDebug') {
      // Custom-backend print output — not meaningful for a transcript.
    } else {
      // toolCall
      if (!this.parts.some((p) => p.type === 'tool_use' && p.id === item.id)) {
        this.parts.push({ type: 'tool_use', id: item.id, name: item.name, input: item.arguments });
      }
    }
  }

  async writeToolOutcome(call: ToolCall, outcome: ToolResult): Promise<void> {
    this.parts.push({
      type: 'tool_result',
      toolUseId: call.id,
      name: call.name,
      content: outcome.content,
      isError: outcome.isError,
      extra: outcome.extra,
    });
  }

  async finalize(_result: GenerationResult): Promise<void> {
    // Nothing to persist; the outcome text comes from the runner's
    // GenerationOutcome (read()).
  }

  async abort(_result: GenerationResult): Promise<void> {
    // Transcript discarded.
  }
}
