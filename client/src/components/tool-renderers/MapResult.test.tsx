import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { MapResult } from './MapResult.js';

describe('MapResult', () => {
  // 3x2 map: grass grass water / forest(Darkwood) road void,
  // player at (1,0), fog over everything except (0,0), (1,0), (0,1).
  const validExtra = {
    renderType: 'map',
    map: {
      width: 3,
      height: 2,
      grid: [
        [{ t: 'grass' }, { t: 'grass' }, { t: 'water' }],
        [{ t: 'forest', l: 'Darkwood' }, { t: 'road' }, { t: 'void' }],
      ],
      player: { x: 1, y: 0 },
      explored: ['0,0', '1,0', '0,1'],
    },
  };

  function tiles(): NodeListOf<HTMLElement> {
    return document.querySelectorAll<HTMLElement>('.map-tile');
  }

  it('renders width × height tiles in a grid', () => {
    render(() => <MapResult content="Map created" extra={validExtra} />);
    expect(document.querySelector('.map-result')).not.toBeNull();
    expect(document.querySelector('.map-grid')).not.toBeNull();
    expect(tiles()).toHaveLength(6);
  });

  it('applies terrain classes and glyphs to explored tiles', () => {
    render(() => <MapResult content="Map created" extra={validExtra} />);
    const cells = tiles();
    expect(cells[0]!.className).toContain('map-tile-grass');
    expect(cells[0]!.querySelector('.map-tile-glyph')!.textContent).toBe('🌿');
    expect(cells[3]!.className).toContain('map-tile-forest');
    expect(cells[3]!.querySelector('.map-tile-glyph')!.textContent).toBe('🌲');
  });

  it('marks the player tile with the player class and marker glyph', () => {
    render(() => <MapResult content="Map created" extra={validExtra} />);
    const cells = tiles();
    expect(cells[1]!.className).toContain('map-tile-player');
    expect(cells[1]!.querySelector('.map-tile-glyph')!.textContent).toBe('📍');
    expect(document.querySelectorAll('.map-tile-player')).toHaveLength(1);
  });

  it('fogs unexplored tiles and hides their glyphs', () => {
    render(() => <MapResult content="Map created" extra={validExtra} />);
    const cells = tiles();
    // (2,0) water, (1,1) road, (2,1) void are unexplored.
    for (const index of [2, 4, 5]) {
      expect(cells[index]!.className).toContain('map-tile-fog');
      expect(cells[index]!.querySelector('.map-tile-glyph')).toBeNull();
    }
    expect(document.querySelectorAll('.map-tile-fog')).toHaveLength(3);
    // Explored tiles are not fogged.
    for (const index of [0, 1, 3]) {
      expect(cells[index]!.className).not.toContain('map-tile-fog');
    }
  });

  it('shows POI labels on labeled explored tiles', () => {
    render(() => <MapResult content="Map created" extra={validExtra} />);
    const label = document.querySelector('.map-tile-label');
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe('Darkwood');
    expect(label!.closest('.map-tile')!.className).toContain('map-tile-forest');
    expect(document.querySelectorAll('.map-tile-label')).toHaveLength(1);
  });

  it('falls back to the default block when the map payload is missing or malformed', () => {
    const cases: Array<Record<string, unknown>> = [
      { renderType: 'map' },
      { renderType: 'map', map: 'nope' },
      { renderType: 'map', map: { ...validExtra.map, grid: [[{ t: 'grass' }]] } },
      { renderType: 'map', map: { ...validExtra.map, player: { x: 9, y: 0 } } },
      {
        renderType: 'map',
        map: { ...validExtra.map, grid: validExtra.map.grid.map((row) => row.map((tile) => ({ ...tile, t: 'lava' }))) },
      },
      { renderType: 'map', map: { ...validExtra.map, explored: 42 } },
    ];
    for (const extra of cases) {
      const { unmount } = render(() => <MapResult content="Map created" extra={extra} />);
      expect(document.querySelector('.map-grid')).toBeNull();
      expect(screen.getByText('Map created')).toBeInTheDocument();
      unmount();
    }
  });
});
