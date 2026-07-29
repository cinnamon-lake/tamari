/**
 * Claude backend adapter coverage (server/src/backends/ClaudeBackendAdapter.ts).
 *
 * The mock LLM speaks the Anthropic Messages dialect at POST /messages
 * (event:/data: SSE with content blocks), so these specs drive real
 * generations through the adapter and assert its request shaping end to end:
 *   - system-prompt extraction to the top-level `system` param (no system
 *     role inside `messages`), stream:true, numeric max_tokens, and the
 *     x-api-key / anthropic-version headers,
 *   - stop strings mapped from `stop` to `stop_sequences`,
 *   - thinking blocks streamed (thinking_delta + signature_delta) and the
 *     signed thinking block re-sent on the next turn,
 *   - tool conversion (input_schema) and the tool_use / tool_result interleave
 *     across the tool loop,
 *   - cache_control breakpoints + prompt-caching beta headers in manual mode,
 *   - max_tokens stop_reason mapped to a 'length' finish,
 *   - listModels parsing the Anthropic model-list shape,
 *   - image attachments converted to base64 image blocks.
 *
 * Assertions are made against the mock's generic capture
 * (GET /last-request?route=/messages), which records the LAST request per
 * route with body + headers.
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { setSetting } from '../helpers/settings.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { App } from '../helpers/app.js';

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';

/** The e2e webServer pins TAMARI_SECRET to this value (playwright.config.ts). */
const AUTH = { Authorization: 'Bearer e2e-test-secret' };

/** Minimal 1x1 transparent PNG (same fixture as attachments.spec.ts). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

type CapturedMessage = { role: string; content: unknown };

/** Collect every content part of `type` across all captured messages. */
function collectParts(messages: CapturedMessage[], type: string): Array<{ role: string; part: Record<string, unknown> }> {
  const out: Array<{ role: string; part: Record<string, unknown> }> = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Array<Record<string, unknown> | null>) {
      if (part && part['type'] === type) out.push({ role: m.role, part });
    }
  }
  return out;
}

/** Settings this spec mutates, with their schema defaults — restored in afterEach. */
const TOUCHED_SETTINGS: Array<[string, unknown]> = [
  ['customStoppingStrings', []],
  ['claudeCacheMode', 'off'],
  ['claudeCacheDepth', 0],
  ['claudeCacheTTL', null],
  ['reasoningAddToPrompts', false],
];

