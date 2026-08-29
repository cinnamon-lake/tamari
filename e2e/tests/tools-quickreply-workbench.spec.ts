import { smokeTest as test, expect } from '../fixtures/smoke.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { uniqueName } from '../helpers/names.js';

test.describe('Quick Reply Workbench Tools', () => {
  let toolsetId: string | undefined;

  test.afterEach(async ({ page }) => {
    if (toolsetId) {
      await deleteToolset(page, toolsetId);
      toolsetId = undefined;
    }
  });

  test('quick reply write + scoped ls, and the button appears in the quick reply bar', async ({ page, app }) => {
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('QR Host'),
      firstMes: 'Ready.',
    });

    const label = uniqueName('Tool QR');
    // `_` is the global scope's scopeId; the scoped collection IS listable.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: '/quickreplies/global/_/new.json',
        content: JSON.stringify({ label, script: "return 'hi'" }),
      })},ls${JSON.stringify({ path: '/quickreplies/global/_/' })}`,
      { expectReply: true, userText: 'write' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });
    await expect(results.first()).toContainText(`"label": "${label}"`);
    await expect(results.first()).toContainText('"path": "/quickreplies/global/_/');
    await expect(results.last()).toContainText(label);

    // The quickreply.created broadcast lands; the button renders in the bar.
    await expect(page.locator('.quick-reply-bar .quick-reply-btn .qr-label', { hasText: label })).toBeVisible({
      timeout: 10000,
    });
  });
});
