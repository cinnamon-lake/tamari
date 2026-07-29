import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests } from '../helpers/llm.js';
import { setSetting } from '../helpers/settings.js';
import { App } from '../helpers/app.js';

/** The e2e webServer pins TAMARI_SECRET to this value (playwright.config.ts). */
const AUTH = { Authorization: 'Bearer e2e-test-secret' };

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Edge-path coverage for OpenAIBackendAdapter / MoonshotBackendAdapter.
//
// Deliberately NOT covered here (uncoverable without mock-server changes):
// - Reasoning-only ("Fireworks-style") streams that buffer reasoning_content
//   and flush it as message text (adapter ~253-256): the mock's `think:` mode
//   always emits content chunks after the reasoning chunks, and no selector
//   produces a zero-content stream. The reasoning-then-content flush is already
//   covered by generation-reasoning.spec.ts.
// - Tool-call argument JSON parse failure (adapter ~268-271): the mock's
//   parseToolSequence normalizes malformed `tool:name{INVALID` args to '{}',
//   so the arguments on the wire are always valid JSON.
// - Usage capture from the final stream chunk (adapter ~238-241): the mock's
//   /chat/completions chunks never carry a `usage` field.
// - The `prompt.responseFormat` branch (adapter ~81-83): nothing in the
//   production pipeline ever sets `Prompt.responseFormat` (only unit tests
//   construct it), and `responseFormat` is not a declared providerParams key,
//   so it cannot ride the config either. The test below therefore drives
//   `response_format` through the global `openai.params` settings blob, which
//   lands in the same params merge and on the wire.
test.describe('OpenAI backend edge paths', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await setSetting(page, 'openai.params', {});
    await resetBackendConfig(page);
  });

  test('sends response_format from the openai.params blob to the wire', async ({ page }) => {
    const app = new App(page);
    await setSetting(page, 'openai.params', { response_format: { type: 'json_object' } });
    await app.createCharacterAndChat({ name: uniqueName('RF Char'), firstMes: 'Ready.' });

    await app.sendUserMessage('respond: format acknowledged', { expectReply: true });
    expect(await app.lastAssistantText()).toBe('format acknowledged');

    const captured = await getLastLlmRequest();
    const body = captured.body as Record<string, unknown>;
    // The adapter's params merge (convertParamsToSnakeCase + fill-if-undefined)
    // carries response_format into the outgoing request body.
    expect(body['response_format']).toEqual({ type: 'json_object' });
  });

  test('maps a length finish reason and keeps the partial reply continuable', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('OA Length'), firstMes: 'Ready.' });

    // The mock reports finish_reason 'length'; canonicalFinishReason maps it to
    // 'length'. The partial text still renders; the affordance is the
    // per-message Continue action.
    await app.sendUserMessage('length:cut off', { expectReply: true });
    await app.waitForAssistantText('cut off');

    const bubble = app.lastBubble('assistant');
    await expect(bubble.locator('button[title="Continue"]')).toHaveCount(1);
  });

  test('lists models for the plain openai config (OpenAI listModels)', async ({ request }) => {
    const res = await request.get('/api/models', { headers: AUTH });
    expect(res.ok()).toBe(true);
    const data = (await res.json()) as { items: Array<{ id: string; name: string }> };
    const mock = data.items.find((m) => m.id === 'mock-model');
    expect(mock).toBeDefined();
    expect(mock!.name).toBe('mock-model');
  });

  test('moonshot parses an OpenAI-shaped model list', async ({ page, request }) => {
    await patchActiveBackendConfig(page, { backendProvider: 'moonshot', model: 'moonshot-mock' });

    const res = await request.get('/api/models', { headers: AUTH });
    expect(res.ok()).toBe(true);
    const data = (await res.json()) as { items: Array<{ id: string; name: string; contextLength?: number }> };
    const mock = data.items.find((m) => m.id === 'mock-model');
    expect(mock).toBeDefined();
    // context_length absent in the mock payload -> adapter default.
    expect(mock!.contextLength).toBe(131072);
  });

  test('moonshot falls back to the static model list when /models fails', async ({ page, request }) => {
    // Point the base URL at a path the mock 404s: GET /models then fails and
    // MoonshotBackendAdapter.listModels returns FALLBACK_MODELS.
    await patchActiveBackendConfig(page, {
      backendProvider: 'moonshot',
      model: 'moonshot-mock',
      apiUrl: `${MOCK_URL}/no-such-path`,
    });

    const res = await request.get('/api/models', { headers: AUTH });
    expect(res.ok()).toBe(true);
    const data = (await res.json()) as { items: Array<{ id: string }>; total: number };
    expect(data.total).toBe(14);
    expect(data.items.some((m) => m.id === 'kimi-k2.6')).toBe(true);
    expect(data.items.some((m) => m.id === 'moonshot-v1-auto')).toBe(true);
  });
});
