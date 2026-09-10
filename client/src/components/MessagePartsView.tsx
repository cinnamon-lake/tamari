import { For, Show, createMemo, type JSX } from 'solid-js';
import type { ContentPart, InlineContentPart, Message, TextPart, ToolResultPart } from '@tamari/types';
import { getToolRenderer } from './tool-renderers/index.js';
import { authenticateMediaInHtml, authenticatedSrc } from '../lib/apiFetch.js';

/**
 * Renders a message's content parts. Only text parts carry server-rendered
 * HTML (`message.renderedHtml[i]`, aligned 1:1 with `extra.parts`); every
 * other part type is rendered here from the raw part data. Tool results with
 * `extra.renderType` are hydrated directly from the toolRenderers registry —
 * no server-side widget slots.
 */
export interface MessagePartsViewProps {
  message: Message;
  isStreamingTarget?: boolean;
  streamFadeIn?: boolean;
  widgetsDisabled?: boolean;
  /** Index of the text part currently being edited (renders the edit area
      instead of that part's HTML). */
  editingPartIndex?: number | null;
  /** Render the edit UI for the text part at the given index. */
  renderEditArea?: (partIndex: number, partText: string) => JSX.Element;
  onContentClick?: (e: MouseEvent) => void;
  onContentSubmit?: (e: SubmitEvent) => void;
}

/** tool_use ids whose matching tool_result renders as a widget — their
    tool-call blocks are suppressed so the widget alone represents the call. */
function collectWidgetToolUseIds(parts: ContentPart[]): Set<string> {
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.type !== 'tool_result') continue;
    const renderType = part.extra?.renderType;
    if (typeof renderType === 'string' && renderType.length > 0 && part.toolUseId) {
      ids.add(part.toolUseId);
    }
  }
  return ids;
}

