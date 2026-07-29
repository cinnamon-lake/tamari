import { test, expect, type Page } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Minimal 1x1 transparent PNG in base64
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Upload a 1px PNG via the attachments route; returns the new attachment id. */
async function uploadPngAttachment(page: Page): Promise<string> {
  return await page.evaluate(async (base64) => {
    const token = localStorage.getItem('st_auth_token') ?? '';
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mimeType: 'image/png', data: base64 }),
    });
    if (!res.ok) throw new Error(`Attachment upload failed: ${res.status}`);
    const attachment = (await res.json()) as { id: string };
    return attachment.id;
  }, PNG_BASE64);
}

test.describe('Scene Stage', () => {
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

  test('scene_set renders the stage panel and an inline scene chip', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'scene');
    const attachmentId = await uploadPngAttachment(page);

    await app.createCharacterAndChat({
      name: uniqueName('Scene Host'),
      firstMes: 'The tavern is quiet tonight.',
    });

    // scene_set declares no `endsTurn`: the mock walks the `tool:` sequence,
    // then its plain-text round streams the actual reply. The tool result part
    // carries extra.renderType = "scene" plus the resolved scene, so the client
    // derives the stage from the branch's messages and hydrates the chip inline.
    await app.sendUserMessage(
      `tool:scene_set{"background":{"source":"attachment","id":"${attachmentId}"},"caption":"The Tavern"}`,
    );

    const assistantBubble = app.lastBubble('assistant');
    const chip = assistantBubble.locator('.message-content .scene-chip');
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toContainText('The Tavern');
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });
    // No generic server-rendered block for the renderType part.
    await expect(assistantBubble.locator('.tool-result-block')).toHaveCount(0);

    const stage = page.locator('.scene-stage');
    await expect(stage).toBeVisible();
    await expect(stage.locator('.scene-stage-bg')).toHaveAttribute('src', `/api/attachments/${attachmentId}`);
    // Regression: the image must actually load — Express's sendFile used to 404
    // on dataDir paths containing a dot segment (like server/.test-data).
    await expect
      .poll(async () => stage.locator('.scene-stage-bg').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);

    await expectNoAxeViolations(page);

    // The collapse toggle hides the stage imagery.
    await stage.locator('.scene-stage-toggle').click();
    await expect(stage.locator('.scene-stage-bg')).toHaveCount(0);
    await stage.locator('.scene-stage-toggle').click();
    await expect(stage.locator('.scene-stage-bg')).toHaveAttribute('src', `/api/attachments/${attachmentId}`);
  });
});
