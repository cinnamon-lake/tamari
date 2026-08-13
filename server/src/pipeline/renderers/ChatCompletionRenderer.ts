/**
 * ChatCompletionRenderer — assembles PipelineMessages for chat-completion backends.
 *
 * Takes a PromptCollection, resolves macros, counts tokens, and fits as much
 * chat history as the budget allows.
 */

import { getMessageText } from '@tamari/types';
import { str } from '../../lib/coerce.js';
import type { PipelineMessage, ContentPart, TextPart } from '../../backends/BackendAdapter.js';
import type { PromptDef } from '../PromptManager.js';
import type { RenderOptions, PromptCollection, ChatRenderResult, PromptRenderer } from './Renderer.js';
import { FRAME_RESERVE_TOKENS, MESSAGE_OVERHEAD_TOKENS, PROMPT_SEPARATOR, TokenBudget, promptBudgetTotal } from './Renderer.js';
import { getLogger } from '../../lib/logger.js';

const rendererLog = getLogger('ChatCompletionRenderer');

export class ChatCompletionRenderer implements PromptRenderer {
  render(collection: PromptCollection, opts: RenderOptions): ChatRenderResult {
    rendererLog.debug(
      { chatHistoryLength: opts.chatHistory.length, chatHistoryIds: opts.chatHistory.map((m) => m.id), chatHistoryRoles: opts.chatHistory.map((m) => m.role), maxContext: opts.maxContext, maxResponseTokens: opts.maxResponseTokens },
      'render() called',
    );
    const budget = new TokenBudget(promptBudgetTotal(opts.maxContext, opts.maxResponseTokens));

    // Reserve a tiny amount for the assistant reply priming
    budget.reserve(FRAME_RESERVE_TOKENS);

    // First pass: resolve content for marker prompts from runtime data
    const resolvedPrompts = collection.prompts.map((p) => this.resolveMarkerContent(p, collection.markers));

    // Separate absolute prompts (injected into chat history at depth)
    const absolutePrompts = resolvedPrompts.filter((p) => p.enabled && p.injectionPosition === 'absolute');
    const relativePrompts = resolvedPrompts.filter((p) => p.enabled && p.injectionPosition !== 'absolute');

    // Group absolute prompts by depth and sort by injectionOrder
    const absoluteByDepth = new Map<number, typeof absolutePrompts>();
    for (const prompt of absolutePrompts) {
      const depth = Math.max(0, prompt.injectionDepth ?? 0);
      let bucket = absoluteByDepth.get(depth);
      if (!bucket) {
        bucket = [];
        absoluteByDepth.set(depth, bucket);
      }
      bucket.push(prompt);
    }
    for (const prompts of absoluteByDepth.values()) {
      prompts.sort((a, b) => (a.injectionOrder ?? 0) - (b.injectionOrder ?? 0));
    }

    // Second pass: assemble relative prompts into the message list, split at
    // the chatHistory marker — prompts before it render before the history,
    // prompts after it render after (the marker's position is meaningful; the
    // preset editor's ordering is honored in both directions).
    const markerIndex = relativePrompts.findIndex((p) => p.identifier === 'chatHistory');
    const beforeRel = markerIndex === -1 ? relativePrompts : relativePrompts.slice(0, markerIndex);
    const afterRel = markerIndex === -1 ? [] : relativePrompts.slice(markerIndex + 1);

    const messages = this.renderRelativePrompts(beforeRel, collection, opts, budget);

    // Squash consecutive system messages
    const squashed = this.squashConsecutiveSystemMessages(messages);

    // Append-only layout: the pinned volatile block — author's note, constant
    // atDepth WI (from the stages), then absolute-position preset prompts
    // (deterministic order: depth asc, then injectionOrder) — emitted as ONE
    // synthetic system message right after the prompt-list head, so nothing
    // floats mid-history. Macros are already a pass-through in this mode.
    let volatileMessages: PipelineMessage[] = [];
    if (opts.appendOnly) {
      const blockParts: string[] = [...(opts.volatileBlock ?? [])];
      for (const depth of [...absoluteByDepth.keys()].sort((a, b) => a - b)) {
        const prompts = absoluteByDepth.get(depth);
        if (!prompts) continue;
        for (const prompt of prompts) {
          const resolvedContent = opts.macroResolver.resolve(prompt.content, opts.macroCtx);
          if (resolvedContent.trim()) blockParts.push(resolvedContent);
        }
      }
      if (blockParts.length > 0) {
        const content = blockParts.join(PROMPT_SEPARATOR);
        // The volatile block always renders — only chat history is budget-gated.
        budget.spend(opts.tokenCounter.count(content) + MESSAGE_OVERHEAD_TOKENS);
        volatileMessages = [{ role: 'system', content }];
      }
    }

    // Identify the latest assistant message (the streaming target) so we can
    // preserve its reasoning / tool blocks even when stripping them from older
    // messages.  The target is always the last assistant in the branch — for a
    // fresh generation it's the empty placeholder, for continue/regenerate it's
    // the existing message being extended.
    let latestAssistantId: string | number | null = null;
    for (let i = opts.chatHistory.length - 1; i >= 0; i--) {
      const m = opts.chatHistory[i];
      if (m?.role === 'assistant') {
        latestAssistantId = m.id;
        break;
      }
    }

    // Add chat history within remaining budget
    // We iterate newest-first so we can stop when budget runs out
    const history = [...opts.chatHistory];
    // The trailing empty assistant message (stream target) is NOT stripped here.
    // Stripping it is the backend adapter's responsibility.
    history.reverse();
    const historyMessages: PipelineMessage[] = [];
    let messagesProcessed = 0;

    for (const msg of history) {
      // Inject any absolute prompts that belong at this depth (suppressed in
      // append-only mode — they hoist into the volatile block instead).
      if (!opts.appendOnly) {
        const depthPrompts = absoluteByDepth.get(messagesProcessed);
        if (depthPrompts) {
          // Iterate in reverse injectionOrder so unshift preserves ascending order
          for (let i = depthPrompts.length - 1; i >= 0; i--) {
            const prompt = depthPrompts[i];
            if (!prompt) continue;
            const resolvedContent = opts.macroResolver.resolve(prompt.content, opts.macroCtx);
            if (!resolvedContent.trim()) continue;
            // Depth-injected prompts always render — only history is budget-gated.
            budget.spend(opts.tokenCounter.count(resolvedContent) + MESSAGE_OVERHEAD_TOKENS);
            historyMessages.unshift({
              role: prompt.role,
              content: resolvedContent,
            });
          }
        }
      }

      const messageText = getMessageText(msg.extra.parts);
      const resolvedText = opts.macroResolver.resolve(messageText, opts.macroCtx);
      // Approximate per-message cost: content + framing overhead
      const tokens = opts.tokenCounter.count(resolvedText) + MESSAGE_OVERHEAD_TOKENS;
      if (!budget.canAfford(tokens)) break;
      budget.spend(tokens);

      // Build content: plain string or ContentPart[] when attachments / parts are present
      let content: string | ContentPart[] = resolvedText;

      if (msg.role === 'assistant' && msg.extra.parts && msg.extra.parts.length > 0) {
        let parts = msg.extra.parts;
        // Strip reasoning / tool blocks from old assistant messages when the
        // user opts to keep the context lean. The latest assistant message
        // (the streaming target) always keeps its blocks so the model can
        // continue coherently.
        if (!opts.reasoningAddToPrompts && msg.id !== latestAssistantId) {
          const stripped = parts.filter(
            (p) => p.type !== 'reasoning' && p.type !== 'tool_use' && p.type !== 'tool_result',
          );
          // Only keep the very last block if it's text; anything else is
          // effectively request corruption for a stripped old message.
          const lastStripped = stripped[stripped.length - 1];
          if (lastStripped?.type === 'text') {
            parts = [lastStripped];
          } else {
            parts = [];
          }
        }
        // Resolve macros in the remaining text part(s)
        parts = parts.map((p) =>
          p.type === 'text' ? { ...p, text: opts.macroResolver.resolve((p).text, opts.macroCtx) } : p,
        );
        // Collapse to string when only a single text part remains
        const singlePart = parts.length === 1 ? parts[0] : undefined;
        if (singlePart?.type === 'text') {
          content = singlePart.text;
        } else if (parts.length > 1 || singlePart !== undefined) {
          content = parts;
        }
        // else: parts became empty → fall back to resolvedText
      } else if (msg.role === 'assistant' && msg.extra.toolCalls) {
        const parts: ContentPart[] = [];
        const tc = msg.extra.toolCalls;
        const stripBlocks = !opts.reasoningAddToPrompts && msg.id !== latestAssistantId;
        for (const call of tc) {
          // Skip legacy tool calls for old assistants when stripping
          if (stripBlocks) continue;
          parts.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments,
          });
        }
        if (resolvedText) {
          parts.push({ type: 'text', text: resolvedText });
        }
        // Only use ContentPart[] when there are non-text parts (tool calls)
        const singlePart = parts.length === 1 ? parts[0] : undefined;
        if (parts.length > 1 || (singlePart !== undefined && singlePart.type !== 'text')) {
          content = parts;
        }
      } else {
        const attachments = extractAttachments(msg.extra.attachments);
        const parts: ContentPart[] = [{ type: 'text', text: resolvedText }];
        if (attachments.length > 0) {
          for (const att of attachments) {
            const source = att.dataUrl ? str(att.dataUrl) : `/api/attachments/${att.id}`;
            if (att.mimeType.startsWith('image/')) {
              if (opts.supportsImages !== false) {
                parts.push({ type: 'image', source, mimeType: att.mimeType, detail: 'auto' });
              } else if (opts.mediaVerboseMode) {
                parts.push({ type: 'text', text: '[Attached image]' });
              }
            } else if (att.mimeType.startsWith('audio/')) {
              if (opts.supportsAudio !== false) {
                parts.push({ type: 'audio', source, mimeType: att.mimeType });
              } else if (opts.mediaVerboseMode) {
                parts.push({ type: 'text', text: '[Attached audio]' });
              }
            } else if (att.mimeType.startsWith('video/')) {
              if (opts.supportsVideo !== false) {
                parts.push({ type: 'video', source, mimeType: att.mimeType });
              } else if (opts.mediaVerboseMode) {
                parts.push({ type: 'text', text: '[Attached video]' });
              }
            }
          }
        }
        // For tool messages, preserve tool_call_id via tool_result parts
        if (msg.role === 'tool' && msg.extra.toolCallId) {
          parts.push({
            type: 'tool_result',
            toolUseId: str(msg.extra.toolCallId),
            name: msg.extra.toolName ? str(msg.extra.toolName) : undefined,
            content: resolvedText,
            isError: Boolean(msg.extra.isError),
          });
        }
        if (parts.length > 1) {
          content = parts;
        }
      }