function toolResultText(part: ToolResultPart): string {
  if (typeof part.content === 'string') return part.content;
  return part.content
    .filter((c): c is TextPart => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/** Non-text inline items (image/audio/video) carried alongside the text. */
function toolResultMedia(part: ToolResultPart): InlineContentPart[] {
  return Array.isArray(part.content) ? part.content.filter((c) => c.type !== 'text') : [];
}

function renderInlineMedia(part: InlineContentPart): JSX.Element {
  switch (part.type) {
    case 'image':
      return <img class="message-inline-img" src={authenticatedSrc(part.source)} alt="" loading="lazy" />;
    case 'audio':
      return <audio class="message-inline-audio" controls src={authenticatedSrc(part.source)} preload="metadata" />;
    case 'video':
      return <video class="message-inline-video" controls src={authenticatedSrc(part.source)} preload="metadata" />;
    default:
      return null;
  }
}

export function MessagePartsView(props: MessagePartsViewProps) {
  const parts = createMemo(() => props.message.extra.parts ?? []);
  const renderedHtml = createMemo(() => props.message.renderedHtml ?? []);
  // Server-rendered HTML can embed <img>/<audio>/<video> pointing at
  // token-checked routes (/api/attachments, /files). Media elements cannot
  // send headers, so rewrite those sources to query-param form in the HTML
  // string BEFORE it reaches the DOM — a post-insert fix-up races the
  // browser's fetch of the untokened src.
  const tokenedHtml = createMemo(() => renderedHtml().map((h) => (h == null ? h : authenticateMediaInHtml(h))));
  const widgetToolUseIds = createMemo(() => collectWidgetToolUseIds(parts()));

  // Text parts always render in place; runs of everything else (tool
  // calls/results, reasoning, empty text) collapse into a dropdown exactly
  // where the run sits in the message. While streaming with no text yet
  // nothing collapses, so live tool activity stays on screen.
  interface IndexedPart {
    part: ContentPart;
    index: number;
  }
  interface Segment {
    collapsible: boolean;
    entries: IndexedPart[];
  }
  const segments = createMemo<Segment[]>(() => {
    const ps = parts();
    const hasText = ps.some((p) => p.type === 'text' && p.text.trim());
    const segs: Segment[] = [];
    ps.forEach((part, index) => {
      const collapsible = hasText && !(part.type === 'text' && part.text.trim());
      const last = segs[segs.length - 1];
      if (last && last.collapsible === collapsible) {
        last.entries.push({ part, index });
      } else {
        segs.push({ collapsible, entries: [{ part, index }] });
      }
    });
    return segs;
  });
  // Keep a dropdown open when the part being edited lives inside it.
  const editingInSegment = (seg: Segment) =>
    props.editingPartIndex != null && seg.entries.some((e) => e.index === props.editingPartIndex);

  const renderPart = (part: ContentPart, index: () => number): JSX.Element => {
    switch (part.type) {
      case 'text': {
        return (
          <Show
            when={props.editingPartIndex === index() && props.renderEditArea !== undefined}
            fallback={<div class="message-part-text" innerHTML={tokenedHtml()[index()] ?? ''} />}
          >
            {props.renderEditArea!(index(), part.text)}
          </Show>
        );
      }
      case 'reasoning': {
        return (
          <Show when={part.text.trim()}>
            <details class="reasoning-block">
              <summary class="reasoning-summary">Reasoning</summary>
              <pre class="reasoning-content">{part.text}</pre>
            </details>
          </Show>
        );
      }
      case 'backend_debug': {
        return (
          <Show when={part.text.trim()}>
            <details class="backend-debug-block">
              <summary class="backend-debug-summary">Backend debug</summary>
              <pre class="backend-debug-content">{part.text}</pre>
            </details>
          </Show>
        );
      }
      case 'image':
      case 'audio':
      case 'video': {
        return renderInlineMedia(part);
      }
      case 'tool_use': {
        return (
          <Show when={!widgetToolUseIds().has(part.id)}>
            <div class="tool-call-block">
              <div class="tool-call-header">
                <i class="bi bi-tools" /> {part.name || 'Tool'}
              </div>
              <pre class="tool-call-args">{JSON.stringify(part.input, null, 2)}</pre>
            </div>
          </Show>
        );
      }
      case 'tool_result': {
        const renderType = part.extra?.renderType;
        if (typeof renderType === 'string' && renderType.length > 0) {
          const Renderer = getToolRenderer(renderType);
          return (
            <Renderer
              content={toolResultText(part)}
              isError={part.isError === true}
              extra={part.extra}
              messageId={props.message.id}
              disabled={props.widgetsDisabled}
            />
          );
        }
        const isError = part.isError === true;
        // Raw content in a <pre>: tool results are JSON / plain text —
        // markdown-rendering them would mangle headings, escapes, etc.
        // Array content (e.g. text + a generated image) renders text in the
        // <pre> and the media items inline below it.
        return (
          <div class={`tool-result-block${isError ? ' error' : ''}`}>
            <div class="tool-result-header">
              <i class={`bi ${isError ? 'bi-exclamation-triangle' : 'bi-check-circle'}`} />{' '}
              {isError ? 'Error' : 'Result'}
            </div>
            <pre class="tool-result-content">{toolResultText(part)}</pre>
            <For each={toolResultMedia(part)}>{(item) => renderInlineMedia(item)}</For>
          </div>
        );
      }
    }
  };

  // entry.index keeps part indices aligned with the original `parts` array
  // (renderedHtml and editingPartIndex are indexed against it).
  const renderEntry = (entry: IndexedPart): JSX.Element => (
    <div data-part-index={entry.index} class={`message-part message-part-${entry.part.type}`}>
      {renderPart(entry.part, () => entry.index)}
    </div>
  );

  return (
    <div
      class={`message-content${props.isStreamingTarget && props.streamFadeIn ? ' stream-fade-in' : ''}`}
      onClick={props.onContentClick}
      onSubmit={props.onContentSubmit}
    >
      <Show
        when={parts().length > 0}
        fallback={
          // Legacy messages without parts: single rendered block.
          <Show when={tokenedHtml()[0] != null}>
            <div class="message-part-text" innerHTML={tokenedHtml()[0] ?? ''} />
          </Show>
        }
      >
        <For each={segments()}>
          {(seg) => (
            <Show when={seg.collapsible} fallback={<For each={seg.entries}>{(entry) => renderEntry(entry)}</For>}>
              <details class="tool-activity-block" open={editingInSegment(seg)}>
                <summary class="tool-activity-summary">
                  <i class="bi bi-tools" /> Tool activity ({seg.entries.length})
                </summary>
                <div class="tool-activity-content">
                  <For each={seg.entries}>{(entry) => renderEntry(entry)}</For>
                </div>
              </details>
            </Show>
          )}
        </For>
      </Show>
      {/* Editing a message that has no text part: the edit area appends one
          (editingPartIndex === parts.length). */}
      <Show when={props.editingPartIndex === parts().length && props.renderEditArea !== undefined}>
        {props.renderEditArea!(parts().length, '')}
      </Show>
    </div>
  );
}
