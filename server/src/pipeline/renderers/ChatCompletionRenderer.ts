/**
 * ChatCompletionRenderer — assembles PipelineMessages for the backend.
 *
 * Takes a PromptCollection, resolves macros, and produces the full message
 * list. Nothing is gated on a token budget: every prompt and the whole chat
 * history render in full (history length is bounded upstream by the
 * promptHistoryLimit message-count limit). Components are NEVER squished
 * here: each preset prompt / marker entry renders as its own message with a
 * parts-array content, and backend adapters own any wire-format flattening
 * (text-completion adapters flatten with their instruct template —
 * backends/formatTextPrompt.ts).
 */

import { getMessageText } from '@tamari/types';
import { str } from '../../lib/coerce.js';
import type { PipelineMessage, ContentPart, InlineContentPart, TextPart } from '../../backends/BackendAdapter.js';
import type { PromptDef } from '../PromptManager.js';
import type { RenderOptions, PromptCollection, ChatRenderResult, PromptRenderer } from './Renderer.js';
import { getLogger } from '../../lib/logger.js';

const rendererLog = getLogger('pipeline/renderers/ChatCompletionRenderer');

export class ChatCompletionRenderer implements PromptRenderer {
  render(collection: PromptCollection, opts: RenderOptions): ChatRenderResult {
    rendererLog.debug(
      {
        chatHistoryLength: opts.chatHistory.length,
        chatHistoryIds: opts.chatHistory.map((m) => m.id),
        chatHistoryRoles: opts.chatHistory.map((m) => m.role),
        maxContext: opts.maxContext,
        maxResponseTokens: opts.maxResponseTokens,
      },
      'render() called',
    );

    // Separate absolute prompts (injected into chat history at depth)
    const absolutePrompts = collection.prompts.filter((p) => p.enabled && p.injectionPosition === 'absolute');
    const relativePrompts = collection.prompts.filter((p) => p.enabled && p.injectionPosition !== 'absolute');

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

    // No squashing: every prompt component stays its own message — wire-format
    // flattening (if any) is the backend adapter's job.
    const headMessages = this.renderRelativePrompts(beforeRel, collection, opts);

    // Append-only layout: the pinned volatile block — author's note, constant
    // atDepth WI (from the stages), then absolute-position preset prompts
    // (deterministic order: depth asc, then injectionOrder) — emitted as one
    // synthetic system message per item right after the prompt-list head, so
    // nothing floats mid-history. Macros are already a pass-through in this mode.
    let volatileMessages: PipelineMessage[] = [];
    if (opts.appendOnly) {
      const blockParts: string[] = [...(opts.volatileBlock ?? [])];
      for (const depth of [...absoluteByDepth.keys()].sort((a, b) => a - b)) {
        const prompts = absoluteByDepth.get(depth);
        if (!prompts) continue;
        for (const prompt of prompts) {
          for (const entry of this.resolvePromptEntries(prompt, collection)) {
            const resolvedContent = opts.macroResolver.resolve(entry, opts.macroCtx);
            if (resolvedContent.trim()) blockParts.push(resolvedContent);
          }
        }
      }
      volatileMessages = blockParts.map((text) => ({ role: 'system', content: [{ type: 'text', text }] }));
    }

    // Add the full chat history. We iterate newest-first (unshift) so the
    // absolute-prompt depth accounting below counts from the end of history.
    // The trailing empty assistant message (stream target) is NOT stripped here.
    // Stripping it is the backend adapter's responsibility.
    const history = [...opts.chatHistory];
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
            const entries = this.resolvePromptEntries(prompt, collection);
            for (let j = entries.length - 1; j >= 0; j--) {
              const resolvedContent = opts.macroResolver.resolve(entries[j] ?? '', opts.macroCtx);
              if (!resolvedContent.trim()) continue;
              historyMessages.unshift({
                role: prompt.role,
                content: [{ type: 'text', text: resolvedContent }],
              });
            }
          }
        }
      }

      const messageText = getMessageText(msg.extra.parts);
      const resolvedText = opts.macroResolver.resolve(messageText, opts.macroCtx);

      // Build content: always a ContentPart[] (never a bare string).
      let content: ContentPart[] = [{ type: 'text', text: resolvedText }];

      if (msg.role === 'assistant' && msg.extra.parts && msg.extra.parts.length > 0) {
        // Reasoning / tool blocks are always re-sent in full — stripping them
        // from older turns is the strip-reasoning request transformer's job
        // (opt-in via a transformer chain, post-render).
        let parts = msg.extra.parts;
        // Resolve macros in the remaining text part(s)
        parts = parts.map((p) =>
          p.type === 'text' ? { ...p, text: opts.macroResolver.resolve(p.text, opts.macroCtx) } : p,
        );
        // Drop media the backend can't consume — including media nested inside
        // tool_result content (e.g. images returned by image-gen tools).
        parts = this.filterUnsupportedMedia(parts, opts);
        if (parts.length > 0) {
          content = parts;
        }
        // else: parts became empty → fall back to the resolved text part
      } else if (msg.role === 'assistant' && msg.extra.toolCalls) {
        const parts: ContentPart[] = [];
        const tc = msg.extra.toolCalls;
        for (const call of tc) {
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
        if (parts.length > 0) {
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
        content = parts;
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
            const entries = this.resolvePromptEntries(prompt, collection);
            for (let j = entries.length - 1; j >= 0; j--) {
              const resolvedContent = opts.macroResolver.resolve(entries[j] ?? '', opts.macroCtx);
              if (!resolvedContent.trim()) continue;
              historyMessages.unshift({
                role: prompt.role,
                content: [{ type: 'text', text: resolvedContent }],
              });
            }
          }
        }
      }
    }

    // Prompts ordered after the chatHistory marker render after the history.
    const afterMessages = this.renderRelativePrompts(afterRel, collection, opts);

    const finalMessages = [...headMessages, ...volatileMessages, ...historyMessages, ...afterMessages];

    // Accurate token count using the message-aware counter
    const promptTokens = opts.tokenCounter.countMessages(
      finalMessages.map((m) => ({
        role: m.role,
        content: getMessageText(m.content),
      })),
    );

    rendererLog.debug(
      {
        outputMessageCount: finalMessages.length,
        outputRoles: finalMessages.map((m) => m.role),
        outputHasParts: finalMessages.map((m) => Array.isArray(m.content)),
      },
      'render() returning',
    );
    return {
      type: 'chat',
      messages: finalMessages,
      tokenUsage: { prompt: promptTokens, completion: opts.maxResponseTokens },
    };
  }

  /** Keep, placeholder, or drop a single media part per the backend's support. */
  private filterMediaPart<P extends ContentPart>(part: P, opts: RenderOptions): P | TextPart | null {
    switch (part.type) {
      case 'image':
        if (opts.supportsImages !== false) return part;
        return opts.mediaVerboseMode ? { type: 'text', text: '[Attached image]' } : null;
      case 'audio':
        if (opts.supportsAudio !== false) return part;
        return opts.mediaVerboseMode ? { type: 'text', text: '[Attached audio]' } : null;
      case 'video':
        if (opts.supportsVideo !== false) return part;
        return opts.mediaVerboseMode ? { type: 'text', text: '[Attached video]' } : null;
      default:
        return part;
    }
  }

  /** Drop media the active backend can't consume — top-level parts and media
      nested inside tool_result content (e.g. images returned by image-gen
      tools). Verbose mode leaves `[Attached …]` placeholders instead. */
  private filterUnsupportedMedia(parts: ContentPart[], opts: RenderOptions): ContentPart[] {
    const out: ContentPart[] = [];
    for (const part of parts) {
      if (part.type === 'tool_result' && Array.isArray(part.content)) {
        const content = part.content
          .map((c) => this.filterMediaPart(c, opts))
          .filter((c): c is InlineContentPart => c !== null);
        out.push({ ...part, content: content.length > 0 ? content : '' });
        continue;
      }
      const kept = this.filterMediaPart(part, opts);
      if (kept) out.push(kept);
    }
    return out;
  }

  /** The content entries a prompt expands into: marker prompts render from
      runtime data (one message per entry — never joined); everything else is
      a single entry. Absent marker identifiers fall back to the prompt's own
      content. */
  private resolvePromptEntries(prompt: PromptDef, collection: PromptCollection): string[] {
    if (!prompt.marker) return [prompt.content];
    return collection.markers[prompt.identifier] ?? [prompt.content];
  }

  /** Render relative-position prompts in order (dialogueExamples expand into
      their parsed example messages; empty entries are skipped). Each entry
      becomes its own message — no squashing. */
  private renderRelativePrompts(
    prompts: PromptDef[],
    collection: PromptCollection,
    opts: RenderOptions,
  ): PipelineMessage[] {
    const messages: PipelineMessage[] = [];
    for (const prompt of prompts) {
      // Special handling for dialogueExamples: insert parsed example messages
      if (prompt.identifier === 'dialogueExamples' && collection.dialogueExamples?.length) {
        for (const ex of collection.dialogueExamples) {
          const resolvedContent = opts.macroResolver.resolve(ex.content, opts.macroCtx);
          if (!resolvedContent.trim()) continue;

          messages.push({
            role: ex.role,
            content: [{ type: 'text', text: resolvedContent }],
          });
        }
        continue;
      }

      for (const entry of this.resolvePromptEntries(prompt, collection)) {
        const resolvedContent = opts.macroResolver.resolve(entry, opts.macroCtx);
        if (!resolvedContent.trim()) continue;

        messages.push({
          role: prompt.role,
          content: [{ type: 'text', text: resolvedContent }],
        });
      }
    }
    return messages;
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
