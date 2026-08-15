import type { Component } from 'solid-js';
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

/** Built-in widget renderers. Lua tool templates may set arbitrary extra
    `renderType`s — those fall through to DefaultToolResult (see getToolRenderer). */
export type BuiltinRenderType = 'dice' | 'choices' | 'npc_roster' | 'scene' | 'map';

const toolRenderers: Record<BuiltinRenderType, Component<ToolResultProps>> = {
  dice: DiceResult,
  choices: ChoicesResult,
  npc_roster: NpcRosterResult,
  scene: SceneResult,
  map: MapResult,
};

export function getToolRenderer(type?: string) {
  if (type && type in toolRenderers) {
    return toolRenderers[type as BuiltinRenderType];
  }
  return DefaultToolResult;
}
