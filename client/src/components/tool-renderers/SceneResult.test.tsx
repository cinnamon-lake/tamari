import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { SceneResult } from './SceneResult.js';

describe('SceneResult', () => {
  it('renders the scene caption when present', () => {
    render(() => <SceneResult content="" extra={{ scene: { caption: 'The tavern' } }} />);
    expect(screen.getByText('The tavern')).toBeInTheDocument();
    expect(document.querySelector('.scene-chip')).toBeInTheDocument();
  });

  it('falls back to the generic label without a scene', () => {
    render(() => <SceneResult content="" />);
    expect(screen.getByText('Scene changed')).toBeInTheDocument();
  });

  it('falls back when the caption is empty or not a string', () => {
    render(() => <SceneResult content="" extra={{ scene: { caption: '' } }} />);
    expect(screen.getByText('Scene changed')).toBeInTheDocument();
  });

  it('falls back when scene is not a plain object', () => {
    render(() => <SceneResult content="" extra={{ scene: ['not', 'an', 'object'] }} />);
    expect(screen.getByText('Scene changed')).toBeInTheDocument();
  });
});
