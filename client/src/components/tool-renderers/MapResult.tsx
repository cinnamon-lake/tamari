import { For, Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { ToolResultProps } from './index.js';
import { useI18n } from '../../i18n/index.js';
import './MapResult.css';

const TERRAIN_GLYPHS: Record<string, string> = {
  grass: '🌿',
  forest: '🌲',
  water: '🌊',
  mountain: '⛰️',
  wall: '🧱',
  road: '🛤️',
  door: '🚪',
  town: '🏘️',
  dungeon: '🕳️',
  void: '⬛',
};

const PLAYER_GLYPH = '📍';

interface MapTile {
  t: string;
  l?: string;
}

interface ParsedMap {
  width: number;
  height: number;
  grid: MapTile[][];
  player: { x: number; y: number };
  explored: Set<string>;
}

interface MapCell {
  x: number;
  y: number;
  tile: MapTile;
}

// Validate at render time: the payload must be a complete, well-formed map
// (matching grid dimensions, in-bounds player, palette terrains). Anything
// malformed falls back to the default block.
function parseMap(raw: unknown): ParsedMap | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const { width, height, grid, player, explored } = m;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > 40) return null;
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 1 || height > 40) return null;
  if (!Array.isArray(grid) || grid.length !== height) return null;
  const parsedGrid: MapTile[][] = [];
  for (const row of grid) {
    if (!Array.isArray(row) || row.length !== width) return null;
    const parsedRow: MapTile[] = [];
    for (const cell of row) {
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return null;
      const c = cell as Record<string, unknown>;
      if (typeof c.t !== 'string' || !(c.t in TERRAIN_GLYPHS)) return null;
      const tile: MapTile = { t: c.t };
      if (c.l !== undefined) {
        if (typeof c.l !== 'string') return null;
        if (c.l !== '') tile.l = c.l;
      }
      parsedRow.push(tile);
    }
    parsedGrid.push(parsedRow);
  }
  if (!player || typeof player !== 'object' || Array.isArray(player)) return null;
  const p = player as Record<string, unknown>;
  if (typeof p.x !== 'number' || !Number.isInteger(p.x) || typeof p.y !== 'number' || !Number.isInteger(p.y)) {
    return null;
  }
  if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return null;
  // Explored arrives as a list of "x,y" keys; tolerate the object-set form too.
  const exploredSet = new Set<string>();
  if (Array.isArray(explored)) {
    for (const key of explored) {
      if (typeof key !== 'string') return null;
      exploredSet.add(key);
    }
  } else if (explored && typeof explored === 'object') {
    for (const key of Object.keys(explored)) {
      exploredSet.add(key);
    }
  } else if (explored !== undefined && explored !== null) {
    return null;
  }
  return { width, height, grid: parsedGrid, player: { x: p.x, y: p.y }, explored: exploredSet };
}

export const MapResult: Component<ToolResultProps> = (props) => {
  const { t } = useI18n();

  const map = () => parseMap(props.extra?.map);

  const cells = (): MapCell[] => {
    const m = map();
    if (!m) return [];
    const out: MapCell[] = [];
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        out.push({ x, y, tile: m.grid[y]![x]! });
      }
    }
    return out;
  };

  return (
    <Show
      when={map()}
      fallback={
        <div class={`tool-result-block${props.isError ? ' error' : ''}`}>
          <div class="tool-result-header">
            <i class={`bi ${props.isError ? 'bi-exclamation-triangle' : 'bi-check-circle'}`} />
            {props.isError ? t('tools.error') : t('tools.result')}
          </div>
          <div class="tool-result-content">{props.content}</div>
        </div>
      }
    >
      {(m) => (
        <div class="map-result">
          <div
            class="map-grid"
            role="img"
            aria-label={t('tools.mapAriaLabel')}
            style={{ '--map-cols': String(m().width) }}
          >
            <For each={cells()}>
              {(cell) => {
                const fogged = !m().explored.has(`${cell.x},${cell.y}`);
                const isPlayer = m().player.x === cell.x && m().player.y === cell.y;
                return (
                  <div
                    class={`map-tile map-tile-${cell.tile.t}${fogged ? ' map-tile-fog' : ''}${isPlayer ? ' map-tile-player' : ''}`}
                    title={cell.tile.l}
                  >
                    <Show when={!fogged}>
                      <span class="map-tile-glyph">{isPlayer ? PLAYER_GLYPH : TERRAIN_GLYPHS[cell.tile.t]}</span>
                    </Show>
                    <Show when={!fogged && cell.tile.l}>
                      <span class="map-tile-label">{cell.tile.l}</span>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
};
