/**
 * MCP endpoint coverage (server/src/api/mcp.ts, mounted at /api/mcp behind
 * requireAuth — see MCP.md at the repo root).
 *
 * The surface is a read/test-only tool whitelist for external LLM agents:
 *   - gated on the `mcp.enabled` setting (404 when off, applies immediately),
 *   - authenticated with the app bearer token (TAMARI_SECRET) — 401 without it,
 *   - stateless MCP Streamable HTTP: POST only (GET/DELETE → 405), responses
 *     may arrive SSE-framed (`data: <json-rpc>` lines) or as bare JSON,
 *   - no mutation verbs: write-ish tools simply don't exist (unknown tool).
 *
 * Enabled per-test via setSetting over the WS bus, the same way the unit tests
 * flip the gate (server/src/api/mcp.test.ts). The read/test verbs run against
 * seeded data: a global regex rule (test_regex), the mock-wired active backend
 * config (test_backend live), and a freshly created character card
 * (test_session_* round-trip through the real generation path, backed by the
 * deterministic mock LLM).
 */
import { test, expect } from '../fixtures/base.js';
import type { APIRequestContext } from '@playwright/test';
import { login, authHeaders } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { setSetting, getActiveBackendConfigId } from '../helpers/settings.js';
import { App } from '../helpers/app.js';
import { uniqueName } from '../helpers/names.js';

const MCP_PATH = '/api/mcp';
const MCP_ACCEPT = 'application/json, text/event-stream';

/** The fixed read/test-only whitelist (MCP.md + server/src/api/mcp.test.ts). */
const TOOL_WHITELIST = [
  'read_generation',
  'test_backend',
  'test_backend_logic',
  'test_card',
  'test_custom_backend',
  'test_luatool',
  'test_regex',
  'test_session_end',
  'test_session_message',
  'test_session_start',
  'test_session_state',
].sort();

let rpcId = 0;

interface RpcReply {
  status: number;
  rpc: Record<string, unknown>;
}

/**
 * One stateless JSON-RPC POST. Parses the reply whether it arrives as bare
 * JSON or one SSE frame (both are observed, see mcp.test.ts / MCP.md).
 */
async function mcpRpc(
  request: APIRequestContext,
  method: string,
  params?: Record<string, unknown>,
  opts?: { auth?: boolean },
): Promise<RpcReply> {
  const res = await request.post(MCP_PATH, {
    headers: { Accept: MCP_ACCEPT, ...(opts?.auth === false ? {} : authHeaders()) },
    data: { jsonrpc: '2.0', id: ++rpcId, method, ...(params !== undefined ? { params } : {}) },
  });
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  const rpc = JSON.parse(dataLine ? dataLine.slice(5).trim() : text) as Record<string, unknown>;
  return { status: res.status(), rpc };
}

async function mcpTool(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const { status, rpc } = await mcpRpc(request, 'tools/call', { name, arguments: args });
  expect(status).toBe(200);
  expect(rpc.error, `tools/call ${name} returned a JSON-RPC error: ${JSON.stringify(rpc.error)}`).toBeUndefined();
  const result = rpc.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  expect(Array.isArray(result.content)).toBe(true);
  return result;
}

/** Tool results are MCP text content; JSON payloads are stringified into it. */
function toolJson<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0]!.text) as T;
}

