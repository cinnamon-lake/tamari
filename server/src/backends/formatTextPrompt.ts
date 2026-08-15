/**
 * formatTextPrompt — flatten PipelineMessages into a single prompt string
 * for text-completion APIs, using an InstructTemplate.
 *
 * This is the adapter-side half of prompt rendering: the pipeline always
 * produces a message list (ChatCompletionRenderer), and each text-completion
 * adapter owns the chat→string conversion for its wire format — the same way
 * chat adapters own their message shaping (e.g. Claude's system extraction).
 *
 * Macros are already resolved and reasoning parts already stripped/kept by
 * the pipeline; this function is purely mechanical: wrap per role, join with
 * the template separator, add BOS/EOS, and handle the assistant prefill.
 */

import type { PipelineMessage, ContentPart, MessageRole } from './BackendAdapter.js';
import type { InstructTemplate } from './InstructTemplate.js';
import { reconstructWithReasoning } from '../services/ReasoningEngine.js';

export interface FormatTextPromptOptions {
  /** Inline reasoning parts into assistant text using the template's
      reasoning delimiters (mirrors the pipeline's reasoningAddToPrompts). */
  includeReasoning: boolean;
}

/** Text content of a message: plain string, or the joined text parts. */
function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Joined reasoning-part text, if any (never part of `textOf`). */
function reasoningOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return '';
  return content
    .filter((p): p is Extract<ContentPart, { type: 'reasoning' }> => p.type === 'reasoning')
    .map((p) => p.text)
    .join('');
}

export function formatTextPrompt(
  messages: PipelineMessage[],
  template: InstructTemplate,
  opts: FormatTextPromptOptions,
): string {
  const parts: string[] = [];

  if (template.bos) parts.push(template.bos);

  const history = [...messages];

  // Drop the trailing empty assistant message (a fresh generation's stream
  // target placeholder).
  const trailing = history[history.length - 1];
  if (trailing && trailing.role === 'assistant' && !textOf(trailing.content).trim()) {
    history.pop();
  }

  // Extract prefill: a trailing non-empty assistant message is popped and its
  // raw text appended at the end so the model continues from it
  // (continue / regenerate / prefill).
  let prefill = '';
  const prefillMsg = history[history.length - 1];
  if (prefillMsg && prefillMsg.role === 'assistant') {
    history.pop();
    prefill = textOf(prefillMsg.content);
    if (opts.includeReasoning && template.reasoning) {
      const reasoning = reasoningOf(prefillMsg.content);
      if (reasoning) {
        const r = template.reasoning;
        prefill = reconstructWithReasoning(prefill, reasoning, r.prefix, r.suffix, r.separator);
      }
    }
  }

  for (const msg of history) {
    let text = textOf(msg.content);
    if (msg.role === 'assistant' && opts.includeReasoning && template.reasoning) {
      const reasoning = reasoningOf(msg.content);
      if (reasoning) {
        const r = template.reasoning;
        text = reconstructWithReasoning(text, reasoning, r.prefix, r.suffix, r.separator);
      }
    }
    // History messages render verbatim (empty ones included) — the pipeline
    // already dropped empty preset prompts; nothing to skip here.
    parts.push(wrap(text, msg.role, template));
  }

  // The "prompt" for the model to continue from.
  if (template.responsePrefix) parts.push(template.responsePrefix);

  // Prefill goes in raw (unwrapped) so the model continues from it.
  if (prefill) parts.push(prefill);

  if (template.eos) parts.push(template.eos);

  return parts.join(template.separator ?? '\n\n');
}

function wrap(content: string, role: MessageRole, template: InstructTemplate): string {
  let prefix = '';
  let suffix = '';

  switch (role) {
    case 'system':
      prefix = template.systemPrefix ?? '';
      suffix = template.systemSuffix ?? '';
      break;
    case 'user':
      prefix = template.userPrefix ?? '';
      suffix = template.userSuffix ?? '';
      break;
    case 'assistant':
      prefix = template.assistantPrefix ?? '';
      suffix = template.assistantSuffix ?? '';
      break;
    default:
      break;
  }

  return prefix + content + suffix;
}
