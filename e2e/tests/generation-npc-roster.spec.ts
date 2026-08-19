import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('NPC Roster Widget', () => {
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

  test('renders npc_register as a roster card and promote creates a character', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'lua_npc_registry');

    await app.createCharacterAndChat({
      name: uniqueName('Roster Host'),
      firstMes: 'The tavern is quiet tonight.',
    });

    // Unique NPC name per attempt: characters persist on the shared e2e server
    // across retries, and a hardcoded name would leave the promote button
    // permanently in its "Promoted" state after the first successful create.
    const npcName = uniqueName('Marta');

    // npc_register declares no `endsTurn`: the mock walks the `tool:` sequence,
    // then its plain-text round streams the actual reply. The tool result part
    // carries extra.renderType = "npc_roster" plus the full registry, so the
    // client hydrates the interactive roster inline in the parts flow.
    await app.sendUserMessage(
      `tool:npc_register{"name":"${npcName}","description":"Innkeeper","personality":"Gruff"}`,
    );

    const assistantBubble = app.lastBubble('assistant');
    const roster = assistantBubble.locator('.message-content .npc-roster');
    await expect(roster).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });
    await expect(roster.locator('.npc-roster-item')).toHaveCount(1);
    await expect(roster.locator('.npc-roster-name')).toHaveText(npcName);
    await expect(roster.locator('.npc-roster-field')).toHaveText(['Innkeeper', 'Gruff']);
    // No generic server-rendered block for the renderType part, and the raw
    // tool-call block (JSON args) is suppressed — the widget represents the call.
    await expect(assistantBubble.locator('.tool-result-block')).toHaveCount(0);
    await expect(assistantBubble.locator('.tool-call-block')).toHaveCount(0);

    await expectNoAxeViolations(page);

    // Promote sends character.create; the server rebroadcasts character.listed
    // and the NPC appears in the sidebar character list.
    const promoteBtn = roster.locator('.npc-promote-btn');
    await expect(promoteBtn).toBeEnabled();
    await expect(promoteBtn).toHaveText('Promote to character');
    await promoteBtn.click();

    await page.locator('input[placeholder="Search characters..."]').fill(npcName);
    await expect(page.locator('.character-list li', { hasText: npcName })).toBeVisible({ timeout: 10000 });

    // Once the character exists, the roster button flips to the promoted state.
    await expect(promoteBtn).toBeDisabled();
    await expect(promoteBtn).toHaveText('Promoted');
  });
});
