import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import type { Message, Character, RegexRule } from '@tamari/types';
import { getMessageText } from '@tamari/types';
import { MacroResolver } from '../pipeline/MacroResolver.js';
import { applyRules, filterRulesByRole } from './RegexEngine.js';
import { resolveHtmlImages } from '../lib/resolveHtmlImages.js';

const domWindow = new JSDOM('').window;
const DOMPurify = createDOMPurify(domWindow);

// Custom renderer for syntax highlighting (same as client)
const renderer = new marked.Renderer();
renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  return `<pre><code class="hljs language-${lang ?? 'plaintext'}">${text}</code></pre>`;
};
marked.use({ renderer });
marked.setOptions({
  breaks: true,
  gfm: true,
});

const permissiveConfig = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'u', 's', 'del', 'ins',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'img',
    'audio', 'video', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'hr', 'details', 'summary', 'span',
    'div', 'button',
    'form', 'input', 'select', 'option', 'optgroup', 'textarea',
    'label', 'fieldset', 'legend',
  ],
  // data-post-response: the Layer-3 interaction protocol
  // (docs/design/scriptable-layers.md §4) — <button data-post-response="attack">
  // renders a button whose click posts "attack" as the user's next message, and
  // <form data-post-response="action"> serializes its fields to a fenced XML
  // block on submit. ALLOW_DATA_ATTR is off, so this is the ONLY data-*
  // attribute that survives sanitization. Form tags are whitelisted but
  // action/method/formaction/enctype deliberately are not — forms in messages
  // are decorative and must never navigate. This is the canonical sanitize
  // config — the former client-side mirror (client markdown.ts) was removed
  // when rendering moved fully server-side.
  ALLOWED_ATTR: [
    'href', 'title', 'src', 'alt', 'class', 'style', 'controls', 'preload',
    'data-post-response',
    'name', 'type', 'value', 'placeholder', 'checked', 'selected', 'for', 'rows',
  ],
  ALLOW_DATA_ATTR: false,
  // Field names are the form protocol's payload keys, and natural RPG names
  // (target, action, elements…) collide with HTMLFormElement properties —
  // DOMPurify's default DOM-clobbering guard strips those name attributes,
  // which would silently destroy the protocol. Clobbering exposure is
  // acceptable here: no scripts survive sanitization, and the client-side
  // serializer avoids clobberable property access.
  SANITIZE_DOM: false,
};

const strictConfig = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 's', 'del', 'ins', 'code', 'a', 'span'],
  ALLOWED_ATTR: ['href', 'title'],
};

export interface DisplayRenderContext {
  message: Message;
  character?: Character;
  characterAssets?: Array<{ name: string; id: string; ext: string }>;
  regexRules?: RegexRule[];
  strictHtmlSanitization?: boolean;
  userName: string;
  charName: string;
}

async function renderTextPart(text: string, ctx: DisplayRenderContext): Promise<string> {
  // 0. Storage macros (backward compat for old messages that were saved before
  //    write-time resolution; for new messages this is a no-op)
  const storageResolver = MacroResolver.createStorageResolver();
  let resolved = storageResolver.resolve(text, {
    userName: ctx.userName,
    charName: ctx.charName,
    macroVars: ctx.message.extra.macroVars ?? {},
  });

  // 1. Display regexes
  if (ctx.regexRules && ctx.regexRules.length > 0) {
    const displayRules = filterRulesByRole(ctx.regexRules, 'display', ctx.message.role);
    if (displayRules.length > 0) {
      resolved = await applyRules(resolved, displayRules);
    }
  }

  // 2. Display macros (attachment, img)
  const displayResolver = MacroResolver.createDisplayResolver();
  const attachments: Record<string, { url: string; mimeType: string }> = {};
  const msgAttachments = ctx.message.extra.attachments;
  if (msgAttachments) {
    for (const att of msgAttachments) {
      attachments[att.id] = { url: att.url, mimeType: att.mimeType };
    }
  }
  const parts = ctx.message.extra.parts;
  if (parts) {
    for (const part of parts) {
      if (part.type === 'tool_result') {
        const extra = part.extra;
        const id = extra?.attachmentId;
        const url = extra?.attachmentUrl;
        const mimeType = extra?.attachmentMimeType;
        if (typeof id === 'string' && typeof url === 'string') {
          attachments[id] = { url, mimeType: typeof mimeType === 'string' ? mimeType : '' };
        }
      }
    }
  }

  const characterAssets: Record<string, string> = {};
  if (ctx.character && ctx.characterAssets) {
    for (const asset of ctx.characterAssets) {
      if (asset.name) {
        characterAssets[asset.name] = `/api/characters/${ctx.character.id}/assets/${asset.id}.${asset.ext}`;
      }
    }
  }

  const macroCtx = {
    userName: ctx.userName,
    charName: ctx.charName,
    characterAssets,
    attachments,
  };
  resolved = displayResolver.resolve(resolved, macroCtx);

  // 3. Resolve embedded URIs
  if (ctx.character && ctx.characterAssets) {
    resolved = resolveHtmlImages(resolved, ctx.characterAssets as import('@tamari/types').CharacterAsset[], ctx.character.id);
  }

  // 4. Markdown to HTML
  const rawHtml = marked.parse(resolved, { async: false });

  // 5. Sanitize
  const config = ctx.strictHtmlSanitization ? strictConfig : permissiveConfig;
  return DOMPurify.sanitize(rawHtml, config);
}