test.describe('MCP endpoint (/api/mcp)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await setSetting(page, 'mcp.enabled', true);
  });

  test.afterEach(async ({ page }) => {
    // Persisted on the shared e2e server — close the gate and undo any
    // seeded state or later specs inherit it.
    await setSetting(page, 'mcp.enabled', false);
    await setSetting(page, 'regexRules', []);
    await resetBackendConfig(page);
  });

  test('404s when the mcp.enabled gate is off', async ({ page, request }) => {
    await setSetting(page, 'mcp.enabled', false);
    const res = await request.post(MCP_PATH, {
      headers: { Accept: MCP_ACCEPT, ...authHeaders() },
      data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' },
    });
    expect(res.status()).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/unavailable/);
  });

  test('rejects requests without the app bearer token', async ({ request }) => {
    const { status } = await mcpRpc(request, 'tools/list', undefined, { auth: false });
    expect(status).toBe(401);
  });

  test('rejects GET and DELETE (stateless, POST only)', async ({ request }) => {
    const get = await request.get(MCP_PATH, { headers: { Accept: MCP_ACCEPT, ...authHeaders() } });
    expect(get.status()).toBe(405);
    const del = await request.delete(MCP_PATH, { headers: { Accept: MCP_ACCEPT, ...authHeaders() } });
    expect(del.status()).toBe(405);
    const body = (await del.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/Method not allowed/);
  });

  test('initialize + tools/list round-trip exposes exactly the read/test whitelist', async ({ request }) => {
    const init = await mcpRpc(request, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'e2e-spec', version: '0.0.0' },
    });
    expect(init.status).toBe(200);
    const initResult = init.rpc.result as { serverInfo?: { name?: string }; protocolVersion?: string };
    expect(initResult.serverInfo?.name).toBe('tamari');
    expect(typeof initResult.protocolVersion).toBe('string');

    const list = await mcpRpc(request, 'tools/list', {});
    expect(list.status).toBe(200);
    const tools = (list.rpc.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    expect(tools).toEqual(TOOL_WHITELIST);
    // No mutation verbs (MCP.md safety property): the exact whitelist match
    // above is the guarantee; this makes the intent explicit.
    for (const name of tools) {
      expect(name).not.toMatch(/write|edit|delete|update|create|rm/i);
    }
  });

  test('a write-verb tools/call is an unknown tool, not executed', async ({ request }) => {
    const { status, rpc } = await mcpRpc(request, 'tools/call', {
      name: 'write',
      arguments: { path: '/characters/x/description', content: 'hax' },
    });
    expect(status).toBe(200);
    // JSON-RPC error or a tool-level error result — either way, not executed.
    expect(JSON.stringify(rpc.error ?? rpc.result)).toMatch(/not found|unknown|No such tool/i);
  });

  test('test_regex previews a seeded global rule against sample text', async ({ page, request }) => {
    await setSetting(page, 'regexRules', [
      {
        id: 'r-mcp-cat-dog',
        name: 'cat to dog',
        findRegex: '/cat/',
        replaceString: 'dog',
        disabled: false,
        userInput: true,
        aiOutput: true,
        prompt: true,
        display: true,
      },
    ]);

    const result = await mcpTool(request, 'test_regex', { text: 'I have a cat' });
    expect(result.isError).toBeUndefined();
    const parsed = toolJson<{ role: string; ruleCount: number; prompt: string; display: string }>(result);
    expect(parsed.ruleCount).toBe(1);
    expect(parsed.prompt).toBe('I have a dog');
    expect(parsed.display).toBe('I have a dog');
  });

  test('test_backend live runs a real request against the mock-wired config', async ({ page, request }) => {
    await configureMockBackend(page);

    const result = await mcpTool(request, 'test_backend', { mode: 'live', prompt: 'respond: live ok' });
    expect(result.isError).toBeUndefined();
    const parsed = toolJson<{ ok: boolean; text: string; finishReason: string }>(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toBe('live ok');
    expect(parsed.finishReason).toBe('stop');
  });

  test('test_session round-trip runs the real generation path in memory', async ({ page, request }) => {
    await configureMockBackend(page);
    const backendConfigId = await getActiveBackendConfigId(page);
    const app = new App(page);
    const characterId = await app.createCharacter({
      name: uniqueName('MCP Char'),
      description: 'A card for the MCP e2e session test.',
      firstMes: 'MCP greeting.',
    });
    expect(characterId).not.toBe('');

    // start: materialized greeting (static firstMes — no LLM call).
    const start = await mcpTool(request, 'test_session_start', { characterId, backendConfigId });
    expect(start.isError).toBeUndefined();
    const started = toolJson<{ sessionId: string; greeting?: string }>(start);
    expect(typeof started.sessionId).toBe('string');
    expect(started.sessionId.length).toBeGreaterThan(0);
    if (started.greeting !== undefined) expect(started.greeting).toContain('MCP greeting');

    // message: one user turn + one real (mock-backed) generation.
    const message = await mcpTool(request, 'test_session_message', {
      sessionId: started.sessionId,
      content: 'respond: mcp reply',
    });
    expect(message.isError).toBeUndefined();
    const replied = toolJson<{ reply: string; generationId: string; finishReason: string }>(message);
    expect(replied.reply).toBe('mcp reply');
    expect(typeof replied.generationId).toBe('string');
    expect(replied.finishReason).toBe('stop');

    // state: the in-memory chain holds both turns and the generation record.
    const state = await mcpTool(request, 'test_session_state', { sessionId: started.sessionId });
    expect(state.isError).toBeUndefined();
    const inspected = toolJson<{ messages?: unknown[]; generations?: unknown[] }>(state);
    expect(JSON.stringify(inspected)).toContain('mcp reply');
    expect((inspected.generations ?? []).length).toBeGreaterThanOrEqual(1);

    // end: drops the session; a later state call flags the unknown session.
    const end = await mcpTool(request, 'test_session_end', { sessionId: started.sessionId });
    expect(end.isError).toBeUndefined();

    const gone = await mcpTool(request, 'test_session_state', { sessionId: started.sessionId });
    expect(gone.isError).toBe(true);
  });

  test('read_generation flags an unknown generation id as an error result', async ({ request }) => {
    const result = await mcpTool(request, 'read_generation', { generationId: 'no-such-generation', file: 'meta.json' });
    // Failures are flagged isError:true via the "Error: " text-prefix
    // heuristic documented in MCP.md.
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^Error: /);
  });
});
