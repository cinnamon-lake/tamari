/**
 * MCP (Model Context Protocol) endpoint — the read/test-only tool surface for
 * external LLM agents (kimi code / claude code style) developing unpacked
 * cards on disk.
 *
 * Deliberately read/test-only: agents WRITE card files with their own
 * filesystem tools; this endpoint exposes nothing that mutates server state
 * (no write/edit/rm, no non-test run verbs). Whitelist:
 *   - test_card            headless chat simulation (CardTestService)
 *   - test_backend_logic   dry-run a card's backend_logic.lua
 *   - test_regex           preview merged regex rules against sample text
 *   - test_luatool         run a Lua tool (stored template or ad-hoc code)
 *   - test_custom_backend  dry-run a custom-backend script
 *   - test_backend         dry/live-test a backend config
 *   - read_generation      read /generations/<id>/{meta.json,error.txt,prompt.json} debug traces
 *
 * Transport: MCP Streamable HTTP, stateless (one McpServer+transport per POST).
 * Auth: the router is mounted under /api behind the existing bearer
 * requireAuth (TAMARI_SECRET). Gated on the `mcp.enabled` setting — 404 when off.
 */

import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { WorkbenchTemplate } from '../services/templates/workbench/WorkbenchTemplate.js';
import type { CardTestService } from '../services/CardTestService.js';
import type { ToolExecuteResult } from '../services/ToolTemplate.js';

export interface McpRouterDeps {
  workbench: WorkbenchTemplate;
  cardTest: CardTestService;
  settings: ISettingsRepository;
}

/** Normalize a ToolExecuteResult into MCP text content. */
function textResult(result: ToolExecuteResult): { content: { type: 'text'; text: string }[] } {
  const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  return { content: [{ type: 'text', text }] };
}

function buildMcpServer(deps: McpRouterDeps): McpServer {
  const server = new McpServer({ name: 'tamari', version: '2.0.0-alpha.0' });

  const runVerb = (verb: string) => async (args: Record<string, unknown>) =>
    textResult(await deps.workbench.execute('run', { verb, args }));

  server.registerTool(
    'test_card',
    {
      description:
        'Headless chat simulation for a character card (DB id like unpacked/<slug>, or folderPath of an unpacked card folder). ' +
        'Creates a temporary chat, sends each scripted user turn against the ACTIVE backend config, deletes the chat unless keepChat. ' +
        'Returns the transcript + generation ids; full prompts are then readable via read_generation (file prompt.json).',
      inputSchema: {
        characterId: z.string().optional().describe('Card id (unpacked cards: unpacked/<slug>).'),
        folderPath: z.string().optional().describe('Unpacked card folder (absolute, or relative to <dataDir>/unpacked-cards). Alternative to characterId.'),
        turns: z.array(z.string().min(1)).min(1).max(20).describe('Scripted user messages, one per turn.'),
        keepChat: z.boolean().optional(),
        timeoutMs: z.number().int().min(1000).max(600000).optional(),
      },
    },
    async (args) => textResult(await deps.cardTest.run(args)),
  );

  server.registerTool(
    'test_backend_logic',
    {
      description: "Dry-run a card's backend_logic.lua (main.lua + required modules) against a recording delegate — no real backend calls.",
      inputSchema: {
        characterId: z.string(),
        input: z.string(),
        luaSource: z.string().optional(),
        state: z.unknown().optional(),
        delegateResponse: z.unknown().optional(),
      },
    },
    runVerb('test_backend_logic'),
  );

  server.registerTool(
    'test_regex',
    {
      description: 'Preview merged regex rules (global + character-scoped) against sample text.',
      inputSchema: {
        characterId: z.string().optional(),
        text: z.string(),
        role: z.string().optional(),
      },
    },
    runVerb('test_regex'),
  );

  server.registerTool(
    'test_luatool',
    {
      description: 'Run a tool from a Lua tool template (stored id or ad-hoc code).',
      inputSchema: {
        id: z.string().optional(),
        code: z.string().optional(),
        sandbox: z.boolean().optional(),
        toolName: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      },
    },
    runVerb('test_luatool'),
  );

  server.registerTool(
    'test_custom_backend',
    {
      description: 'Dry-run a custom-backend script against a recording delegate.',
      inputSchema: {
        id: z.string().optional(),
        luaSource: z.string().optional(),
        input: z.string(),
        state: z.unknown().optional(),
        delegateResponse: z.unknown().optional(),
      },
    },
    runVerb('test_custom_backend'),
  );

  server.registerTool(
    'test_backend',
    {
      description: 'Dry-run or live-test a backend config (configId defaults to the active backend; patch applies in memory only).',
      inputSchema: {
        configId: z.string().optional(),
        patch: z.record(z.string(), z.unknown()).optional(),
        prompt: z.string().optional(),
        mode: z.enum(['dry', 'live']).optional(),
      },
    },
    runVerb('test_backend'),
  );

  server.registerTool(
    'read_generation',
    {
      description:
        'Read a generation debug trace file (/generations/<id>/<file>): meta.json (full record), error.txt (rendered error chain), ' +
        'prompt.json (captured prompt — present when debugPrompts was on, e.g. during test_card).',
      inputSchema: {
        generationId: z.string(),
        file: z.enum(['meta.json', 'error.txt', 'prompt.json']),
      },
    },
    async (args) =>
      textResult(await deps.workbench.execute('read', { path: `/generations/${args.generationId}/${args.file}` })),
  );

  return server;
}

export function createMcpRouter(deps: McpRouterDeps): Router {
  const router = Router();

  // Feature gate — the endpoint does not exist unless mcp.enabled is on.
  router.use((_req, res, next) => {
    deps.settings
      .get('mcp.enabled')
      .then((enabled) => {
        if (enabled === true) next();
        else res.status(404).json({ error: 'MCP server is disabled (set mcp.enabled to true)' });
      })
      .catch(next);
  });

  router.post('/', (req, res, next) => {
    (async () => {
      const server = buildMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    })().catch(next);
  });

  // Stateless server: no SSE stream, no session termination.
  const methodNotAllowed = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed — stateless MCP server, POST only' }, id: null });
  router.get('/', methodNotAllowed);
  router.delete('/', methodNotAllowed);

  return router;
}