function renderReasoningPart(text: string): string {
  return `<details class="reasoning-block"><summary class="reasoning-summary">Reasoning</summary><pre class="reasoning-content">${escapeHtml(text)}</pre></details>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function renderMessageHtml(ctx: DisplayRenderContext): Promise<string> {
  const parts = ctx.message.extra.parts;
  const blocks: string[] = [];

  // Pre-scan: tool_use ids whose matching tool_result is rendered client-side
  // as a widget (extra.renderType). Their tool-call blocks are suppressed so
  // the widget alone represents the call.
  const widgetToolUseIds = new Set<string>();
  if (parts) {
    for (const part of parts) {
      if (part.type !== 'tool_result') continue;
      const renderType = part.extra?.renderType;
      if (typeof renderType === 'string' && renderType.length > 0 && part.toolUseId) {
        widgetToolUseIds.add(part.toolUseId);
      }
    }
  }

  if (parts && parts.length > 0) {
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      switch (part.type) {
        case 'text': {
          if (part.text.trim()) {
            blocks.push(await renderTextPart(part.text, ctx));
          }
          break;
        }
        case 'reasoning': {
          if (part.text.trim()) {
            blocks.push(renderReasoningPart(part.text));
          }
          break;
        }
        case 'backend_debug': {
          if (part.text.trim()) {
            blocks.push(
              `<details class="backend-debug-block"><summary class="backend-debug-summary">Backend debug</summary><pre class="backend-debug-content">${escapeHtml(part.text)}</pre></details>`,
            );
          }
          break;
        }
        case 'image': {
          blocks.push(`<img class="message-inline-img" src="${escapeHtml(part.source)}" alt="" loading="lazy" />`);
          break;
        }
        case 'audio': {
          blocks.push(`<audio class="message-inline-audio" controls src="${escapeHtml(part.source)}" preload="metadata" />`);
          break;
        }
        case 'video': {
          blocks.push(`<video class="message-inline-video" controls src="${escapeHtml(part.source)}" preload="metadata" />`);
          break;
        }
        case 'tool_use': {
          // Suppressed when the matching tool_result renders as a client-side
          // widget — the widget represents the call.
          if (widgetToolUseIds.has(part.id)) {
            break;
          }
          const args = JSON.stringify(part.input, null, 2);
          blocks.push(
            `<div class="tool-call-block"><div class="tool-call-header"><i class="bi bi-tools"></i> ${escapeHtml(
              part.name || 'Tool',
            )}</div><pre class="tool-call-args">${escapeHtml(args)}</pre></div>`,
          );
          break;
        }
        case 'tool_result': {
          // Parts carrying extra.renderType are rendered client-side by the
          // tool-renderers registry; emit a slot the client hydrates into.
          const renderType = part.extra?.renderType;
          if (typeof renderType === 'string' && renderType.length > 0) {
            blocks.push(`<div class="tool-widget-slot" data-part-index="${index}"></div>`);
            break;
          }
          const rawContent = typeof part.content === 'string' ? part.content : '';
          const isError = part.isError === true;
          const icon = isError ? 'bi-exclamation-triangle' : 'bi-check-circle';
          const label = isError ? 'Error' : 'Result';
          // Raw content in a <pre> (like tool-call-args): tool results are JSON /
          // plain text — markdown-rendering them mangles headings, escapes, etc.
          blocks.push(
            `<div class="tool-result-block${isError ? ' error' : ''}"><div class="tool-result-header"><i class="bi ${icon}"></i> ${label}</div><pre class="tool-result-content">${escapeHtml(rawContent)}</pre></div>`,
          );
          break;
        }
      }
    }
  }

  if (blocks.length > 0) {
    return blocks.join('\n');
  }

  // Fallback: legacy messages with flat text only
  const text = ctx.message.extra.content ?? getMessageText(ctx.message.extra.parts);
  return renderTextPart(text, ctx);
}

/** Render markdown text to sanitized HTML (no macro/regex processing). */
export function renderMarkdownToHtml(text: string, strictHtmlSanitization = false): string {
  const rawHtml = marked.parse(text, { async: false });
  const config = strictHtmlSanitization ? strictConfig : permissiveConfig;
  return DOMPurify.sanitize(rawHtml, config);
}
