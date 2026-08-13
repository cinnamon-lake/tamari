import { For, Show, createMemo, type JSX } from 'solid-js';
import type { ContentPart, Message, ToolResultPart } from '@tamari/types';
import { getToolRenderer } from './tool-renderers/index.js';

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
  return typeof part.content === 'string' ? part.content : '';
}

export function MessagePartsView(props: MessagePartsViewProps) {
  const parts = createMemo(() => props.message.extra.parts ?? []);
  const renderedHtml = createMemo(() => props.message.renderedHtml ?? []);
  const widgetToolUseIds = createMemo(() => collectWidgetToolUseIds(parts()));

  const renderPart = (part: ContentPart, index: () => number): JSX.Element => {
    switch (part.type) {
      case 'text': {
        return (
          <Show
            when={props.editingPartIndex === index() && props.renderEditArea !== undefined}
            fallback={<div class="message-part-text" innerHTML={renderedHtml()[index()] ?? ''} />}
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
      case 'image': {
        return <img class="message-inline-img" src={part.source} alt="" loading="lazy" />;
      }
      case 'audio': {
        return <audio class="message-inline-audio" controls src={part.source} preload="metadata" />;
      }
      case 'video': {
        return <video class="message-inline-video" controls src={part.source} preload="metadata" />;
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
        return (
          <div class={`tool-result-block${isError ? ' error' : ''}`}>
            <div class="tool-result-header">
              <i class={`bi ${isError ? 'bi-exclamation-triangle' : 'bi-check-circle'}`} /> {isError ? 'Error' : 'Result'}
            </div>
            <pre class="tool-result-content">{toolResultText(part)}</pre>
          </div>
        );
      }
    }
  };

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
          <Show when={renderedHtml()[0] != null}>
            <div class="message-part-text" innerHTML={renderedHtml()[0] ?? ''} />
          </Show>
        }
      >
        <For each={parts()}>
          {(part, index) => (
            <div data-part-index={index()} class={`message-part message-part-${part.type}`}>
              {renderPart(part, index)}
            </div>
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
