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

/**
 * Render a single text part to sanitized HTML (storage macros → display
 * regexes → display macros → asset URI resolution → markdown → sanitize).
 * Exported for the per-part snapshot path (ChatBroadcastService).
 */
export async function renderTextPartHtml(text: string, ctx: DisplayRenderContext): Promise<string> {
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

/**
 * Render a message's parts to per-part HTML. The returned array is aligned
 * 1:1 with `message.extra.parts`: index `i` holds rendered HTML when
 * `parts[i]` is a non-empty text part, `null` for every other part type
 * (the client renders reasoning/media/tool parts from the raw part data).
 *
 * Legacy messages without parts fall back to a single-element array rendered
 * from their flat text.
 */
export async function renderMessageParts(ctx: DisplayRenderContext): Promise<(string | null)[]> {
  const parts = ctx.message.extra.parts;

  if (parts && parts.length > 0) {
    const out: (string | null)[] = [];
    for (const part of parts) {
      if (part.type === 'text' && part.text.trim()) {
        out.push(await renderTextPartHtml(part.text, ctx));
      } else {
        out.push(null);
      }
    }
    return out;
  }

  // Fallback: legacy messages with flat text only
  const text = ctx.message.extra.content ?? getMessageText(ctx.message.extra.parts);
  return [await renderTextPartHtml(text, ctx)];
}

/** Render markdown text to sanitized HTML (no macro/regex processing). */
export function renderMarkdownToHtml(text: string, strictHtmlSanitization = false): string {
  const rawHtml = marked.parse(text, { async: false });
  const config = strictHtmlSanitization ? strictConfig : permissiveConfig;
  return DOMPurify.sanitize(rawHtml, config);
}
