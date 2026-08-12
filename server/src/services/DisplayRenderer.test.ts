import { describe, it, expect } from 'vitest';
import type { ContentPart, Message } from '@tamari/types';
import { renderMessageHtml, type DisplayRenderContext } from './DisplayRenderer.js';

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

describe('renderMessageHtml tool_result parts', () => {
  it('renders a generic tool-result-block for parts without renderType', async () => {
    const html = await renderMessageHtml(
      makeCtx([{ type: 'tool_result', toolUseId: 'call-1', content: 'Rolled 2d6: 3, 4 = 7' }]),
    );
    expect(html).toContain('tool-result-block');
    expect(html).toContain('Rolled 2d6');
  });

  it('emits a tool-widget-slot for parts carrying extra.renderType (hydrated client-side)', async () => {
    const html = await renderMessageHtml(
      makeCtx([
        { type: 'text', text: 'The corridor forks.' },
        {
          type: 'tool_result',
          toolUseId: 'call-1',
          content: 'Presented 2 choices to the user: Left, Right',
          extra: { renderType: 'choices', choicesPrompt: 'Which way?', choices: ['Left', 'Right'] },
        },
      ]),
    );
    expect(html).toContain('The corridor forks.');
    expect(html).toContain('<div class="tool-widget-slot" data-part-index="1"></div>');
    expect(html).not.toContain('tool-result-block');
    expect(html).not.toContain('Presented 2 choices');
  });

  it('suppresses the tool_use block whose tool_result renders as a widget', async () => {
    const html = await renderMessageHtml(
      makeCtx([
        { type: 'tool_use', id: 'call-1', name: 'present_choices', input: { options: ['Left', 'Right'] } },
        {
          type: 'tool_result',
          toolUseId: 'call-1',
          content: 'Presented 2 choices',
          extra: { renderType: 'choices' },
        },
      ]),
    );
    expect(html).not.toContain('tool-call-block');
    expect(html).toContain('<div class="tool-widget-slot" data-part-index="1"></div>');
  });

  it('keeps the tool_use block when its tool_result has no renderType', async () => {
    const html = await renderMessageHtml(
      makeCtx([
        { type: 'tool_use', id: 'call-1', name: 'roll_dice', input: { sides: 6 } },
        { type: 'tool_result', toolUseId: 'call-1', content: 'Rolled 2d6: 3, 4 = 7' },
      ]),
    );
    expect(html).toContain('tool-call-block');
    expect(html).toContain('tool-result-block');
    expect(html).not.toContain('tool-widget-slot');
  });

  it('renders text, slot, text in order for a mixed message', async () => {
    const html = await renderMessageHtml(
      makeCtx([
        { type: 'text', text: 'Before the choice.' },
        { type: 'tool_use', id: 'call-1', name: 'present_choices', input: {} },
        {
          type: 'tool_result',
          toolUseId: 'call-1',
          content: 'Presented 2 choices',
          extra: { renderType: 'choices' },
        },
        { type: 'text', text: 'After the choice.' },
      ]),
    );
    expect(html).not.toContain('tool-call-block');
    const beforeIdx = html.indexOf('Before the choice.');
    const slotIdx = html.indexOf('<div class="tool-widget-slot" data-part-index="2"></div>');
    const afterIdx = html.indexOf('After the choice.');
    expect(slotIdx).toBeGreaterThan(-1);
    expect(beforeIdx).toBeGreaterThan(-1);
    expect(afterIdx).toBeGreaterThan(-1);
    expect(beforeIdx).toBeLessThan(slotIdx);
    expect(slotIdx).toBeLessThan(afterIdx);
  });

  it('still renders other tool_result parts when one has a renderType', async () => {
    const html = await renderMessageHtml(
      makeCtx([
        { type: 'tool_result', toolUseId: 'call-1', content: 'generic result' },
        {
          type: 'tool_result',
          toolUseId: 'call-2',
          content: 'widget result',
          extra: { renderType: 'dice', diceResult: 7 },
        },
      ]),
    );
    expect(html.match(/tool-result-block/g)).toHaveLength(1);
    expect(html).toContain('generic result');
    expect(html).not.toContain('widget result');
    expect(html).toContain('<div class="tool-widget-slot" data-part-index="1"></div>');
  });

  it('ignores a non-string renderType', async () => {
    const html = await renderMessageHtml(
      makeCtx([{ type: 'tool_result', toolUseId: 'call-1', content: 'still generic', extra: { renderType: 42 } }]),
    );
    expect(html).toContain('tool-result-block');
    expect(html).toContain('still generic');
  });

  it('renders generic results verbatim in a <pre> — markdown stays literal, HTML is escaped', async () => {
    const html = await renderMessageHtml(
      makeCtx([{ type: 'tool_result', toolUseId: 'call-1', content: '# Heading\n{"key": "<b>value</b>"}' }]),
    );
    expect(html).toContain('<pre class="tool-result-content"># Heading\n{&quot;key&quot;: &quot;&lt;b&gt;value&lt;/b&gt;&quot;}</pre>');
    expect(html).not.toContain('<h1');
  });

  it('keeps the Layer-3 button protocol in permissive mode, strips it in strict mode', async () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'Choose: <button data-post-response="draw" data-evil="x" onclick="hack()">Draw</button>' },
    ];
    const permissive = await renderMessageHtml(makeCtx(parts));
    expect(permissive).toContain('data-post-response="draw"');
    expect(permissive).not.toContain('data-evil');
    expect(permissive).not.toContain('onclick');

    const strict = await renderMessageHtml({ ...makeCtx(parts), strictHtmlSanitization: true });
    expect(strict).not.toContain('<button');
    expect(strict).not.toContain('data-post-response');
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
    const permissive = await renderMessageHtml(makeCtx(parts));
    expect(permissive).toContain('<form data-post-response="action">');
    expect(permissive).toContain('name="target"');
    expect(permissive).toContain('<select name="weapon">');
    expect(permissive).not.toContain('action=');
    expect(permissive).not.toContain('formaction');
    expect(permissive).not.toContain('onsubmit');

    const strict = await renderMessageHtml({ ...makeCtx(parts), strictHtmlSanitization: true });
    expect(strict).not.toContain('<form');
    expect(strict).not.toContain('<input');
  });

  it('renders a backend_debug part as a collapsed details block, HTML-escaped', async () => {
    const html = await renderMessageHtml(
      makeCtx([
        { type: 'text', text: 'The reply.' },
        { type: 'backend_debug', text: 'checkpoint 1\n<b>not html</b>' },
      ]),
    );
    expect(html).toContain('<details class="backend-debug-block">');
    expect(html).toContain('Backend debug');
    expect(html).toContain('checkpoint 1\n&lt;b&gt;not html&lt;/b&gt;');
    expect(html).not.toContain('<b>not html</b>');
    // Ordering: the reply text renders before the debug block.
    expect(html.indexOf('The reply.')).toBeLessThan(html.indexOf('backend-debug-block'));
  });

  it('skips a blank backend_debug part', async () => {
    const html = await renderMessageHtml(
      makeCtx([
        { type: 'text', text: 'The reply.' },
        { type: 'backend_debug', text: '   ' },
      ]),
    );
    expect(html).not.toContain('backend-debug-block');
  });
});
