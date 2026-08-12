/**
 * DraftTarget — the impersonate target. Generates a user-message draft and
 * broadcasts it to the originating client; nothing is persisted to the chat.
 *
 * Replaces the legacy handleImpersonate → runQuietGeneration path. The
 * impersonation instruction rides as a trailing system seed in prompt
 * assembly (it used to be a synthetic system slot in PromptManager) — per
 * docs/design/generation-runner.md this is the one sanctioned prompt delta,
 * pinned by the impersonate golden snapshot.
 */

import type { Character, ContentPart } from '@tamari/types';
import type { BackendStreamItem, GenerationResult, Prompt, ToolCall } from '../backends/BackendAdapter.js';
import type { GenerationBroadcastService } from '../services/GenerationBroadcastService.js';
import type { ToolResult } from '../services/ToolRegistry.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ChatPromptAssembly } from './ChatPromptAssembly.js';
import type { GenerationTarget, ResolvedGenerationBackend, ToolContextMessage } from './GenerationTarget.js';

export interface DraftTargetDeps {
  chats: IChatRepository;
  generationBroadcast: GenerationBroadcastService;
  assembly: ChatPromptAssembly;
}

export class DraftTarget implements GenerationTarget {
  readonly kind = 'impersonate' as const;
  readonly persistent = false;
  readonly messageId = null;

  private generationId = '';
  private parts: ContentPart[] = [];
  private streamingText = '';

  constructor(
    private deps: DraftTargetDeps,
    readonly chatId: string,
    readonly clientId: string | undefined,
    readonly character: Character | null,
    private impersonationPrompt: string,
  ) {}

  bindGeneration(generationId: string): void {
    this.generationId = generationId;
  }

  async prepare(): Promise<void> {
    // Ephemeral — no message to create.
  }

  async prompt(resolved: ResolvedGenerationBackend): Promise<Prompt> {
    const chat = await this.deps.chats.getChatById(this.chatId);
    const { prompt } = await this.deps.assembly.build({
      chatId: this.chatId,
      chat: chat ?? null,
      character: this.character,
      resolved,
      lastGenerationType: 'impersonate',
      trailingMessages: [{ role: 'system', parts: [{ type: 'text', text: this.impersonationPrompt }] }],
    });
    return prompt;
  }

  /** Only generated content — the impersonation seed never leaves prompt(). */
  read(): ContentPart[] {
    return this.parts;
  }

  pendingToolCalls(): ToolCall[] {
    return [];
  }

  async toolContextMessages(): Promise<ToolContextMessage[]> {
    return [];
  }

  async fullBranchMessages(): Promise<ToolContextMessage[]> {
    return [];
  }

  write(item: BackendStreamItem): void {
    if (item.type === 'text') {
      this.streamingText += item.token;
      const last = this.parts[this.parts.length - 1];
      if (last && last.type === 'text') {
        last.text += item.token;
      } else {
        this.parts.push({ type: 'text', text: item.token });
      }
      this.deps.generationBroadcast.broadcastGenerationToken(this.chatId, this.generationId, item.token);
    } else if (item.type === 'reasoning') {
      const last = this.parts[this.parts.length - 1];
      if (last && last.type === 'reasoning') {
        last.text += item.token;
      } else {
        this.parts.push({ type: 'reasoning', text: item.token });
      }
      this.deps.generationBroadcast.broadcastGenerationReasoningToken(this.chatId, this.generationId, item.token);
    }
    // reasoningSignature/toolCall/backendDebug: not meaningful for a draft (matches the
    // legacy quiet path, which ignored tool calls by omission).
  }

  async writeToolOutcome(_call: ToolCall, _outcome: ToolResult): Promise<void> {
    // No tool loop for drafts in this step.
  }

  async finalize(_result: GenerationResult): Promise<void> {
    this.deps.generationBroadcast.broadcastImpersonationComplete(this.chatId, this.generationId, this.streamingText);
  }

  async abort(_result: GenerationResult): Promise<void> {
    // Draft discarded — nothing persisted, nothing to clean up.
  }
}
