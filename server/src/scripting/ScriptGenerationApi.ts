/**
 * Narrow slice of GenerationService used by the scripting layer (StApi,
 * QuickReplyService).
 *
 * The scripting layer only drives generation flow (send/continue/impersonate/
 * regenerate/trigger/stop) and runs quiet one-shot generations — it never
 * touches the service's internals.
 * Typing the dependency against this interface instead of the concrete class
 * keeps the god-object surface from leaking into scripting.
 *
 * Extends the ScriptContext `Lockable` contract: the same service instance is
 * passed as ScriptContext's lockable (QuickReplyService), so the script and
 * its nested service calls share one chat-lock tenure. Nested calls receive
 * the tenure as a ChatLock (from `heldLockFor`) instead of the legacy truthy
 * lockHolder string.
 *
 * GenerationService satisfies this structurally — no `implements` clause, so
 * services/ stays free of a dependency on scripting/.
 */

import type { AttachmentRef } from '@tamari/types';
import type { ChatLock } from '../generation/GenerationRunner.js';
import type { Lockable } from './ScriptContext.js';

export interface ScriptGenerationApi extends Lockable {
  /** A lock token for the tenure the calling script already holds. */
  heldLockFor(chatId: string): ChatLock;
  handleSend(chatId: string, content: string, attachmentRefs?: AttachmentRef[], lock?: ChatLock): Promise<void>;
  handleContinue(chatId: string, lock?: ChatLock, clientId?: string): Promise<void>;
  handleImpersonate(chatId: string, lock?: ChatLock, clientId?: string): Promise<void>;
  handleRegenerate(chatId: string, messageId?: number, lock?: ChatLock, clientId?: string): Promise<void>;
  handleGenerate(chatId: string, lock?: ChatLock, clientId?: string): Promise<void>;
  handleStop(generationId: string): Promise<string | undefined>;
  getActiveGeneration():
    | { id: string; chatId: string; messageId: number; text: string; reasoning?: string }
    | undefined;
  quietGenerate(
    chatId: string,
    promptText: string,
    opts?: { maxTokens?: number; temperature?: number } | null,
    lock?: ChatLock,
  ): Promise<{ text: string; finishReason: string } | { error: string }>;
  handleGenRaw(chatId: string, promptText: string, clientId?: string, lock?: ChatLock): Promise<void>;
  handleAsk(chatId: string, characterName: string, content: string, clientId?: string, lock?: ChatLock): Promise<void>;
  handleSysGen(chatId: string, content: string, clientId?: string, lock?: ChatLock): Promise<void>;
}
