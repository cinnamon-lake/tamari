/**
 * Sampler wiring journey.
 *
 * End-to-end proof that advanced sampler knobs set on a backend config actually
 * reach the outgoing LLM request body — the integration contract of
 * `buildBackendSettings` (typed knobs + providerParams merged
 * into the provider's `*.params` blob) + the factory handing them to the
 * adapter. The unit tests cover the modal's save path; this journey covers the
 * full config → generate → request-body path and that the UI renders the saved
 * knobs from the active config.
 *
 * The request to the LLM is made by the tamari server (not the browser),
 * so `page.route` cannot see it. Instead the deterministic mock LLM captures
 * every /chat/completions body and exposes it at GET /last-request, which the
 * journey reads to assert `temperature` and `seed` landed.
 */
import { journeyTest as test, expect } from '../../fixtures/journey.js';
import { patchActiveBackendConfig } from '../../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../../helpers/llm.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

async function openBackendConfigModal(page: import('@playwright/test').Page) {
  const btn = page.locator('button.settings-btn:has-text("Backend Config")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = page.locator('.modal.settings-modal').filter({ hasText: 'Backend Config' });
  await expect(modal).toBeVisible();
  return modal;
}

async function closeBackendConfigModal(page: import('@playwright/test').Page) {
  await page
    .locator('.modal-overlay:has(.modal.settings-modal:has-text("Backend Config"))')
    .click({ position: { x: 0, y: 0 } });
  await expect(
    page.locator('.modal.settings-modal').filter({ hasText: 'Backend Config' }),
  ).not.toBeVisible();
}

test.describe('Sampler wiring journey', () => {
  test.beforeEach(async () => {
    // One mock server is shared across the whole suite (workers: 1); reset the
    // captured-request state so this spec's count assertions start from zero.
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // The shared e2e server persists backend config across specs. Clear the
    // sampler knobs we set so they don't leak into the next spec's generations.
    await patchActiveBackendConfig(page, { temperature: 1, providerParams: {} }).catch(() => {
      /* no active config / not logged in — nothing to clean */
    });
  });

  test('advanced sampler knobs render in the UI and reach the LLM request body', async ({ app, page }) => {
    const charName = uniqueName('Sampler');
    await app.createCharacterAndChat({
      name: charName,
      description: 'A character for the sampler wiring journey.',
      firstMes: `I am ${charName}.`,
    });

    await test.step('set a typed knob (temperature) and an advanced providerParams knob (seed)', async () => {
      // WS-direct: deterministic, no UI debounce. providerParams is replaced
      // wholesale, so this also clears any stale keys.
      await patchActiveBackendConfig(page, {
        temperature: 0.42,
        providerParams: { seed: 12345 },
      });
    });

    await test.step('the UI renders the saved knobs from the active config', async () => {
      const modal = await openBackendConfigModal(page);
      // Typed knob lives in the main Sampling section.
      await expect(modal.locator('#sampler-temperature')).toHaveValue('0.42');
      // Advanced knob lives behind the collapsed <details>; expand it first.
      await modal.locator('summary:has-text("Advanced Sampling")').click();
      await expect(modal.locator('#sampler-seed')).toHaveValue('12345');
      await closeBackendConfigModal(page);
    });

    await test.step('generation sends both knobs to the mock LLM', async () => {
      const before = (await getLastLlmRequest()).count;
      await app.sendUserMessage('tell me about sampling', { expectReply: true });
      const captured = await waitForNextLlmRequest(before);
      const body = captured.body as Record<string, unknown>;
      expect(body.temperature).toBe(0.42);
      expect(body.seed).toBe(12345);
    });

    await test.step('changing the seed flows through on the next generation', async () => {
      await patchActiveBackendConfig(page, { providerParams: { seed: 999 } });
      const before = (await getLastLlmRequest()).count;
      await app.sendUserMessage('one more turn', { expectReply: true });
      const captured = await waitForNextLlmRequest(before);
      expect((captured.body as Record<string, unknown>).seed).toBe(999);
    });

    await test.step('a disabled sampler is omitted from the request while its value is kept', async () => {
      // The "Opus 4.6 broke top_k" scenario: top_k has a value (40) but is
      // flagged disabled, so it must NOT be sent.
      await patchActiveBackendConfig(page, {
        topK: 40,
        providerParams: { samplerDisabled: { topK: true } },
      });
      const before = (await getLastLlmRequest()).count;
      await app.sendUserMessage('hold the top_k', { expectReply: true });
      const captured = await waitForNextLlmRequest(before);
      const body = captured.body as Record<string, unknown>;
      expect(body.temperature).toBeDefined(); // enabled knob still sent
      expect(body.top_k).toBeUndefined(); // disabled → omitted
      expect(body.topK).toBeUndefined();
    });
  });
});
