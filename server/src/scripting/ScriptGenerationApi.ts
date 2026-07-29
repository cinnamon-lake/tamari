/**
 * Narrow slice of GenerationService used by the scripting layer (StApi,
 * QuickReplyService).
 *
 * The scripting layer only drives generation flow (send/continue/impersonate/
 * regenerate/trigger/stop), runs quiet one-shot generations, and manages
 * per-chat prompt injections — it never touches the service's internals.
 * Typing the dependency against this interface instead of the concrete class
 * keeps the god-object surface from leaking into scripting.
 *
 * Extends the ScriptContext `Lockable` contract: the same service instance is
 * passed as ScriptContext's lockable (QuickReplyService), so the script and
 * its nested service calls share one chat-lock tenure.
 *
 * GenerationService satisfies this structurally — no `implements` clause, so
 * services/ stays free of a dependency on scripting/.
 */

import type { AttachmentRef } from '@tamari/types';
import type { Lockable } from './ScriptContext.js';

export interface ScriptGenerationApi extends Lockable {
  handleSend(chatId: string, content: string, attachmentRefs?: AttachmentRef[], lockHolder?: string): Promise<void>;
  handleContinue(chatId: string, lockHolder?: string, clientId?: string, autoContinueDepth?: number): Promise<void>;
  handleImpersonate(chatId: string, lockHolder?: string, clientId?: string): Promise<void>;
  handleRegenerate(chatId: string, messageId?: number, lockHolder?: string, clientId?: string): Promise<void>;
  handleGenerate(chatId: string, lockHolder?: string, clientId?: string, injections?: string[]): Promise<void>;
  handleStop(generationId: string): Promise<string | undefined>;
  getActiveGeneration():
    | { id: string; chatId: string; messageId: number; text: string; reasoning?: string }
    | undefined;
  quietGenerate(
    chatId: string,
    promptText: string,
    opts?: { maxTokens?: number; temperature?: number } | null,
    lockHolder?: string,
  ): Promise<{ text: string; finishReason: string } | { error: string }>;
  setPendingInjection(chatId: string, text: string): void;
  clearPendingInjections(chatId: string): void;
  handleGenRaw(chatId: string, promptText: string, clientId?: string, lockHolder?: string): Promise<void>;
  handleAsk(chatId: string, characterName: string, content: string, clientId?: string, lockHolder?: string): Promise<void>;
  handleSysGen(chatId: string, content: string, clientId?: string, lockHolder?: string): Promise<void>;
}
