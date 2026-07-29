import type { EventBus } from '../bus/EventBus.js';
import type { Prompt } from '../backends/BackendAdapter.js';

export interface GenerationBroadcastServiceDeps {
  bus: EventBus;
}

/**
 * Centralizes all generation-lifecycle broadcasts.
 *
 * Generation events (started, token, done, error, etc.) are ephemeral
 * progress notifications. They carry no persistent DB state, so this
 * service is a thin typed wrapper around the bus rather than a
 * ground-truth re-read like ChatBroadcastService. Every broadcast goes
 * to all connected clients; each client ignores events for chats it
 * isn't rendering (see AGENTS.md §5).
 *
 * Only `generation.started` includes `chatId` in its payload — it
 * announces which chat a generation belongs to, so clients can bind
 * generationId → chatId and filter the subsequent token/done/error
 * events (which key on generationId alone) accordingly. Those methods
 * keep a `_chatId` parameter purely for a uniform calling convention.
 */
export class GenerationBroadcastService {
  constructor(private deps: GenerationBroadcastServiceDeps) {}

  broadcastGenerationStarted(
    chatId: string,
    generationId: string,
    messageId?: number,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'generation.started', generationId, chatId, messageId },
      excludeClientId,
    );
  }

  broadcastGenerationToken(
    _chatId: string,
    generationId: string,
    token: string,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'generation.token', generationId, token },
      excludeClientId,
    );
  }

  broadcastGenerationReasoningToken(
    _chatId: string,
    generationId: string,
    token: string,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'generation.reasoningToken', generationId, token },
      excludeClientId,
    );
  }

  broadcastPromptAnnounced(
    _chatId: string,
    generationId: string,
    prompt: Prompt,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'prompt.announced', generationId, prompt },
      excludeClientId,
    );
  }

  broadcastGenerationDone(
    _chatId: string,
    generationId: string,
    finishReason: string,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'generation.done', generationId, finishReason },
      excludeClientId,
    );
  }

  broadcastGenerationAborted(
    _chatId: string,
    generationId: string,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'generation.aborted', generationId },
      excludeClientId,
    );
  }

  broadcastGenerationError(
    _chatId: string,
    generationId: string,
    error: string,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'generation.error', generationId, error },
      excludeClientId,
    );
  }

  broadcastImpersonationComplete(
    _chatId: string,
    generationId: string,
    text: string,
    excludeClientId?: string,
  ): void {
    this.deps.bus.broadcast(
      { type: 'impersonation.complete', generationId, text },
      excludeClientId,
    );
  }
}
