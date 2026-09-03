import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { ContentPart, Message } from '@tamari/types';
import { MessagePartsView } from './MessagePartsView.js';
import { setAuthToken, clearAuthToken } from '../lib/auth.js';

function makeMessage(parts: ContentPart[], renderedHtml?: (string | null)[]): Message {
  return {
    id: 7,
    parentId: null,
    role: 'assistant',
    extra: { parts },
    createdAt: 0,
    updatedAt: 0,
    renderedHtml,
  };
}

afterEach(() => cleanup());

describe('MessagePartsView', () => {
  it('renders text parts from the aligned renderedHtml array', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage(
          [
            { type: 'text', text: 'first' },
            { type: 'reasoning', text: 'hmm' },
            { type: 'text', text: 'second' },
          ],
          ['<p>first rendered</p>', null, '<p>second rendered</p>'],
        )}
      />
    ));
    expect(screen.getByText('first rendered')).toBeInTheDocument();
    expect(screen.getByText('second rendered')).toBeInTheDocument();
  });

  it('renders reasoning and backend_debug parts as details blocks from raw data', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage([
          { type: 'reasoning', text: 'thinking <b>raw</b>' },
          { type: 'backend_debug', text: 'checkpoint 1' },
        ])}
      />
    ));
    const reasoning = document.querySelector('.reasoning-block');
    expect(reasoning).not.toBeNull();
    // Raw text, not HTML — Solid interpolates escaped.
    expect(reasoning!.querySelector('.reasoning-content')!.innerHTML).toBe('thinking &lt;b&gt;raw&lt;/b&gt;');
    expect(document.querySelector('.backend-debug-content')?.textContent).toBe('checkpoint 1');
  });

  it('renders media parts from raw data', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage([
          { type: 'image', source: '/img.png' },
          { type: 'audio', source: '/a.mp3' },
          { type: 'video', source: '/v.mp4' },
        ])}
      />
    ));
    expect(document.querySelector('img.message-inline-img')?.getAttribute('src')).toBe('/img.png');
    expect(document.querySelector('audio.message-inline-audio')?.getAttribute('src')).toBe('/a.mp3');
    expect(document.querySelector('video.message-inline-video')?.getAttribute('src')).toBe('/v.mp4');
  });

  it('renders a tool_use block and a generic tool_result block', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage([
          { type: 'tool_use', id: 'call-1', name: 'roll_dice', input: { sides: 6 } },
          { type: 'tool_result', toolUseId: 'call-1', content: 'Rolled 2d6: 7' },
        ])}
      />
    ));
    expect(document.querySelector('.tool-call-block')).not.toBeNull();
    expect(document.querySelector('.tool-call-args')?.textContent).toContain('"sides": 6');
    const result = document.querySelector('.tool-result-block');
    expect(result).not.toBeNull();
    expect(result!.querySelector('.tool-result-content')?.textContent).toBe('Rolled 2d6: 7');
  });

  it('renders array tool_result content: text in the pre, media inline', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage([
          {
            type: 'tool_result',
            toolUseId: 'call-1',
            content: [
              { type: 'text', text: 'Generated square image (seed 42).' },
              { type: 'image', source: '/api/attachments/abc', mimeType: 'image/png' },
            ],
          },
        ])}
      />
    ));
    const result = document.querySelector('.tool-result-block');
    expect(result).not.toBeNull();
    expect(result!.querySelector('.tool-result-content')?.textContent).toBe('Generated square image (seed 42).');
    const img = result!.querySelector('img.message-inline-img');
    expect(img?.getAttribute('src')).toBe('/api/attachments/abc');
  });

  it('mounts the registered widget directly for tool_result parts with extra.renderType', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage(
          [
            { type: 'text', text: 'pick one' },
            {
              type: 'tool_result',
              toolUseId: 'call-1',
              content: 'Presented 2 choices',
              extra: { renderType: 'choices', choicesPrompt: 'Which way?', choices: ['Left', 'Right'] },
            },
          ],
          ['<p>pick one</p>', null],
        )}
      />
    ));
    expect(document.querySelector('.choices-result')).not.toBeNull();
    expect(document.querySelector('.choices-prompt')?.textContent).toBe('Which way?');
    expect(document.querySelectorAll('.choice-btn')).toHaveLength(2);
  });

  it('suppresses the tool_use block whose tool_result renders as a widget', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage([
          { type: 'tool_use', id: 'call-1', name: 'present_choices', input: {} },
          {
            type: 'tool_result',
            toolUseId: 'call-1',
            content: 'Presented 2 choices',
            extra: { renderType: 'choices', choices: ['A', 'B'] },
          },
        ])}
      />
    ));
    expect(document.querySelector('.tool-call-block')).toBeNull();
    expect(document.querySelector('.choices-result')).not.toBeNull();
  });

  it('falls back to the default block for unregistered renderTypes', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage([
          { type: 'tool_result', toolUseId: 'call-1', content: 'future widget', extra: { renderType: 'hologram' } },
        ])}
      />
    ));
    expect(document.querySelector('.tool-result-block')).not.toBeNull();
    expect(screen.getByText('future widget')).toBeInTheDocument();
  });

  it('passes widgetsDisabled through to the widget', () => {
    render(() => (
      <MessagePartsView
        widgetsDisabled
        message={makeMessage([
          {
            type: 'tool_result',
            toolUseId: 'call-1',
            content: 'Presented 1 choice',
            extra: { renderType: 'choices', choices: ['Only'] },
          },
        ])}
      />
    ));
    expect(document.querySelector<HTMLButtonElement>('.choice-btn')!.disabled).toBe(true);
  });

  it('tags each part wrapper with data-part-index', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage(
          [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
          ['<p>a</p>', '<p>b</p>'],
        )}
      />
    ));
    const wrappers = document.querySelectorAll('[data-part-index]');
    expect(wrappers).toHaveLength(2);
    expect((wrappers[0] as HTMLElement).dataset.partIndex).toBe('0');
    expect((wrappers[1] as HTMLElement).dataset.partIndex).toBe('1');
  });

  it('renders the edit area in place of the edited text part', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage(
          [
            { type: 'text', text: 'keep' },
            { type: 'text', text: 'edit me' },
          ],
          ['<p>keep</p>', '<p>edit me</p>'],
        )}
        editingPartIndex={1}
        renderEditArea={(idx, text) => <textarea data-testid={`edit-${idx}`} value={text} />}
      />
    ));
    expect(screen.getByText('keep')).toBeInTheDocument();
    expect(screen.queryByText('edit me')).not.toBeInTheDocument();
    expect(screen.getByTestId('edit-1')).toBeInTheDocument();
  });

  it('falls back to renderedHtml[0] for legacy messages without parts', () => {
    const message: Message = {
      id: 9,
      parentId: null,
      role: 'assistant',
      extra: {},
      createdAt: 0,
      updatedAt: 0,
      renderedHtml: ['<p>legacy flat</p>'],
    };
    render(() => <MessagePartsView message={message} />);
    expect(screen.getByText('legacy flat')).toBeInTheDocument();
  });

  it('wraps everything before the last text part in a collapsed tool-activity dropdown', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage(
          [
            { type: 'reasoning', text: 'hmm' },
            { type: 'tool_use', id: 'call-1', name: 'roll_dice', input: {} },
            { type: 'tool_result', toolUseId: 'call-1', content: '7' },
            { type: 'text', text: 'the answer' },
          ],
          [null, null, null, '<p>the answer</p>'],
        )}
      />
    ));
    const details = document.querySelector<HTMLDetailsElement>('details.tool-activity-block');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    // The three preceding parts live inside the dropdown…
    expect(details!.querySelectorAll('[data-part-index]')).toHaveLength(3);
    expect(details!.querySelector('.tool-call-block')).not.toBeNull();
    expect(details!.querySelector('.tool-result-block')).not.toBeNull();
    expect(details!.querySelector('.reasoning-block')).not.toBeNull();
    // …the final text stays outside.
    const finalPart = document.querySelector('[data-part-index="3"]');
    expect(finalPart).not.toBeNull();
    expect(details!.contains(finalPart)).toBe(false);
  });

  it('does not collapse anything when there is no text part (live tool activity)', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage([
          { type: 'tool_use', id: 'call-1', name: 'roll_dice', input: {} },
          { type: 'tool_result', toolUseId: 'call-1', content: '7' },
        ])}
      />
    ));
    expect(document.querySelector('details.tool-activity-block')).toBeNull();
    expect(document.querySelector('.tool-call-block')).not.toBeNull();
  });

  it('keeps the dropdown open when the edited part is inside it', () => {
    render(() => (
      <MessagePartsView
        message={makeMessage(
          [
            { type: 'text', text: 'interim' },
            { type: 'text', text: 'final' },
          ],
          ['<p>interim</p>', '<p>final</p>'],
        )}
        editingPartIndex={0}
        renderEditArea={(idx, text) => <textarea data-testid={`edit-${idx}`} value={text} />}
      />
    ));
    const details = document.querySelector<HTMLDetailsElement>('details.tool-activity-block');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(true);
    expect(screen.getByTestId('edit-0')).toBeInTheDocument();
  });
});

