import type { Component } from 'solid-js';
import type { ToolResultProps } from './index.js';
import { useI18n } from '../../i18n/index.js';
import './SceneResult.css';

/** Passive inline chip marking a scene change; shows the caption when present. */
export const SceneResult: Component<ToolResultProps> = (props) => {
  const { t } = useI18n();
  const caption = (): string => {
    const scene = props.extra?.scene;
    if (scene && typeof scene === 'object' && !Array.isArray(scene)) {
      const c = (scene as Record<string, unknown>).caption;
      if (typeof c === 'string' && c.length > 0) return c;
    }
    return t('tools.sceneChanged');
  };
  return (
    <div class="scene-chip">
      <i class="bi bi-image" />
      {caption()}
    </div>
  );
};
