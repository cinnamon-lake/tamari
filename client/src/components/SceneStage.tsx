import { For, Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { ResolvedScene } from '../lib/sceneState.js';
import { sceneStageCollapsed, setSceneStageCollapsed } from '../stores/uiStore.js';
import { useI18n } from '../i18n/index.js';
import './SceneStage.css';

/**
 * Stage panel above the chat: renders the branch's current scene (background +
 * positioned sprites) derived from the newest `scene` tool result. App.tsx only
 * mounts it with a non-null scene. The collapse toggle is ephemeral UI state.
 */
export const SceneStage: Component<{ scene: ResolvedScene | null }> = (props) => {
  const { t } = useI18n();
  return (
    <Show when={props.scene}>
      {(scene) => (
        <div class={`scene-stage${sceneStageCollapsed() ? ' collapsed' : ''}`}>
          <Show when={!sceneStageCollapsed()}>
            <Show when={scene().backgroundUrl}>
              {(url) => <img class="scene-stage-bg" src={url()} alt="" />}
            </Show>
            <For each={scene().sprites}>
              {(sprite) => (
                <img
                  class={`scene-sprite scene-sprite-${sprite.position}`}
                  src={sprite.url}
                  alt={sprite.emotion ? `${sprite.name} (${sprite.emotion})` : sprite.name}
                />
              )}
            </For>
          </Show>
          <button
            type="button"
            class="scene-stage-toggle"
            title={sceneStageCollapsed() ? t('tools.expandScene') : t('tools.collapseScene')}
            aria-label={sceneStageCollapsed() ? t('tools.expandScene') : t('tools.collapseScene')}
            onClick={() => setSceneStageCollapsed(!sceneStageCollapsed())}
          >
            <i class={`bi ${sceneStageCollapsed() ? 'bi-chevron-down' : 'bi-chevron-up'}`} />
          </button>
        </div>
      )}
    </Show>
  );
};
