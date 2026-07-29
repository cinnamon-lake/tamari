/**
 * KoboldCpp backend adapter coverage (server/src/backends/KoboldCppBackendAdapter.ts).
 *
 * The mock LLM speaks the KoboldAI United dialect at
 * POST /api/extra/generate/stream (SSE {"token":"…"} chunks, a final
 * {"token":"","finish_reason"}) and POST /api/extra/abort, so these specs
 * drive real generations through the adapter and assert its request shaping
 * end to end:
 *   - flat `prompt` + `max_context_length` / `max_length` body shape, Bearer
 *     auth header,
 *   - Kobold-native sampler mapping (topP→top_p, repetitionPenalty→rep_pen,
 *     mirostat/tfs/typical/sampler_seed passthrough),
 *   - the Stop button halting a slow stream,
 *   - a `length` finish_reason mapped to a length finish (Continue affordance).
 *
 * Two wiring realities shape this spec (reported back, not "fixed" here —
 * e2e must not modify server/):
 *   1. Factory quirk: generationMode 'text' routes to TextCompletion BEFORE
 *      the koboldcpp branch (server/src/backends/factory.ts ~194), so the
 *      config keeps generationMode 'chat'.
 *   2. In chat mode PromptBuilder leaves prompt.text undefined (it only
 *      instruct-renders in 'text' mode), so the adapter's
 *      `prompt: prompt.text ?? ''` goes out EMPTY and the mock answers with
 *      its default response — flat-prompt selectors (respond:/slow:/length:)
 *      can't reach the mock through the chat pipeline. Tests that need a
 *      selector therefore install a providerParams.requestScript (the app's
 *      user-facing Lua request hook) that sets the outgoing body prompt —
 *      the adapter, its stream loop, abort path and finish mapping are still
 *      exercised end to end through the real stack.
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

/** The mock's reply when no prompt selector matches (fixtures/mockLlmServer.ts). */
const MOCK_DEFAULT_REPLY = 'deterministic mock response';

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

