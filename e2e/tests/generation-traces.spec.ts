import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe.configure({ mode: 'serial' });

test.describe('Generation traces modal', () => {
  const toolsetIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    while (toolsetIds.length > 0) {
      await deleteToolset(page, toolsetIds.pop()!);
    }
  });

  async function openTraces(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('.chat-header-menu button.icon-btn').click();
    await page.locator('.dropdown-item', { hasText: 'Generation traces' }).click();
    await expect(page.locator('.generation-traces-modal')).toBeVisible();
  }

  async function closeTraces(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('.generation-traces-close-btn').click();
    await expect(page.locator('.generation-traces-modal')).not.toBeVisible();
  }

  test('send row shows ok; a run_agent turn nests a sub-agent row under its parent', async ({ page }) => {
    const app = new App(page);
    toolsetIds.push(await enableBuiltinToolset(page, 'agent'));
    await app.createCharacterAndChat({ name: uniqueName('Trace Viewer'), firstMes: 'Ready.' });

    // One plain turn → a 'send' record.
    await app.sendUserMessage('respond: hello trace', { expectReply: true });

    await openTraces(page);
    const sendRow = page.locator('.generation-trace-line', { hasText: 'send' }).first();
    await expect(sendRow).toBeVisible();
    await expect(sendRow.locator('.generation-trace-status')).toHaveClass(/bi-check-circle-fill/);
    await expect(sendRow.locator('.generation-trace-backend')).toHaveText('openai');
    await closeTraces(page);

    // A sub-agent turn → a nested 'subagent' record under the parent's send row.
    await app.sendUserMessage(`tool:run_agent${JSON.stringify({ prompt: 'respond: sub reply' })}`, {
      expectReply: true,
      userText: 'run_agent',
    });
    await expect(app.lastBubble('assistant').locator('.tool-result-block').last()).toContainText('sub reply', {
      timeout: 15000,
    });

    await openTraces(page);
    const child = page.locator('.generation-trace-child', { hasText: 'sub-agent' });
    await expect(child).toBeVisible();
    await expect(child.locator('.generation-trace-child-marker')).toHaveText('↳');
    await expect(child.locator('.generation-trace-status')).toHaveClass(/bi-check-circle-fill/);
    // The child sits under the parent's row, which carries the tool call name.
    const parentRow = child.locator('xpath=..');
    await expect(parentRow.locator('.generation-trace-line', { hasText: 'send' }).first()).toBeVisible();
    await expect(parentRow).toContainText('run_agent');
    await closeTraces(page);
  });
});
