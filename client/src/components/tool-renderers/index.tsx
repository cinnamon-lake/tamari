import type { Component } from 'solid-js';
import { render } from 'solid-js/web';
import type { Message } from '@tamari/types';
import { DiceResult } from './DiceResult.js';
import { ChoicesResult } from './ChoicesResult.js';
import { NpcRosterResult } from './NpcRosterResult.js';
import { SceneResult } from './SceneResult.js';
import { MapResult } from './MapResult.js';
import { useI18n } from '../../i18n/index.js';

export interface ToolResultProps {
  content: string;
  isError?: boolean;
  extra?: Record<string, unknown>;
  messageId?: number;
  disabled?: boolean;
}

export interface RenderableToolPart {
  content: string;
  isError?: boolean;
  extra: Record<string, unknown>;
  /** Index of the part in `message.extra.parts` (matches the server's `data-part-index`). */
  index: number;
}

const DefaultToolResult: Component<ToolResultProps> = (props) => {
  const { t } = useI18n();
  return (
    <div class={`tool-result-block${props.isError ? ' error' : ''}`}>
      <div class="tool-result-header">
        <i class={`bi ${props.isError ? 'bi-exclamation-triangle' : 'bi-check-circle'}`} />
        {props.isError ? t('tools.error') : t('tools.result')}
      </div>
      <div class="tool-result-content">{props.content}</div>
    </div>
  );
};

export const toolRenderers: Record<string, Component<ToolResultProps>> = {
  dice: DiceResult,
  choices: ChoicesResult,
  npc_roster: NpcRosterResult,
  scene: SceneResult,
  map: MapResult,
};

export function getToolRenderer(type?: string) {
  if (type && toolRenderers[type]) {
    return toolRenderers[type];
  }
  return DefaultToolResult;
}

/**
 * Scan a message's parts for `tool_result` entries carrying an
 * `extra.renderType`. The server renders these as `<div class="tool-widget-slot">`
 * placeholders and the client hydrates interactive widgets into the slots.
 * Unregistered renderTypes are intentionally kept — they fall back to the
 * default block.
 */
export function getRenderableToolParts(message: Message): RenderableToolPart[] {
  const parts = message.extra.parts;
  if (!Array.isArray(parts)) return [];
  const out: RenderableToolPart[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part: unknown = parts[index];
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    if (p.type !== 'tool_result') continue;
    const extra = p.extra as Record<string, unknown> | undefined;
    if (!extra || typeof extra.renderType !== 'string' || extra.renderType.length === 0) continue;
    out.push({
      content: typeof p.content === 'string' ? p.content : '',
      isError: Boolean(p.isError),
      extra,
      index,
    });
  }
  return out;
}

/**
 * Hydrate interactive tool widgets into the `.tool-widget-slot` placeholders
 * the server left in a message's rendered HTML. Returns a dispose function
 * that unmounts everything it mounted.
 */
export function mountToolWidgets(
  container: HTMLElement,
  message: Message,
  opts: { disabled?: boolean } = {},
): () => void {
  const parts = message.extra.parts;
  const disposers: Array<() => void> = [];
  for (const slot of container.querySelectorAll<HTMLElement>('.tool-widget-slot')) {
    const index = Number(slot.dataset.partIndex);
    if (!Array.isArray(parts) || !Number.isInteger(index)) continue;
    const part = parts[index] as Record<string, unknown> | undefined;
    if (!part || typeof part !== 'object') continue;
    const extra = part.extra as Record<string, unknown> | undefined;
    const renderType = extra?.renderType;
    const Renderer = getToolRenderer(typeof renderType === 'string' ? renderType : undefined);
    disposers.push(
      render(
        () => (
          <Renderer
            content={typeof part.content === 'string' ? part.content : ''}
            isError={Boolean(part.isError)}
            extra={extra}
            messageId={message.id}
            disabled={opts.disabled}
          />
        ),
        slot,
      ),
    );
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}
