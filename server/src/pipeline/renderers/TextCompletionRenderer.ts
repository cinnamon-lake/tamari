/**
 * TextCompletionRenderer — flattens a PromptCollection into a single string.
 *
 * Uses an InstructTemplate to wrap system prompts, user messages, and
 * assistant messages. Replaces the old ST's story-string template system
 * and separate instruct-mode fields.
 */

import { getMessageText } from '@tamari/types';
import type { RenderOptions, PromptCollection, TextRenderResult, PromptRenderer } from './Renderer.js';
import { TokenBudget } from './Renderer.js';
import type { InstructTemplate } from './InstructTemplate.js';
import type { ContentPart } from '../../backends/BackendAdapter.js';
import { reconstructWithReasoning } from '../../services/ReasoningEngine.js';

function reasoningFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return (parts as unknown[])
    .filter((p): p is ContentPart => !!p && typeof p === 'object' && (p as ContentPart).type === 'reasoning')
    .map((p) => (p as { type: 'reasoning'; text: string }).text)
    .join('');
}

export class TextCompletionRenderer implements PromptRenderer {
  constructor(private template: InstructTemplate) {}

  render(collection: PromptCollection, opts: RenderOptions): TextRenderResult {
    const budget = new TokenBudget(opts.maxContext - opts.maxResponseTokens);
    let promptTokens = 0;

    // Reserve space for assistant reply
    budget.reserve(3);
    promptTokens += 3;

    const parts: string[] = [];

    // Add BOS if configured
    if (this.template.bos) {
      parts.push(this.template.bos);
    }

    // Render prompt collection chunks, split at the chatHistory marker:
    // prompts before it render before the history, prompts after it render
    // after (the marker's position is meaningful — see ChatCompletionRenderer).
    const markerIndex = collection.prompts.findIndex((p) => p.identifier === 'chatHistory');
    const beforePrompts = markerIndex === -1 ? collection.prompts : collection.prompts.slice(0, markerIndex);
    const afterPrompts = markerIndex === -1 ? [] : collection.prompts.slice(markerIndex + 1);

    const renderPrompts = (prompts: typeof collection.prompts): void => {
      for (const prompt of prompts) {
        // Absolute-position prompts are skipped: depth injection splices into a
        // message list, and this renderer produces a flat story string. Only the
        // chat renderer honors them (see PromptRenderer in Renderer.ts).
        if (prompt.injectionPosition === 'absolute') continue;
        if (!prompt.enabled) continue;

        // Special handling for dialogueExamples: insert parsed example messages
        if (prompt.identifier === 'dialogueExamples' && collection.dialogueExamples?.length) {
          for (const ex of collection.dialogueExamples) {
            const resolved = opts.macroResolver.resolve(ex.content, opts.macroCtx);
            if (!resolved.trim()) continue;

            const tokens = opts.tokenCounter.count(resolved);
            if (!budget.canAfford(tokens)) break;
            budget.spend(tokens);
            promptTokens += tokens;

            const wrapped = this.wrap(resolved, ex.role);
            parts.push(wrapped);
          }
          continue;
        }

        const content = prompt.marker ? (collection.markers[prompt.identifier] ?? prompt.content) : prompt.content;
        if (prompt.marker && !content.trim()) continue;

        const resolved = opts.macroResolver.resolve(content, opts.macroCtx);
        if (!resolved.trim()) continue;

        const tokens = opts.tokenCounter.count(resolved);
        if (!budget.canAfford(tokens)) break;
        budget.spend(tokens);
        promptTokens += tokens;

        const wrapped = this.wrap(resolved, prompt.role);
        parts.push(wrapped);
      }
    };

    renderPrompts(beforePrompts);

    // Render chat history
    const history = [...opts.chatHistory];
    // Skip the trailing empty assistant message that was created as a stream target
    const trailingMsg = history[history.length - 1];
    if (
      trailingMsg &&
      trailingMsg.role === 'assistant' &&
      !getMessageText(trailingMsg.extra.parts).trim()
    ) {
      history.pop();
    }

    // Extract prefill: if the last message is a non-empty assistant message,
    // we pop it and append its raw content at the end so the model can
    // continue from it (continue / regenerate / prefill).
    let prefill = '';
    const prefillMsg = history[history.length - 1];
    if (prefillMsg && prefillMsg.role === 'assistant') {
      history.pop();
      prefill = opts.macroResolver.resolve(getMessageText(prefillMsg.extra.parts), opts.macroCtx);
      if (opts.reasoningAddToPrompts && this.template.reasoning) {
        const reasoning = reasoningFromParts(prefillMsg.extra.parts);
        if (reasoning) {
          const r = this.template.reasoning;
          prefill = reconstructWithReasoning(prefill, reasoning, r.prefix, r.suffix, r.separator);
        }
      }
    }

    history.reverse();
    const historyParts: string[] = [];

    for (const msg of history) {
      let resolved = getMessageText(msg.extra.parts);
      // Resolve storage macros on message text (backward compat for old messages)
      resolved = opts.macroResolver.resolve(resolved, opts.macroCtx);

      // Inline reasoning into assistant messages when enabled
      if (msg.role === 'assistant' && opts.reasoningAddToPrompts && this.template.reasoning) {
        const reasoning = reasoningFromParts(msg.extra.parts);
        if (reasoning) {
          const r = this.template.reasoning;
          resolved = reconstructWithReasoning(resolved, reasoning, r.prefix, r.suffix, r.separator);
        }
      }

      const tokens = opts.tokenCounter.count(resolved);
      if (!budget.canAfford(tokens)) break;
      budget.spend(tokens);
      promptTokens += tokens;

      const wrapped = this.wrap(resolved, msg.role);
      historyParts.unshift(wrapped);
    }

    parts.push(...historyParts);

    // Prompts ordered after the chatHistory marker render after the history,
    // before the response prefix/prefill (post-history instructions).
    renderPrompts(afterPrompts);

    // Add response prefix (the "prompt" for the model to continue)
    const responsePrefix = opts.impersonateMode
      ? (this.template.userPrefix ?? this.template.responsePrefix)
      : this.template.responsePrefix;
    if (responsePrefix) {
      parts.push(responsePrefix);
    }

    // Append prefill content raw (unwrapped) so the model continues from it
    if (prefill) {
      parts.push(prefill);
    }

    // Add EOS if configured
    if (this.template.eos) {
      parts.push(this.template.eos);
    }

    const sep = this.template.separator ?? '\n\n';
    const text = parts.join(sep);

    return {
      type: 'text',
      text,
      tokenUsage: { prompt: promptTokens, completion: opts.maxResponseTokens },
    };
  }

  private wrap(content: string, role: string): string {
    let prefix = '';
    let suffix = '';

    switch (role) {
      case 'system':
        prefix = this.template.systemPrefix ?? '';
        suffix = this.template.systemSuffix ?? '';
        break;
      case 'user':
        prefix = this.template.userPrefix ?? '';
        suffix = this.template.userSuffix ?? '';
        break;
      case 'assistant':
        prefix = this.template.assistantPrefix ?? '';
        suffix = this.template.assistantSuffix ?? '';
        break;
      default:
        break;
    }

    return prefix + content + suffix;
  }
}
