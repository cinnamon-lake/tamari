/**
 * Tests for the read/test-only MCP router (api/mcp.ts).
 *
 * Drives the JSON-RPC endpoint over supertest. The router itself is tested
 * with fakes for the workbench template / CardTestService; auth is tested
 * with the real requireAuth middleware and a stub AuthService.
 */

import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMcpRouter, type McpRouterDeps } from './mcp.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { AuthService } from '../services/AuthService.js';

function makeDeps(overrides?: { enabled?: boolean; workbenchExecute?: McpRouterDeps['workbench']['execute'] }) {
  const workbenchExecute =
    overrides?.workbenchExecute ??
    (vi.fn(async (tool: string, args: Record<string, unknown>) => ({
      content: `workbench:${tool}:${JSON.stringify(args)}`,
    })) as unknown as McpRouterDeps['workbench']['execute']);
  const cardTestRun = vi.fn(async (args: Record<string, unknown>) => ({ content: JSON.stringify({ ok: true, args }) }));
  const deps: McpRouterDeps = {
    workbench: { execute: workbenchExecute } as unknown as McpRouterDeps['workbench'],
    cardTest: { run: cardTestRun } as unknown as McpRouterDeps['cardTest'],
    settings: { get: async (key?: string) => (key === 'mcp.enabled' ? (overrides?.enabled ?? true) : undefined) } as unknown as McpRouterDeps['settings'],
  };
  return { deps, workbenchExecute, cardTestRun };
}

function createApp(deps: McpRouterDeps, opts?: { withAuth?: boolean }) {
  const app = express();
  app.use(express.json());
  if (opts?.withAuth === true) {
    const auth = { validate: (token?: string) => token === 'secret-token' } as unknown as AuthService;
    app.use('/api', createAuthMiddleware(auth));
    app.use('/api/mcp', createMcpRouter(deps));
  } else {
    app.use('/mcp', createMcpRouter(deps));
  }
  return app;
}

const MCP_PATH = (withAuth?: boolean) => (withAuth === true ? '/api/mcp/' : '/mcp/');
const ACCEPT = 'application/json, text/event-stream';

/** Parse a JSON-RPC response that may arrive as plain JSON or one SSE frame. */
function rpcResult(res: request.Response): Record<string, unknown> {
  const text = res.text;
  if (text.startsWith('event:')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(dataLine!.slice(5)) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function post(app: express.Express, body: unknown, withAuth?: boolean) {
  return request(app).post(MCP_PATH(withAuth)).set('Accept', ACCEPT).send(body as Record<string, unknown>);
}

describe('createMcpRouter', () => {
  it('404s everything when mcp.enabled is off', async () => {
    const { deps } = makeDeps({ enabled: false });
    const app = createApp(deps);
    const res = await post(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(404);
    expect(res.body.error).toMatch(/disabled/);
  });

  it('requires auth when mounted behind requireAuth', async () => {
    const { deps } = makeDeps();
    const app = createApp(deps, { withAuth: true });
    await post(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, true).expect(401);
    await request(app)
      .post(MCP_PATH(true))
      .set('Accept', ACCEPT)
      .set('Authorization', 'Bearer secret-token')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);
  });

  it('lists exactly the read/test-only whitelist', async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    const res = await post(app, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }).expect(200);
    const rpc = rpcResult(res);
    const tools = (rpc.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      ['read_generation', 'test_backend', 'test_backend_logic', 'test_card', 'test_custom_backend', 'test_luatool', 'test_regex'].sort(),
    );
  });

  it('routes test_regex to the workbench run verb', async () => {
    const { deps, workbenchExecute } = makeDeps();
    const app = createApp(deps);
    const res = await post(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'test_regex', arguments: { text: 'hello', characterId: 'unpacked/x' } },
    }).expect(200);
    expect(workbenchExecute).toHaveBeenCalledWith('run', { verb: 'test_regex', args: { text: 'hello', characterId: 'unpacked/x' } });
    const rpc = rpcResult(res);
    const content = (rpc.result as { content: { text: string }[] }).content[0]!.text;
    expect(content).toContain('workbench:run:');
  });

  it('routes test_card to CardTestService', async () => {
    const { deps, cardTestRun } = makeDeps();
    const app = createApp(deps);
    const res = await post(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'test_card', arguments: { characterId: 'unpacked/x', turns: ['hi'] } },
    }).expect(200);
    expect(cardTestRun).toHaveBeenCalledWith({ characterId: 'unpacked/x', turns: ['hi'] });
    const rpc = rpcResult(res);
    expect((rpc.result as { content: { text: string }[] }).content[0]!.text).toContain('"ok":true');
  });

  it('routes read_generation to a workbench read of /generations/', async () => {
    const { deps, workbenchExecute } = makeDeps();
    const app = createApp(deps);
    await post(app, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'read_generation', arguments: { generationId: 'g1', file: 'prompt.json' } },
    }).expect(200);
    expect(workbenchExecute).toHaveBeenCalledWith('read', { path: '/generations/g1/prompt.json' });
  });

  it('has no mutation tools — a write call is an unknown tool', async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    const res = await post(app, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'write', arguments: { path: '/characters/x/description', content: 'hax' } },
    }).expect(200);
    const rpc = rpcResult(res);
    // JSON-RPC error or a tool-level error result — either way, not executed.
    const errText = JSON.stringify(rpc.error ?? rpc.result);
    expect(errText).toMatch(/not found|unknown|No such tool/i);
  });

  it('rejects GET and DELETE (stateless, POST only)', async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    await request(app).get('/mcp/').set('Accept', ACCEPT).expect(405);
    await request(app).delete('/mcp/').set('Accept', ACCEPT).expect(405);
  });
});
