import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { SceneStage } from './SceneStage.js';
import { setSceneStageCollapsed } from '../stores/uiStore.js';
import type { ResolvedScene } from '../lib/sceneState.js';

const scene: ResolvedScene = {
  backgroundUrl: '/api/attachments/att-1',
  sprites: [
    { name: 'Marta', emotion: 'happy', position: 'left', url: '/api/characters/c1/assets/e1.png' },
    { name: 'Bram', position: 'right', url: '/files/avatars/c2.png' },
  ],
  caption: 'The Tavern',
};

describe('SceneStage', () => {
  beforeEach(() => {
    setSceneStageCollapsed(false);
  });

  it('renders the background and positioned sprites', () => {
    render(() => <SceneStage scene={scene} />);
    const bg = document.querySelector<HTMLImageElement>('.scene-stage-bg')!;
    expect(bg).toBeInTheDocument();
    expect(bg.src).toContain('/api/attachments/att-1');

    const sprites = document.querySelectorAll<HTMLImageElement>('.scene-sprite');
    expect(sprites).toHaveLength(2);
    expect(sprites[0]!.classList.contains('scene-sprite-left')).toBe(true);
    expect(sprites[0]!.src).toContain('/api/characters/c1/assets/e1.png');
    expect(sprites[0]!.alt).toBe('Marta (happy)');
    expect(sprites[1]!.classList.contains('scene-sprite-right')).toBe(true);
    expect(sprites[1]!.alt).toBe('Bram');
  });

  it('renders without a background when backgroundUrl is null', () => {
    render(() => <SceneStage scene={{ backgroundUrl: null, sprites: [], caption: '' }} />);
    expect(document.querySelector('.scene-stage')).not.toBeNull();
    expect(document.querySelector('.scene-stage-bg')).toBeNull();
    expect(document.querySelectorAll('.scene-sprite')).toHaveLength(0);
  });

  it('renders nothing when the scene is null', () => {
    render(() => <SceneStage scene={null} />);
    expect(document.querySelector('.scene-stage')).toBeNull();
  });

  it('collapses and expands via the toggle', () => {
    render(() => <SceneStage scene={scene} />);
    const toggle = screen.getByRole('button', { name: 'Collapse scene' });

    fireEvent.click(toggle);
    expect(document.querySelector('.scene-stage')!.classList.contains('collapsed')).toBe(true);
    expect(document.querySelector('.scene-stage-bg')).toBeNull();
    expect(document.querySelectorAll('.scene-sprite')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Expand scene' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand scene' }));
    expect(document.querySelector('.scene-stage')!.classList.contains('collapsed')).toBe(false);
    expect(document.querySelector('.scene-stage-bg')).not.toBeNull();
    expect(document.querySelectorAll('.scene-sprite')).toHaveLength(2);
  });
});
