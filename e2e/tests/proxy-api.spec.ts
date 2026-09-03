/**
 * Anthropic-like proxy API coverage (server/src/api/proxy.ts).
 *
 * Mounted at /v1 OUTSIDE /api — no requireAuth; the router gates on the
 * `proxyApi.enabled` setting (404 when off) and authenticates with its own
 * `proxyApi.apiKey` setting (x-api-key header or Bearer token), never the app
 * login token. Model ids are `${configUuid}-${configName}`.
 *
 * The proxy is deliberately NON-streaming (buffered JSON, see the file
 * header), so there is no SSE surface to cover; instead the happy path proves
 * the upstream round-trip end to end: the request goes through the real
 * adapter pipeline to the deterministic mock LLM (configureMockBackend),
 * verified via the mock's request capture (GET /last-request).
 *
 * The gate + key are flipped via setSetting over the WS bus. The boot-created
 * `proxyApi.apiKey` (main.ts) is overwritten with a known test key, and the
 * rotation test covers the flush flow the client's regenerate button uses
 * (SettingsModal sends settings.set 'proxyApi.apiKey' with a fresh key — the
 * old key dies immediately).
 */
import { test, expect } from '../fixtures/base.js';
import type { APIRequestContext, Page } from '@playwright/test';
import { login, authHeaders } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests } from '../helpers/llm.js';
import { setSetting, getActiveBackendConfigId } from '../helpers/settings.js';

const PROXY_KEY = 'e2e-proxy-api-key';

interface AnthropicError {
  type: 'error';
  error: { type: string; message: string };
}