test.describe('KoboldCpp backend adapter', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    // Keep the mock URL/key + chat generation mode, switch provider to KoboldCpp.
    await patchActiveBackendConfig(page, {
      backendProvider: 'koboldcpp',
      model: '',
    });
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // The active config is shared across specs — undo this spec's mutations
    // (resetBackendConfig does not touch providerParams or the sampler knobs).
    await patchActiveBackendConfig(page, {
      providerParams: {},
      temperature: null,
      topP: null,
      topK: null,
      minP: null,
      repetitionPenalty: null,
    });
    await resetBackendConfig(page);
  });

  test('streams a reply and sends a Kobold-shaped request', async ({ page }) => {
    const app = new App(page);
    const charName = `Kobold Basic ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // Chat mode → prompt.text is undefined → the adapter sends prompt:'' and
    // the mock answers with its default text. The stream still flows through
    // the adapter's SSE loop (token chunks + final finish_reason).
    await app.sendUserMessage('respond: hello kobold', { expectReply: true });
    await app.waitForAssistantText(MOCK_DEFAULT_REPLY);

    const cap = await waitForRouteCapture('/api/extra/generate/stream');
    const body = cap.body;

    // Core KoboldCpp request shape from buildBody: a flat prompt string plus
    // the context/length knobs. NOTE: prompt is '' in chat mode (see header).
    expect(typeof body['prompt']).toBe('string');
    expect(body['messages']).toBeUndefined();
    expect(typeof body['max_context_length']).toBe('number');
    expect(body['max_context_length'] as number).toBeGreaterThan(0);
    expect(typeof body['max_length']).toBe('number');
    expect(body['max_length'] as number).toBeGreaterThan(0);

    // buildRequest adds Bearer auth when an api key is configured.
    expect(cap.headers['authorization']).toBe('Bearer mock-api-key');
  });

  test('maps sampler knobs to Kobold-native wire names', async ({ page }) => {
    // Typed knobs land in the koboldcpp.params blob (buildBackendSettings →
    // paramsKeyForProvider) and buildBody renames them; declared advanced
    // providerParams pass through under their wire names.
    await patchActiveBackendConfig(page, {
      temperature: 0.66,
      topP: 0.42,
      topK: 17,
      minP: 0.07,
      repetitionPenalty: 1.13,
      providerParams: {
        mirostat: 1,
        mirostat_tau: 3.5,
        mirostat_eta: 0.2,
        tfs: 0.9,
        typical: 0.8,
        sampler_seed: 1234,
      },
    });

    const app = new App(page);
    const charName = `Kobold Samplers ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    await app.sendUserMessage('respond: kobold samplers', { expectReply: true });
    await app.waitForAssistantText(MOCK_DEFAULT_REPLY);

    const cap = await waitForRouteCapture('/api/extra/generate/stream');
    const body = cap.body;

    // buildBody's paramMap: camelCase typed knobs → Kobold-native names.
    expect(body['temperature']).toBe(0.66);
    expect(body['top_p']).toBe(0.42);
    expect(body['top_k']).toBe(17);
    expect(body['min_p']).toBe(0.07);
    expect(body['rep_pen']).toBe(1.13);
    // Advanced providerParams keyed by wire name already.
    expect(body['mirostat']).toBe(1);
    expect(body['mirostat_tau']).toBe(3.5);
    expect(body['mirostat_eta']).toBe(0.2);
    expect(body['tfs']).toBe(0.9);
    expect(body['typical']).toBe(0.8);
    expect(body['sampler_seed']).toBe(1234);
  });

  test('stop button halts a slow stream', async ({ page }) => {
    // Inject the slow: selector into the outgoing prompt via the request
    // script — in chat mode the pipeline prompt is empty (see header), so the
    // mock would otherwise answer instantly and there'd be nothing to stop.
    await patchActiveBackendConfig(page, {
      providerParams: {
        requestScript:
          'request.body.prompt = "slow:150:a very long kobold reply that keeps streaming for a while"',
      },
    });

    const app = new App(page);
    const charName = `Kobold Abort ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // The mock streams one char per 150ms, so the reply takes several seconds —
    // long enough to click Stop mid-stream.
    await app.sendUserMessage('start the slow stream');

    // During streaming the send button swaps for a Stop button (btn-danger).
    const stopButton = page.locator('.message-input-area .send-btn.btn-danger');
    await expect(stopButton).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(1, { timeout: 10000 });
    await stopButton.click();

    // Generation halts: streaming marker clears and the send button returns.
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('.message-input-area .send-btn.btn-primary')).toBeVisible({ timeout: 10000 });

    // NOTE (verified by run): the adapter's POST /api/extra/abort notification
    // is NOT observable via the UI stop path. KoboldCppBackendAdapter.sendAbort
    // only fires from the signal.aborted check at the top of its stream loop —
    // but action.stop aborts the fetch signal while the adapter awaits
    // reader.read(), so the read rejects first and GenerationService's catch
    // path (broadcastGenerationAborted) handles the abort without sendAbort.
    // The halt above is the stable end-to-end contract.
  });

  test('maps a length finish_reason to a length finish', async ({ page }) => {
    // Inject the length: selector via the request script (see header).
    await patchActiveBackendConfig(page, {
      providerParams: {
        requestScript: 'request.body.prompt = "length:partial kobold reply"',
      },
    });

    const app = new App(page);
    const charName = `Kobold Length ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // The mock reports finish_reason "length"; canonicalFinishReason maps it to
    // 'length'. The partial text still renders; the client surfaces no finish
    // badge — the affordance is the per-message Continue action.
    await app.sendUserMessage('trigger the length finish', { expectReply: true });
    await app.waitForAssistantText('partial kobold reply');

    const bubble = app.lastBubble('assistant');
    await expect(bubble.locator('button[title="Continue"]')).toHaveCount(1);
  });
});