test.describe('Claude backend adapter', () => {
  test.describe.configure({ mode: 'serial' });

  let toolsetId: string | undefined;

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    // Keep the mock URL/key, switch the provider + model to Claude.
    await patchActiveBackendConfig(page, {
      backendProvider: 'claude',
      model: 'claude-mock-1',
    });
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    for (const [key, defaultValue] of TOUCHED_SETTINGS) {
      await setSetting(page, key, defaultValue);
    }
    if (toolsetId) {
      await deleteToolset(page, toolsetId);
      toolsetId = undefined;
    }
    await resetBackendConfig(page);
  });

  test('streams a basic reply and sends an Anthropic-shaped request', async ({ page }) => {
    await setSetting(page, 'customStoppingStrings', ['CLAUDESTOP']);

    const app = new App(page);
    const charName = `Claude Basic ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // The mock honors stop_sequences: the reply is cut at the stop string.
    await app.sendUserMessage('respond: hello claude CLAUDESTOP world', { expectReply: true });
    await app.waitForAssistantText('hello claude');
    expect(await app.lastAssistantText()).not.toContain('world');

    const cap = await waitForRouteCapture('/messages');
    const body = cap.body;

    // Core Anthropic request shape from buildRequest.
    expect(body['model']).toBe('claude-mock-1');
    expect(body['stream']).toBe(true);
    expect(typeof body['max_tokens']).toBe('number');
    expect(body['max_tokens'] as number).toBeGreaterThan(0);

    // System prompts are extracted to the top-level `system` param; no
    // system role survives inside `messages` (convertMessages skips them).
    const system = body['system'];
    expect(typeof system === 'string' || Array.isArray(system)).toBe(true);
    const messages = body['messages'] as CapturedMessage[];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.role !== 'system')).toBe(true);

    // Custom stop strings arrive as `stop` in prompt params and the adapter
    // renames the key to stop_sequences.
    expect(body['stop']).toBeUndefined();
    expect(body['stop_sequences']).toContain('CLAUDESTOP');

    // Auth + version headers (node lowercases header names on capture).
    expect(cap.headers['x-api-key']).toBe('mock-api-key');
    expect(cap.headers['anthropic-version']).toBe('2023-06-01');
  });

  test('streams a thinking block and re-sends it signed on the next turn', async ({ page }) => {
    // Keep reasoning blocks in the prompt so the second turn exercises the
    // adapter's reasoning-part conversion (signature → thinking block).
    await setSetting(page, 'reasoningAddToPrompts', true);

    const app = new App(page);
    const charName = `Claude Think ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    await app.sendUserMessage('think: step by step', { expectReply: true });
    const bubble = app.lastBubble('assistant');
    await expect(bubble).toContainText('Here is my final answer.', { timeout: 10000 });
    const reasoningBlock = bubble.locator('.reasoning-block');
    await expect(reasoningBlock).toBeVisible({ timeout: 10000 });
    await expect(reasoningBlock).toContainText('I am thinking through this carefully.');

    // Second turn: the prior reasoning is re-sent as a signed thinking block.
    await app.sendUserMessage('respond: after thinking', { expectReply: true });
    await app.waitForAssistantText('after thinking');

    const cap = await waitForRouteCapture('/messages');
    const messages = cap.body['messages'] as CapturedMessage[];
    const thinkingBlocks = collectParts(messages, 'thinking');
    // GenerationService attached the streamed signature_delta to the stored
    // reasoning part; convertParts maps a signed reasoning part to a Claude
    // thinking block (an unsigned one would be inlined as plain text).
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]!.role).toBe('assistant');
    expect(thinkingBlocks[0]!.part).toEqual({
      type: 'thinking',
      thinking: 'I am thinking through this carefully.',
      signature: 'mock-signature',
    });
  });

  test('converts tools and interleaves tool_use/tool_result across the loop', async ({ page }) => {
    toolsetId = await enableBuiltinToolset(page, 'lua_dice');

    const app = new App(page);
    const charName = `Claude Tools ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // Round 1: mock emits a tool_use block (input_json_delta). The app executes
    // roll_dice and sends round 2 with the result; the mock then answers plain text.
    await app.sendUserMessage('tool:roll_dice{"sides":6}', { expectReply: true });

    const bubble = app.lastBubble('assistant');
    await expect(bubble.locator('.dice-result')).toBeVisible({ timeout: 10000 });
    expect(await app.lastAssistantText()).toContain('deterministic mock response');

    // This capture is round 2 — it carries the tools array again plus the
    // interleaved tool_use / tool_result history.
    const cap = await waitForRouteCapture('/messages');
    const body = cap.body;

    // convertTools: OpenAI-shaped definitions become {name, description, input_schema}.
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    const dice = tools.find((t) => t['name'] === 'roll_dice');
    expect(dice).toBeDefined();
    expect(dice!['input_schema']).toMatchObject({ type: 'object' });
    expect('function' in dice!).toBe(false);

    // convertMessages: an internal assistant message holding [tool_use,
    // tool_result] parts is split into an assistant turn (tool_use) followed
    // by a user turn (tool_result).
    const messages = body['messages'] as CapturedMessage[];
    const toolUses = collectParts(messages, 'tool_use');
    const toolResults = collectParts(messages, 'tool_result');
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]!.role).toBe('assistant');
    expect(toolUses[0]!.part['name']).toBe('roll_dice');
    expect(toolUses[0]!.part['input']).toEqual({ sides: 6 });
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.role).toBe('user');
    expect(toolResults[0]!.part['tool_use_id']).toBe(toolUses[0]!.part['id']);
    expect(toolResults[0]!.part['content']).toContain('Rolled 1d6');
  });

  test('injects cache_control breakpoints and prompt-caching beta headers', async ({ page }) => {
    await setSetting(page, 'claudeCacheMode', 'manual');
    await setSetting(page, 'claudeCacheDepth', 1);
    await setSetting(page, 'claudeCacheTTL', '1h');

    const app = new App(page);
    const charName = `Claude Cache ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: 'A cacheable greeting.' });

    // The depth-0 user message keeps its plain-string content, so the mock's
    // respond: selector still matches.
    await app.sendUserMessage('respond: cache test', { expectReply: true });
    await app.waitForAssistantText('cache test');

    const cap = await waitForRouteCapture('/messages');
    const body = cap.body;

    // With caching enabled the system prompt becomes a text-block array
    // carrying the ephemeral breakpoint + configured TTL.
    const system = body['system'] as Array<Record<string, unknown>>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0]!['type']).toBe('text');
    expect(system[0]!['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });

    // Manual depth 1: injectCacheControls walks role transitions from the end
    // and marks depth 1 (and depth + 2, unreachable here). History is
    // [assistant firstMes, user turn], so the breakpoint lands on the
    // firstMes assistant message.
    const messages = body['messages'] as CapturedMessage[];
    const cachedParts: Array<{ role: string; part: Record<string, unknown> }> = [];
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as Array<Record<string, unknown>>) {
        if (part['cache_control']) cachedParts.push({ role: m.role, part });
      }
    }
    expect(cachedParts).toHaveLength(1);
    expect(cachedParts[0]!.role).toBe('assistant');
    expect(cachedParts[0]!.part['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });

    // buildRequest adds both caching beta headers whenever caching is enabled.
    const beta = cap.headers['anthropic-beta'];
    expect(beta).toContain('prompt-caching-2024-07-31');
    expect(beta).toContain('extended-cache-ttl-2025-04-11');
  });

  test('maps a max_tokens stop to a length finish', async ({ page }) => {
    const app = new App(page);
    const charName = `Claude Length ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // The mock reports stop_reason max_tokens; canonicalFinishReason maps it
    // to 'length'. The partial text still renders; the client surfaces no
    // finish-reason badge — the affordance is the per-message Continue action.
    await app.sendUserMessage('length:truncated reply', { expectReply: true });
    await app.waitForAssistantText('truncated reply');

    const bubble = app.lastBubble('assistant');
    await expect(bubble.locator('button[title="Continue"]')).toHaveCount(1);
  });

  test('lists models via the Anthropic model-list shape', async ({ request }) => {
    // The mock returns the Claude shape at GET /models when x-api-key is sent
    // (the adapter's listModels authenticates that way, unlike OpenAI).
    const res = await request.get('/api/models', { headers: AUTH });
    expect(res.ok()).toBe(true);
    const data = (await res.json()) as { items: Array<{ id: string; name: string; contextLength?: number }> };
    const mock = data.items.find((m) => m.id === 'mock-claude');
    expect(mock).toBeDefined();
    expect(mock!.name).toBe('Mock Claude');
    expect(mock!.contextLength).toBe(200000);
  });

  test('converts an uploaded image to a base64 image block', async ({ page }) => {
    const app = new App(page);
    const charName = `Claude Image ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // Upload a PNG via the hidden file input in the message input area.
    // supportsImages defaults to true, so the renderer emits an image part.
    const fileInput = page.locator('.message-input-area .hidden-file-input');
    await fileInput.setInputFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect(page.locator('.attachment-previews .attachment-preview')).toBeVisible({ timeout: 5000 });

    await app.sendUserMessage('Look at this image', { expectReply: true });

    // convertParts: local attachment URLs are resolved to data URLs and
    // re-encoded as Anthropic base64 image sources.
    const cap = await waitForRouteCapture('/messages');
    const messages = cap.body['messages'] as CapturedMessage[];
    const imageParts = collectParts(messages, 'image');
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]!.role).toBe('user');
    expect(imageParts[0]!.part['source']).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: PNG_BASE64,
    });
  });
});