interface ModelList {
  data: Array<{ type: string; id: string; display_name: string; created_at: string }>;
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

function keyHeader(key: string = PROXY_KEY): Record<string, string> {
  return { 'x-api-key': key };
}

/** The /v1/models id of the ACTIVE backend config (the one wired to the mock LLM). */
async function activeProxyModelId(page: Page, request: APIRequestContext): Promise<string> {
  const activeId = await getActiveBackendConfigId(page);
  const res = await request.get('/v1/models', { headers: keyHeader() });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as ModelList;
  const found = body.data.find((m) => m.id.startsWith(`${activeId}-`));
  expect(found, 'active backend config is listed as a proxy model').toBeDefined();
  return found!.id;
}

async function postMessage(request: APIRequestContext, body: unknown, key: string = PROXY_KEY) {
  return request.post('/v1/messages', { headers: keyHeader(key), data: body as Record<string, unknown> });
}

test.describe('Proxy API (/v1)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await setSetting(page, 'proxyApi.enabled', true);
    await setSetting(page, 'proxyApi.apiKey', PROXY_KEY);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // Persisted on the shared e2e server — close the gate and reset the
    // backend config or later specs inherit them.
    await setSetting(page, 'proxyApi.enabled', false);
    await resetBackendConfig(page);
  });

  test('404s both endpoints when the proxyApi.enabled gate is off', async ({ page, request }) => {
    await setSetting(page, 'proxyApi.enabled', false);

    const models = await request.get('/v1/models', { headers: keyHeader() });
    expect(models.status()).toBe(404);
    expect(((await models.json()) as AnthropicError).error.type).toBe('not_found_error');

    const messages = await postMessage(request, { model: 'whatever', messages: [{ role: 'user', content: 'hi' }] });
    expect(messages.status()).toBe(404);
    expect(((await messages.json()) as AnthropicError).error.type).toBe('not_found_error');
  });

  test('rejects missing, wrong, and login-token keys with an anthropic-style 401', async ({ request }) => {
    // No key at all.
    const noKey = await request.get('/v1/models');
    expect(noKey.status()).toBe(401);
    const noKeyBody = (await noKey.json()) as AnthropicError;
    expect(noKeyBody).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid or missing proxy API key' },
    });

    // Wrong key.
    const wrongKey = await request.get('/v1/models', { headers: keyHeader('not-the-key') });
    expect(wrongKey.status()).toBe(401);

    // The app login token is deliberately NOT accepted here (dedicated key).
    const loginToken = await request.post('/v1/messages', {
      headers: authHeaders(),
      data: { model: 'whatever', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(loginToken.status()).toBe(401);
    const bearerLogin = await request.get('/v1/models', { headers: authHeaders() });
    expect(bearerLogin.status()).toBe(401);
  });

  test('lists backend configs as anthropic-style models (x-api-key and Bearer)', async ({ page, request }) => {
    const activeId = await getActiveBackendConfigId(page);

    const res = await request.get('/v1/models', { headers: keyHeader() });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ModelList;
    expect(body.has_more).toBe(false);
    expect(body.data.length).toBeGreaterThan(0);
    const active = body.data.find((m) => m.id.startsWith(`${activeId}-`));
    expect(active).toBeDefined();
    expect(active!.type).toBe('model');
    expect(active!.display_name.length).toBeGreaterThan(0);
    expect(typeof active!.created_at).toBe('string');
    expect(body.first_id).toBe(body.data[0]!.id);
    expect(body.last_id).toBe(body.data[body.data.length - 1]!.id);

    // Bearer presentation of the same key is accepted too.
    const bearer = await request.get('/v1/models', { headers: { Authorization: `Bearer ${PROXY_KEY}` } });
    expect(bearer.ok()).toBe(true);
  });

  test('completes a message through the mock LLM and returns the anthropic message shape', async ({
    page,
    request,
  }) => {
    const model = await activeProxyModelId(page, request);

    const res = await postMessage(request, {
      model,
      system: 'You are terse.',
      // Deliberately dropped by the proxy — the backend config owns sampling.
      max_tokens: 5,
      temperature: 0.01,
      messages: [{ role: 'user', content: 'respond: proxied hello' }],
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'proxied hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    });
    expect(String(body.id)).toMatch(/^msg_/);
    const usage = body.usage as { input_tokens: number; output_tokens: number };
    expect(typeof usage.input_tokens).toBe('number');
    expect(typeof usage.output_tokens).toBe('number');

    // The round-trip really went through the config's adapter to the mock:
    // the captured /chat/completions body carries the translated system +
    // user messages (anthropic `system` field -> a system role message).
    const cap = await getLastLlmRequest();
    const capBody = cap.body as { model?: string; messages?: Array<{ role: string; content: string }> };
    expect(capBody.model).toBe('mock-model');
    expect(capBody.messages).toContainEqual({ role: 'system', content: 'You are terse.' });
    expect(capBody.messages).toContainEqual({ role: 'user', content: 'respond: proxied hello' });
  });

  test('maps a length finish to stop_reason max_tokens', async ({ page, request }) => {
    const model = await activeProxyModelId(page, request);

    const res = await postMessage(request, {
      model,
      messages: [{ role: 'user', content: 'length:cut off' }],
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { content: Array<{ text: string }>; stop_reason: string };
    expect(body.content[0]!.text).toBe('cut off');
    expect(body.stop_reason).toBe('max_tokens');
  });

  test('maps validation and unknown-model failures to anthropic error shapes', async ({ request }) => {
    // Schema violation (no messages).
    const badBody = await postMessage(request, { model: 'whatever' });
    expect(badBody.status()).toBe(400);
    expect(((await badBody.json()) as AnthropicError).error.type).toBe('invalid_request_error');

    // Model id that matches no config — 404 not_found_error (word-id or not).
    const badModel = await postMessage(request, {
      model: 'not-a-proxy-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(badModel.status()).toBe(404);
    const badModelBody = (await badModel.json()) as AnthropicError;
    expect(badModelBody.error.type).toBe('not_found_error');
    expect(badModelBody.error.message).toContain('was not found');

    // Well-formed word-id-shaped prefix, but no such backend config.
    const ghost = await postMessage(request, {
      model: 'no-such-config-exists-here-Ghost',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(ghost.status()).toBe(404);
    expect(((await ghost.json()) as AnthropicError).error.type).toBe('not_found_error');
  });

  test('maps an upstream failure to a 500 api_error', async ({ page, request }) => {
    // Point the active config at a dead port: the adapter reports the failure
    // and the proxy surfaces it as an anthropic-style api_error.
    await patchActiveBackendConfig(page, { apiUrl: 'http://127.0.0.1:9' });
    const model = await activeProxyModelId(page, request);

    const res = await postMessage(request, {
      model,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status()).toBe(500);
    const body = (await res.json()) as AnthropicError;
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('api_error');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  test('rotating the stored key flushes the old one immediately', async ({ page, request }) => {
    const rotated = 'e2e-proxy-api-key-rotated';
    await setSetting(page, 'proxyApi.apiKey', rotated);

    const oldKey = await request.get('/v1/models', { headers: keyHeader(PROXY_KEY) });
    expect(oldKey.status()).toBe(401);

    const newKey = await request.get('/v1/models', { headers: keyHeader(rotated) });
    expect(newKey.ok()).toBe(true);

    // Leave a key nobody knows behind (the gate is closed in afterEach too).
    await setSetting(page, 'proxyApi.apiKey', PROXY_KEY);
  });
});
