/**
 * OpenRouter backend adapter coverage (server/src/backends/OpenRouterBackendAdapter.ts).
 *
 * The adapter extends the OpenAI adapter, so generation against the mock LLM
 * stays a plain POST /chat/completions — no mock changes needed. These specs
 * assert the OpenRouter-specific request shaping end to end:
 *   - basic streaming reply (inherited OpenAI streaming + the OpenRouter
 *     stream-chunk schema passthrough),
 *   - HTTP-Referer / X-Title headers added in buildRequest,
 *   - reasoning { effort, summary } body block from openrouter.* settings,
 *   - provider routing (provider.order / allow_fallbacks),
 *   - Claude cache_control breakpoints injected for anthropic/claude* models,
 *   - transforms / plugins only present in the body when configured.
 *
 * Assertions are made against the mock's captured request (GET /last-request
 * for the body, GET /last-request?route=/chat/completions for the headers).
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { setSetting } from '../helpers/settings.js';
import { App } from '../helpers/app.js';

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';

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

/** Settings this spec mutates, with their schema defaults — restored in afterEach. */
const TOUCHED_SETTINGS: Array<[string, unknown]> = [
  ['openrouter.reasoningEffort', ''],
  ['openrouter.reasoningSummary', ''],
  ['openrouter.allowFallbacks', true],
  ['openrouter.transforms', []],
  ['openrouter.plugins', []],
];

test.describe('OpenRouter backend adapter', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    // Keep the mock URL/key, switch the provider + model to OpenRouter/Claude.
    await patchActiveBackendConfig(page, {
      backendProvider: 'openrouter',
      model: 'anthropic/claude-mock',
    });
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    for (const [key, defaultValue] of TOUCHED_SETTINGS) {
      await setSetting(page, key, defaultValue);
    }
    await patchActiveBackendConfig(page, { providerParams: {}, openrouterProvider: null });
    await resetBackendConfig(page);
  });

  test('streams a basic reply and sends OpenRouter headers', async ({ page }) => {
    const app = new App(page);
    const charName = `OR Basic ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond: hi from openrouter', { expectReply: true });
    await app.waitForAssistantText('hi from openrouter');

    const captured = await waitForNextLlmRequest(before);
    const body = captured.body as Record<string, unknown>;
    // Inherited OpenAI request shape, with the OpenRouter model id.
    expect(body.model).toBe('anthropic/claude-mock');
    expect(body.stream).toBe(true);
    expect(captured.auth).toBe('Bearer mock-api-key');
    // The adapter assigns transforms/plugins/provider/reasoning from config.
    // The settings schema defaults transforms/plugins to [], which the factory
    // parses as empty arrays — so the keys serialize as [] rather than being
    // dropped. provider needs a non-empty order and reasoning needs effort or
    // summary, so both are absent by default.
    expect(body.transforms).toEqual([]);
    expect(body.plugins).toEqual([]);
    expect('provider' in body).toBe(false);
    expect('reasoning' in body).toBe(false);

    // buildRequest adds OpenRouter attribution headers (node lowercases them).
    const route = await getRouteCapture('/chat/completions');
    expect(route).not.toBeNull();
    expect(route!.headers['http-referer']).toBe('https://github.com/cinnamon-lake/tamari');
    expect(route!.headers['x-title']).toBe('tamari');
  });

  test('sends reasoning effort and summary from openrouter.* settings', async ({ page }) => {
    await setSetting(page, 'openrouter.reasoningEffort', 'high');
    await setSetting(page, 'openrouter.reasoningSummary', 'concise');

    const app = new App(page);
    const charName = `OR Reasoning ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond: reasoning ok', { expectReply: true });
    await app.waitForAssistantText('reasoning ok');

    const captured = await waitForNextLlmRequest(before);
    const body = captured.body as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'concise' });
  });

  test('sends provider routing order and allow_fallbacks', async ({ page }) => {
    // buildBackendSettings maps the config's openrouterProvider field to
    // settings['openrouter.providerOrder'] = [provider]; allowFallbacks is a
    // global openrouter.* setting the factory parses as a boolean.
    await patchActiveBackendConfig(page, { openrouterProvider: 'Anthropic' });
    await setSetting(page, 'openrouter.allowFallbacks', false);

    const app = new App(page);
    const charName = `OR Routing ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond: routing ok', { expectReply: true });
    await app.waitForAssistantText('routing ok');

    const captured = await waitForNextLlmRequest(before);
    const body = captured.body as Record<string, unknown>;
    expect(body.provider).toEqual({ order: ['Anthropic'], allow_fallbacks: false });
  });

  test('injects Claude cache_control breakpoints for anthropic/claude* models', async ({ page }) => {
    // Prompt caching is per-backend config (providerParams.cacheMode/cacheDepth/cacheTTL).
    await patchActiveBackendConfig(page, {
      providerParams: { cacheMode: 'manual', cacheDepth: 0, cacheTTL: '1h' },
    });

    const app = new App(page);
    const charName = `OR Cache ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    const before = (await getLastLlmRequest()).count;
    // The depth-0 breakpoint converts the last user message to content parts,
    // so the mock's respond: selector no longer matches — the reply is the
    // mock's default text. expectReply only needs a non-empty bubble.
    await app.sendUserMessage('respond: cache test', { expectReply: true });

    const captured = await waitForNextLlmRequest(before);
    const body = captured.body as { messages: Array<{ role: string; content: unknown }> };

    // Every cache_control breakpoint carries the ephemeral type + configured TTL.
    const cachedParts: Array<{ cache_control?: unknown }> = [];
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content as Array<{ cache_control?: unknown }>) {
          if (part.cache_control) cachedParts.push(part);
        }
      }
    }
    // System prompt + depth-0 user breakpoint.
    expect(cachedParts.length).toBeGreaterThanOrEqual(2);
    for (const part of cachedParts) {
      expect(part.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    }

    // The system prompt is always a breakpoint for Claude-via-OpenRouter.
    const system = body.messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(Array.isArray(system!.content)).toBe(true);

    // Unlike the direct Claude adapter, the OpenRouter adapter does NOT send
    // anthropic-beta headers — caching is expressed purely via cache_control.
    const route = await getRouteCapture('/chat/completions');
    expect(route!.headers['anthropic-beta']).toBeUndefined();
    expect(route!.headers['http-referer']).toBe('https://github.com/cinnamon-lake/tamari');
  });

  test('sends transforms and plugins when configured', async ({ page }) => {
    await setSetting(page, 'openrouter.transforms', ['middle-out']);
    await setSetting(page, 'openrouter.plugins', [{ id: 'web' }]);

    const app = new App(page);
    const charName = `OR Transforms ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond: transforms ok', { expectReply: true });
    await app.waitForAssistantText('transforms ok');

    const captured = await waitForNextLlmRequest(before);
    const body = captured.body as Record<string, unknown>;
    expect(body.transforms).toEqual(['middle-out']);
    expect(body.plugins).toEqual([{ id: 'web' }]);
  });
});
