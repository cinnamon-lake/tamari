/**
 * No-op broadcast stubs for card-testing sessions.
 *
 * Sessions run the real generation path but must not emit UI broadcasts —
 * no UI is watching the synthetic chat, and ChatBroadcastService's real
 * implementation would re-read repos and re-render HTML for nothing. Both
 * stubs subclass the production services (constructor deps are never
 * touched: every public method is overridden as a no-op).
 */

import { EventBus } from '../bus/EventBus.js';
import { ChatBroadcastService } from '../services/ChatBroadcastService.js';
import { GenerationBroadcastService } from '../services/GenerationBroadcastService.js';

export class NoOpGenerationBroadcastService extends GenerationBroadcastService {
  constructor() {
    super({ bus: new EventBus() });
  }

  override broadcastGenerationStarted(): void {}
  override broadcastGenerationToken(): void {}
  override broadcastGenerationReasoningToken(): void {}
  override broadcastGenerationDebugToken(): void {}
  override broadcastPromptAnnounced(): void {}
  override broadcastGenerationDone(): void {}
  override broadcastGenerationAborted(): void {}
  override broadcastGenerationError(): void {}
  override broadcastImpersonationComplete(): void {}
}

export class NoOpChatBroadcastService extends ChatBroadcastService {
  constructor() {
    // Deps are inert — every public method below is a no-op.
    super({ bus: new EventBus() } as ConstructorParameters<typeof ChatBroadcastService>[0]);
  }

  override async broadcastSnapshot(): Promise<void> {}
  override async broadcastMessageSnapshot(): Promise<void> {}
  override async broadcastMessageAppended(): Promise<void> {}
  override async broadcastPartSnapshot(): Promise<void> {}
}
