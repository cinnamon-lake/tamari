import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { setSetting, getActiveBackendConfigId } from '../helpers/settings.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** Message ids are global (not per-chat); bubbles carry the id as their DOM id. */
async function bubbleMessageId(locator: any): Promise<number> {
  const id = Number(await locator.getAttribute('id'));
  expect(id).toBeGreaterThan(0);
  return id;
}

test.describe('Memory Tools', () => {
  let toolsetId: string | undefined;

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // Memory settings persist on the shared e2e server — reset them so a bogus
    // backendConfigId (or an enabled flag) can't leak into later specs. A
    // partial object is fine: the schema defaults fill the rest.
    await setSetting(page, 'memory', { enabled: false });
    // The flat legacy connection fields are only used by MemoryService's
    // fallback path — restore their schema defaults too.
    await setSetting(page, 'apiUrl', null);
    await setSetting(page, 'apiKey', null);
    await setSetting(page, 'model', '');
    await resetBackendConfig(page);
    if (toolsetId) {
      await deleteToolset(page, toolsetId);
      toolsetId = undefined;
    }
  });

  test('memory_get_raw returns the raw text of cited messages', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'memory');
    const greeting = `MemTool greeting ${Date.now()}`;
    await app.createCharacterAndChat({ name: uniqueName('MemTool Char'), firstMes: greeting });

    await app.sendUserMessage('seq: first', { expectReply: true });
    await app.sendUserMessage('seq: second', { expectReply: true });

    const greetingId = await bubbleMessageId(page.locator('.message-bubble').first());

    await app.sendUserMessage(`tool:memory_get_raw{"messageIds":[${greetingId}]}`, { expectReply: true });

    // The tool result block renders `[msg:<id>] assistant: <greeting>`.
    const resultBlock = app.lastBubble('assistant').locator('.tool-result-block').first();
    await expect(resultBlock).toBeVisible({ timeout: 10000 });
    await expect(resultBlock).toContainText(`[msg:${greetingId}]`);
    await expect(resultBlock).toContainText(greeting);
  });

  test('memory_summarize_range triggers a second generation for the summary', async ({ page }) => {
    const app = new App(page);
    // The memory toolset's own config schema is empty (no backendConfigId
    // field) — the summarization backend comes from the memory SETTINGS'
    // backendConfigId. Point it at the active config (already wired to the
    // mock by configureMockBackend).
    await setSetting(page, 'memory', { enabled: false, backendConfigId: await getActiveBackendConfigId(page) });
    toolsetId = await enableBuiltinToolset(page, 'memory');
    await app.createCharacterAndChat({ name: uniqueName('MemSum Char'), firstMes: 'MemSum greeting.' });

    const userBubble = await app.sendUserMessage('seq: one', { expectReply: true });
    const startId = await bubbleMessageId(page.locator('.message-bubble').first());
    const endId = await bubbleMessageId(userBubble);

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage(`tool:memory_summarize_range{"startMessageId":${startId},"endMessageId":${endId}}`, {
      expectReply: true,
    });

    // The turn costs THREE mock generations: tool-call round 1, the
    // summarization backend call inside the tool, and the final answer round.
    // Counting proves the summary generation actually happened.
    const cap = await waitForNextLlmRequest(before + 2);
    expect(cap.count).toBeGreaterThanOrEqual(before + 3);

    // The summarization prompt carries no selector, so the mock's default text
    // comes back as the summary and lands in the tool result block.
    const resultBlock = app.lastBubble('assistant').locator('.tool-result-block').first();
    await expect(resultBlock).toContainText('deterministic mock response', { timeout: 10000 });
  });

  test('memory summarization falls back to the active backend when the configured one is missing', async ({ page }) => {
    const app = new App(page);
    // The memory toolset's own config schema is empty (no backendConfigId
    // field) — the summarization backend comes from the memory SETTINGS'
    // backendConfigId. Point it at a bogus id: MemoryService.resolveBackend
    // logs and falls back. Note the fallback is buildBackendSettings(allSettings, null)
    // — the FLAT legacy connection settings, not the active BackendConfig
    // entity — so point those at the mock too.
    await setSetting(page, 'memory', { enabled: false, backendConfigId: `bogus-config-${Date.now()}` });
    await setSetting(page, 'apiUrl', process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876');
    await setSetting(page, 'apiKey', 'mock-api-key');
    await setSetting(page, 'model', 'mock-model');
    toolsetId = await enableBuiltinToolset(page, 'memory');
    await app.createCharacterAndChat({ name: uniqueName('MemFallback Char'), firstMes: 'Fallback greeting.' });

    const userBubble = await app.sendUserMessage('seq: fallback', { expectReply: true });
    const startId = await bubbleMessageId(page.locator('.message-bubble').first());
    const endId = await bubbleMessageId(userBubble);

    await app.sendUserMessage(`tool:memory_summarize_range{"startMessageId":${startId},"endMessageId":${endId}}`, {
      expectReply: true,
    });

    // Fallback reached the mock: its default text came back as the summary.
    const resultBlock = app.lastBubble('assistant').locator('.tool-result-block').first();
    await expect(resultBlock).toContainText('deterministic mock response', { timeout: 10000 });
  });
});
