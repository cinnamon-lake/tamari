import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Map Widget', () => {
  let toolsetId: string | undefined;

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    if (toolsetId) {
      await deleteToolset(page, toolsetId);
      toolsetId = undefined;
    }
  });

  test('renders map mutations as an interactive tile grid with fog and a player marker', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'lua_map');

    await app.createCharacterAndChat({
      name: uniqueName('Map Host'),
      firstMes: 'The road stretches out before the party.',
    });

    // The mock walks the `tool:` sequence one call per generation round:
    // map_create (8x6), map_set_tile (forest POI), then map_move east —
    // each round sees the previous round's `_toolState` snapshot. When the
    // sequence is exhausted the mock answers with plain text.
    await app.sendUserMessage(
      'tool:map_create{"width":8,"height":6},map_set_tile{"x":3,"y":2,"terrain":"forest","label":"Darkwood"},map_move{"direction":"east"}',
    );

    const assistantBubble = app.lastBubble('assistant');
    const grids = assistantBubble.locator('.message-content .map-grid');
    await expect(grids.last()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });

    // All three mutations emitted a map payload, so three widgets render
    // inline (one per tool result part); the last carries the final state.
    await expect(grids).toHaveCount(3);
    const grid = grids.last();

    // 8 × 6 tiles, row-major: (x,y) is tile index y*8 + x.
    const tiles = grid.locator('.map-tile');
    await expect(tiles).toHaveCount(48);

    // The forest POI at (3,2) is explored after the move: glyph + label show.
    const forest = tiles.nth(2 * 8 + 3);
    await expect(forest).toHaveClass(/map-tile-forest/);
    await expect(forest).not.toHaveClass(/map-tile-fog/);
    await expect(forest.locator('.map-tile-glyph')).toHaveText('🌲');
    await expect(forest.locator('.map-tile-label')).toHaveText('Darkwood');

    // The player marker sits at (1,0) after map_move east from (0,0).
    const playerTile = tiles.nth(1);
    await expect(playerTile).toHaveClass(/map-tile-player/);
    await expect(playerTile.locator('.map-tile-glyph')).toHaveText('📍');
    await expect(grid.locator('.map-tile-player')).toHaveCount(1);

    // Far tiles stay under fog of war: (7,5) was never revealed.
    const farTile = tiles.nth(5 * 8 + 7);
    await expect(farTile).toHaveClass(/map-tile-fog/);
    await expect(farTile.locator('.map-tile-glyph')).toHaveCount(0);

    // No generic server-rendered block for the renderType parts, and the raw
    // tool-call blocks (JSON args) are suppressed — the widgets represent them.
    await expect(assistantBubble.locator('.tool-result-block')).toHaveCount(0);
    await expect(assistantBubble.locator('.tool-call-block')).toHaveCount(0);

    await expectNoAxeViolations(page);
  });
});
