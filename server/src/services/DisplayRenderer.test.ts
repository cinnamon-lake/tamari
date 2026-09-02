import { describe, it, expect } from 'vitest';
import type { ContentPart, Message } from '@tamari/types';
import { renderMessageParts, type DisplayRenderContext } from './DisplayRenderer.js';

function makeCtx(parts: ContentPart[]): DisplayRenderContext {
  const message: Message = {
    id: 1,
    parentId: null,
    role: 'assistant',
    extra: { parts },
    createdAt: 0,
    updatedAt: 0,
  };
  return { message, userName: 'User', charName: 'Char' };
}

describe('renderMessageParts', () => {
  it('returns an array aligned 1:1 with the parts', async () => {
    const html = await renderMessageParts(
      makeCtx([
        { type: 'text', text: 'The corridor forks.' },
        {
          type: 'tool_result',
          toolUseId: 'call-1',
          content: 'Presented 2 choices to the user: Left, Right',
          extra: { renderType: 'choices', choicesPrompt: 'Which way?', choices: ['Left', 'Right'] },
        },
        { type: 'text', text: 'You hesitate.' },
      ]),
    );
    expect(html).toHaveLength(3);
    expect(html[0]).toContain('The corridor forks.');
    expect(html[1]).toBeNull();
    expect(html[2]).toContain('You hesitate.');
  });

  it('returns null for every non-text part type (client renders those raw)', async () => {
    const html = await renderMessageParts(
      makeCtx([
        { type: 'reasoning', text: 'thinking…' },
        { type: 'backend_debug', text: 'checkpoint 1' },
        { type: 'image', source: 'https://example.com/x.png' },
        { type: 'audio', source: 'https://example.com/x.mp3' },
        { type: 'video', source: 'https://example.com/x.mp4' },
        { type: 'tool_use', id: 'call-1', name: 'roll_dice', input: { sides: 6 } },
        { type: 'tool_result', toolUseId: 'call-1', content: 'Rolled 2d6: 7' },
      ]),
    );
    expect(html).toEqual([null, null, null, null, null, null, null]);
  });

  it('returns null for blank text parts', async () => {
    const html = await renderMessageParts(
      makeCtx([
        { type: 'text', text: 'The reply.' },
        { type: 'text', text: '   ' },
      ]),
    );
    expect(html[0]).toContain('The reply.');
    expect(html[1]).toBeNull();
  });

  it('renders each text part independently', async () => {
    const html = await renderMessageParts(
      makeCtx([
        { type: 'text', text: '**bold** first' },
        { type: 'tool_use', id: 'call-1', name: 'roll_dice', input: {} },
        { type: 'text', text: '*italic* second' },
      ]),
    );
    expect(html[0]).toContain('<strong>bold</strong> first');
    expect(html[1]).toBeNull();
    expect(html[2]).toContain('<em>italic</em> second');
  });

  it('falls back to a single-element array for legacy flat-text messages', async () => {
    const message: Message = {
      id: 1,
      parentId: null,
      role: 'assistant',
      extra: { content: 'legacy **flat** text' },
      createdAt: 0,
      updatedAt: 0,
    };
    const html = await renderMessageParts({ message, userName: 'User', charName: 'Char' });
    expect(html).toHaveLength(1);
    expect(html[0]).toContain('<strong>flat</strong>');
  });

  it('escapes markup inside fenced code blocks instead of emitting live HTML', async () => {
    const parts: ContentPart[] = [
      {
        type: 'text',
        text: 'Here is the component:\n```jsx\n<div class="modal"><button style="color:red">Click</button></div>\n```',
      },
    ];
    const html = await renderMessageParts(makeCtx(parts));
    expect(html[0]).toContain('<pre><code');
    // The snippet must arrive as inert text, not real elements.
    // (DOMPurify re-serializes &quot; as " in text context — still inert.)
    expect(html[0]).toContain('&lt;div class="modal"&gt;');
    expect(html[0]).not.toContain('<div');
    expect(html[0]).not.toContain('<button');
  });

  it('keeps the Layer-3 button protocol in permissive mode, strips it in strict mode', async () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'Choose: <button data-post-response="draw" data-evil="x" onclick="hack()">Draw</button>' },
    ];
    const permissive = await renderMessageParts(makeCtx(parts));
    expect(permissive[0]).toContain('data-post-response="draw"');
    expect(permissive[0]).not.toContain('data-evil');
    expect(permissive[0]).not.toContain('onclick');

    const strict = await renderMessageParts({ ...makeCtx(parts), strictHtmlSanitization: true });
    expect(strict[0]).not.toContain('<button');
    expect(strict[0]).not.toContain('data-post-response');
  });

  it('keeps Layer-3 response forms in permissive mode, strips navigation attrs and strict mode', async () => {
    const parts: ContentPart[] = [
      {
        type: 'text',
        text:
          '<form data-post-response="action" action="https://evil.example" onsubmit="hack()">' +
          '<input name="target" type="text" placeholder="goblin">' +
          '<select name="weapon"><option value="bow" selected>Bow</option></select>' +
          '<button type="submit" formaction="https://evil.example">Attack</button></form>',
      },
    ];
    const permissive = await renderMessageParts(makeCtx(parts));
    expect(permissive[0]).toContain('<form data-post-response="action">');
    expect(permissive[0]).toContain('name="target"');
    expect(permissive[0]).toContain('<select name="weapon">');
    expect(permissive[0]).not.toContain('action=');
    expect(permissive[0]).not.toContain('formaction');
    expect(permissive[0]).not.toContain('onsubmit');

    const strict = await renderMessageParts({ ...makeCtx(parts), strictHtmlSanitization: true });
    expect(strict[0]).not.toContain('<form');
    expect(strict[0]).not.toContain('<input');
  });

  it('strips overlay-capable inline styles (position:fixed/sticky, huge z-index)', async () => {
    const parts: ContentPart[] = [
      {
        type: 'text',
        text:
          '<div style="position:fixed;inset:0;z-index:99999;background:#fff">Enter your token:</div>' +
          '<div style="position:sticky;z-index:100001;top:0">sticky overlay</div>' +
          '<div style="background:#333;color:#fff;z-index:5;border-radius:4px">benign</div>',
      },
    ];
    const html = (await renderMessageParts(makeCtx(parts)))[0] ?? '';
    expect(html).not.toContain('position:fixed');
    expect(html).not.toContain('position:sticky');
    expect(html).not.toContain('99999');
    expect(html).not.toContain('100001');
    // Benign declarations survive — including the modest z-index.
    expect(html).toContain('background:#333');
    expect(html).toContain('border-radius:4px');
    expect(html.toLowerCase()).toContain('z-index:5');
  });

  it('resolves {{attachment::ID}} from this message\'s tool_result extras', async () => {
    const html = await renderMessageParts(
      makeCtx([
        {
          type: 'tool_result',
          toolUseId: 'call-1',
          content: 'generated',
          extra: { attachmentId: 'att-1', attachmentUrl: '/api/attachments/att-1', attachmentMimeType: 'image/png' },
        },
        { type: 'text', text: 'Look: {{attachment::att-1}}' },
      ]),
    );
    expect(html[1]).toContain('<img class="message-inline-img" src="/api/attachments/att-1"');
  });

  it('resolves {{attachment::ID}} pointing at another message via attachmentLookup', async () => {
    const html = await renderMessageParts({
      ...makeCtx([{ type: 'text', text: 'Again: {{attachment::att-9}}' }]),
      attachmentLookup: async (id: string) =>
        id === 'att-9' ? { url: '/api/attachments/att-9', mimeType: 'audio/mpeg' } : undefined,
    });
    expect(html[0]).toContain('<audio class="message-inline-audio" controls="" src="/api/attachments/att-9"');
  });

  it('leaves {{attachment::ID}} untouched when the lookup finds nothing', async () => {
    const html = await renderMessageParts({
      ...makeCtx([{ type: 'text', text: 'Broken: {{attachment::nope}}' }]),
      attachmentLookup: async () => undefined,
    });
    expect(html[0]).toContain('{{attachment::nope}}');
  });
});
