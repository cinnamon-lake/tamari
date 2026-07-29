/**
 * LlamaCpp backend adapter coverage (server/src/backends/LlamaCppBackendAdapter.ts).
 *
 * The mock LLM speaks the llama.cpp native dialect at POST /completion
 * (SSE {content, stop:false} deltas, a final stop chunk with stopped_eos /
 * stopped_limit + tokens_evaluated / tokens_predicted, then [DONE]), so these
 * specs drive real generations through the adapter and assert its request
 * shaping end to end:
 *   - flat `prompt` string, `stream: true`, numeric `n_predict`,
 *   - the final chunk's token counts flowing into usage (adapter-reported
 *     completion tokens, observable via the /api/stats aggregate),
 *   - OpenAI-style logitBias object → llama.cpp `logit_bias` [[id, bias]] pairs,
 *   - stopped_limit → 'length' finish mapping (Continue affordance),
 *   - listModels parsing the OpenAI-shaped GET /models.
 *
 * Assertions use the mock's generic capture
 * (GET /last-request?route=<prefix>), which records the LAST request per route
 * with body + headers.
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';

/** The e2e webServer pins TAMARI_SECRET to this value (playwright.config.ts). */
const AUTH = { Authorization: 'Bearer e2e-test-secret' };

interface RouteCapture {
  route: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** The mock's generic capture: last POST whose route starts with the prefix, headers included. */
async function getRouteCapture(routePrefix: string): Promise<RouteCapture | null> {
  const res = await fetch(`${MOCK_URL}/last-request?route=${encodeURIComponent(routePrefix)}`);
  if (!res.ok) throw new Error(`mock /last-request?route= failed: HTTP ${res.status}`);
  return (await res.json()) as RouteCapture | null;
}

/** Poll until at least one request for the route has been captured. */
async function waitForRouteCapture(routePrefix: string, timeout = 10000): Promise<RouteCapture> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const cap = await getRouteCapture(routePrefix);
    if (cap) return cap;
    if (Date.now() >= deadline) {
      throw new Error(`no mock request captured for route ${routePrefix} within ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.describe('LlamaCpp backend adapter', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    // Keep the mock URL/key + model, switch provider to llama.cpp native.
    // generationMode 'text' is the UI's own pairing for llamacpp (and makes
    // PromptBuilder render the flat instruct prompt the adapter sends);
    // the factory's llamacpp branch precedes its generic text-mode branch.
    await patchActiveBackendConfig(page, {
      backendProvider: 'llamacpp',
      generationMode: 'text',
    });
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // The active config is shared across specs — undo this spec's mutations
    // (logitBias is not reset by resetBackendConfig).
    await patchActiveBackendConfig(page, { logitBias: null });
    await resetBackendConfig(page);
  });

  test('streams a basic reply and sends a llama.cpp-shaped request', async ({ page }) => {
    const app = new App(page);
    const charName = `Llama Basic ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    await app.sendUserMessage('respond: hello llama', { expectReply: true });
    await app.waitForAssistantText('hello llama');

    const cap = await waitForRouteCapture('/completion');
    const body = cap.body;

    // Core llama.cpp request shape from buildRequest: flat prompt, stream flag,
    // n_predict from the completion token budget.
    expect(typeof body['prompt']).toBe('string');
    expect(body['prompt'] as string).toContain('respond: hello llama');
    expect(body['messages']).toBeUndefined();
    expect(body['stream']).toBe(true);
    expect(typeof body['n_predict']).toBe('number');
    expect(body['n_predict'] as number).toBeGreaterThan(0);
  });

  test('reports adapter token counts into usage', async ({ page, request }) => {
    const app = new App(page);
    const charName = `Llama Usage ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // The mock's final chunk reports tokens_predicted = reply char count (11)
    // and tokens_evaluated = 50; the adapter prefers these over its own chunk
    // count and returns them as usage. Usage itself is internal — it lands on
    // the generations table (GenerationService) and is surfaced only through
    // the /api/stats aggregate (the message extra carries a client-counted
    // tokenCount instead) — so assert the aggregate moved past the reported
    // count. NOTE: /api/stats caches for 30s; this is the only /api/stats call
    // in this spec file, so the read is a fresh compute.
    await app.sendUserMessage('respond: hello llama', { expectReply: true });
    await app.waitForAssistantText('hello llama');

    const res = await request.get('/api/stats', { headers: AUTH });
    expect(res.ok()).toBe(true);
    const stats = (await res.json()) as { totalCompletionTokens: number; totalGenerations: number };
    expect(stats.totalGenerations).toBeGreaterThanOrEqual(1);
    // 'hello llama'.length === 11; earlier specs in the run only add more.
    expect(stats.totalCompletionTokens).toBeGreaterThanOrEqual(11);
  });

  test('converts an OpenAI-style logitBias object to llama.cpp pairs', async ({ page }) => {
    // buildBackendSettings merges the config's logitBias into textgen.params
    // (the blob the llamacpp factory branch consumes); the adapter converts the
    // {tokenId: bias} object to [[tokenId, bias]] and camelToSnake renames the
    // key to logit_bias.
    await patchActiveBackendConfig(page, {
      logitBias: { '123': -5 },
    });

    const app = new App(page);
    const charName = `Llama LogitBias ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    await app.sendUserMessage('respond: llama logit bias', { expectReply: true });
    await app.waitForAssistantText('llama logit bias');

    const cap = await waitForRouteCapture('/completion');
    expect(cap.body['logit_bias']).toEqual([[123, -5]]);
  });

  test('maps a stopped_limit final chunk to a length finish', async ({ page }) => {
    const app = new App(page);
    const charName = `Llama Length ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // The mock reports stopped_limit: true; the adapter maps it to a 'length'
    // finish. The partial text still renders; the client surfaces no finish
    // badge — the affordance is the per-message Continue action.
    await app.sendUserMessage('length:partial llama reply', { expectReply: true });
    await app.waitForAssistantText('partial llama reply');

    const bubble = app.lastBubble('assistant');
    await expect(bubble.locator('button[title="Continue"]')).toHaveCount(1);
  });

  test('lists models via the OpenAI-shaped GET /models', async ({ request }) => {
    // LlamaCppBackendAdapter.listModels fetches {base}/models and parses the
    // OpenAI model-list shape — the mock's default /models response works.
    const res = await request.get('/api/models', { headers: AUTH });
    expect(res.ok()).toBe(true);
    const data = (await res.json()) as { items: Array<{ id: string; name: string }> };
    const mock = data.items.find((m) => m.id === 'mock-model');
    expect(mock).toBeDefined();
    expect(mock!.name).toBe('mock-model');
  });
});