describe('MessagePartsView attachment token rewrite', () => {
  afterEach(() => clearAuthToken());

  it('tokens attachment media in renderedHtml on initial render', () => {
    setAuthToken('abc123');
    render(() => (
      <MessagePartsView
        message={makeMessage(
          [{ type: 'text', text: 'look' }],
          ['<p>look</p><img class="message-inline-img" src="/api/attachments/att-1" alt="">'],
        )}
      />
    ));
    const img = document.querySelector('.message-part-text img');
    expect(img?.getAttribute('src')).toContain('/api/attachments/att-1?token=abc123');
  });

  it('tokens attachment media when renderedHtml arrives later (streaming)', () => {
    setAuthToken('abc123');
    const [msg, setMsg] = createSignal<Message>(makeMessage([{ type: 'text', text: 'look' }], ['<p>look</p>']));
    render(() => <MessagePartsView message={msg()} />);
    setMsg(
      makeMessage(
        [{ type: 'text', text: 'look' }],
        ['<p>look</p><img class="message-inline-img" src="/api/attachments/att-1" alt="">'],
      ),
    );
    const img = document.querySelector('.message-part-text img');
    expect(img?.getAttribute('src')).toContain('/api/attachments/att-1?token=abc123');
  });

  it('tokens attachment media inside collapsed tool-activity parts', () => {
    setAuthToken('abc123');
    render(() => (
      <MessagePartsView
        message={makeMessage(
          [
            { type: 'tool_result', toolUseId: 'c1', content: 'ok' },
            { type: 'text', text: 'mid' },
            { type: 'text', text: 'final' },
          ],
          [null, '<p>mid</p><img class="message-inline-img" src="/api/attachments/att-1" alt="">', '<p>final</p>'],
        )}
      />
    ));
    const img = document.querySelector('.tool-activity-content img');
    expect(img?.getAttribute('src')).toContain('/api/attachments/att-1?token=abc123');
  });
});