      historyMessages.unshift({
        role: msg.role,
        content,
      });

      messagesProcessed++;
    }

    // Inject any remaining absolute prompts whose depth exceeds history length
    // (suppressed in append-only mode — they hoist into the volatile block).
    if (!opts.appendOnly) {
      for (const [depth, prompts] of absoluteByDepth) {
        if (depth >= messagesProcessed) {
          for (let i = prompts.length - 1; i >= 0; i--) {
            const prompt = prompts[i];
            if (!prompt) continue;
            const resolvedContent = opts.macroResolver.resolve(prompt.content, opts.macroCtx);
            if (!resolvedContent.trim()) continue;
            // Depth-injected prompts always render — only history is budget-gated.
            budget.spend(opts.tokenCounter.count(resolvedContent) + MESSAGE_OVERHEAD_TOKENS);
            historyMessages.unshift({
              role: prompt.role,
              content: resolvedContent,
            });
          }
        }
      }
    }

    // Prompts ordered after the chatHistory marker render after the history
    // (squash stays group-local — groups straddling history never merge).
    const afterMessages = this.renderRelativePrompts(afterRel, collection, opts, budget);
    const squashedAfter = this.squashConsecutiveSystemMessages(afterMessages);

    const finalMessages = [...squashed, ...volatileMessages, ...historyMessages, ...squashedAfter];

    // Accurate token count using the message-aware counter
    const promptTokens = opts.tokenCounter.countMessages(
      finalMessages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content
                .filter((p): p is TextPart => p.type === 'text')
                .map((p) => p.text)
                .join(''),
      })),
    );

    rendererLog.debug(
      { outputMessageCount: finalMessages.length, outputRoles: finalMessages.map((m) => m.role), outputHasParts: finalMessages.map((m) => Array.isArray(m.content)) },
      'render() returning',
    );
    return {
      type: 'chat',
      messages: finalMessages,
      tokenUsage: { prompt: promptTokens, completion: opts.maxResponseTokens },
    };
  }

  private resolveMarkerContent(prompt: PromptDef, markers: Record<string, string>): PromptDef {
    if (!prompt.marker) return prompt;

    const content = markers[prompt.identifier] ?? prompt.content;
    return { ...prompt, content };
  }

  /** Render relative-position prompts in order (dialogueExamples expand into
      their parsed example messages; empty markers are skipped). These prompts
      are never budget-gated — the budget only decides how much chat history
      fits; their cost is still charged so the history cut accounts for them. */
  private renderRelativePrompts(
    prompts: PromptDef[],
    collection: PromptCollection,
    opts: RenderOptions,
    budget: TokenBudget,
  ): PipelineMessage[] {
    const messages: PipelineMessage[] = [];
    for (const prompt of prompts) {
      // Special handling for dialogueExamples: insert parsed example messages
      if (prompt.identifier === 'dialogueExamples' && collection.dialogueExamples?.length) {
        for (const ex of collection.dialogueExamples) {
          const resolvedContent = opts.macroResolver.resolve(ex.content, opts.macroCtx);
          if (!resolvedContent.trim()) continue;

          // Charge the cost against the history budget (framing overhead included)
          budget.spend(opts.tokenCounter.count(resolvedContent) + MESSAGE_OVERHEAD_TOKENS);

          messages.push({
            role: ex.role,
            content: resolvedContent,
          });
        }
        continue;
      }

      if (prompt.marker && !prompt.content.trim()) continue; // skip empty markers

      const resolvedContent = opts.macroResolver.resolve(prompt.content, opts.macroCtx);
      if (!resolvedContent.trim()) continue;

      // Charge the cost against the history budget (framing overhead included)
      budget.spend(opts.tokenCounter.count(resolvedContent) + MESSAGE_OVERHEAD_TOKENS);

      messages.push({
        role: prompt.role,
        content: resolvedContent,
      });
    }
    return messages;
  }

  private squashConsecutiveSystemMessages(messages: PipelineMessage[]): PipelineMessage[] {
    const result: PipelineMessage[] = [];
    let last: PipelineMessage | null = null;

    for (const msg of messages) {
      if (
        msg.role === 'system' &&
        last &&
        last.role === 'system' &&
        typeof last.content === 'string' &&
        typeof msg.content === 'string'
      ) {
        last.content += PROMPT_SEPARATOR + msg.content;
      } else {
        if (last) result.push(last);
        last = msg;
      }
    }

    if (last) result.push(last);
    return result;
  }
}

interface AttachmentExtra {
  id: string;
  mimeType: string;
  dataUrl?: unknown;
}

function extractAttachments(raw: unknown): AttachmentExtra[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentExtra[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const id = obj.id;
    // Attachments are camelCase (AttachmentRef); mime_type tolerated for
    // legacy/imported payloads.
    const mimeType = obj.mimeType ?? obj.mime_type;
    if (typeof id === 'string' && typeof mimeType === 'string') {
      out.push({ id, mimeType, dataUrl: obj.dataUrl });
    }
  }
  return out;
}
